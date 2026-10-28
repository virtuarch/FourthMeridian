/**
 * lib/crypto/sol-history-resumable.test.ts
 *
 * The resumable Solana backfill against a deterministic in-memory chain: no
 * network, no database. Every scenario ends by comparing the stored rows with
 * the chain's TRUE end-of-day balances, day by day.
 *
 *   npx tsx lib/crypto/sol-history-resumable.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  runSolHistoryBackfill, buildRpcCall, CheckpointConflictError, SolTransportError,
  type SolBackfillStore, type SolBackfillCommit, type SolRpcCall,
} from "@/lib/crypto/sol-history-backfill";
import {
  parseCheckpoint, backfillStatus, dailyClosings, extendBackward, MAX_CONSECUTIVE_FAILURES, isSolBackfillCursor,
  decidePromotion, emptyCheckpoint,
  type SolTxForProof,
} from "@/lib/crypto/sol-history-backfill.core";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const OWNER = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ACCOUNT = "acct_sol_fixture";
const DAY = 86_400;

// ── A deterministic chain ────────────────────────────────────────────────────

interface FixtureTx { signature: string; slot: number; blockTime: number; pre: number; post: number; view: SolTxForProof }

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** N transactions, oldest first, ~perDay per day ending on `endISO`. */
function makeChain(n: number, opts: { seed?: number; perDay?: number; endISO?: string; startLamports?: number; sameSlotPairs?: boolean } = {}): FixtureTx[] {
  const rnd = prng(opts.seed ?? 7);
  const perDay = opts.perDay ?? 20;
  const end = Date.parse(`${opts.endISO ?? "2026-10-27"}T12:00:00Z`) / 1000;
  const start = end - Math.ceil(n / perDay) * DAY;
  let bal = opts.startLamports ?? 0;
  const out: FixtureTx[] = [];
  for (let i = 0; i < n; i++) {
    const pre = bal;
    // Mostly receipts early, mixed later; never below zero; integer lamports.
    const up = rnd() < 0.6 || bal < 50_000_000;
    const amt = Math.floor(rnd() * 2_000_000_000) + 5000;
    bal = up ? bal + amt : Math.max(0, bal - Math.min(bal, amt));
    const failedTx = rnd() < 0.03;
    if (failedTx) bal = Math.max(0, pre - 5000); // a failed tx still pays its fee
    // sameSlotPairs: transactions 2k and 2k+1 share a slot (and so a blockTime).
    const k = opts.sameSlotPairs ? i - (i % 2) : i;
    const blockTime = Math.floor(start + (k / n) * (end - start));
    const slot = 100_000_000 + k * 3;
    const viaLookupTable = rnd() < 0.25;
    const signature = `sig${String(i).padStart(7, "0")}`;
    const view: SolTxForProof = viaLookupTable
      ? { slot, blockTime, transaction: { message: { accountKeys: [OTHER] } },
          meta: { preBalances: [10, pre], postBalances: [10, bal], loadedAddresses: { writable: [OWNER], readonly: [] } } }
      : { slot, blockTime, transaction: { message: { accountKeys: [OWNER, OTHER] } },
          meta: { preBalances: [pre, 10], postBalances: [bal, 10] } };
    out.push({ signature, slot, blockTime, pre, post: bal, view });
  }
  return out;
}

/** End-of-day truth for every day from the first transaction to `toISO`. */
function truth(chain: readonly FixtureTx[], toISO: string): Map<string, number> {
  const m = new Map<string, number>();
  if (chain.length === 0) return m;
  let i = 0;
  let last: FixtureTx | null = null;
  for (let d = new Date(chain[0].blockTime * 1000).toISOString().slice(0, 10); d <= toISO;
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    while (i < chain.length && new Date(chain[i].blockTime * 1000).toISOString().slice(0, 10) <= d) { last = chain[i]; i++; }
    if (last) m.set(d, last.post / 1e9);
  }
  return m;
}

interface RpcOpts {
  /** Signatures hidden from the index (their balance change still happens). */
  hidden?: Set<string>;
  /** Repeat the last row of each page at the start of the next (duplicate delivery). */
  duplicatePages?: boolean;
  /** Throw this error on the Nth getTransaction (1-based), once. */
  failAt?: { n: number; error: Error };
  /** Throttle every getTransaction from the Nth on (1-based). */
  throttleFrom?: number;
  /** Deliver transactions that share a slot in REVERSED order (index order within a slot is undocumented). */
  reverseSameSlot?: boolean;
}

function rpc(chain: () => readonly FixtureTx[], clock: { t: number }, o: RpcOpts = {}) {
  const counts = { sig: 0, tx: 0 };
  // Indexed per chain snapshot (the head test appends to the chain).
  let cached: { src: readonly FixtureTx[]; newestFirst: FixtureTx[]; pos: Map<string, number>; bySig: Map<string, FixtureTx> } | null = null;
  const index = () => {
    const src = chain();
    if (cached?.src !== src) {
      let newestFirst = src.filter((t) => !o.hidden?.has(t.signature)).reverse();
      if (o.reverseSameSlot) {
        const out: FixtureTx[] = [];
        for (let i = 0; i < newestFirst.length; ) {
          let j = i + 1;
          while (j < newestFirst.length && newestFirst[j].slot === newestFirst[i].slot) j++;
          out.push(...newestFirst.slice(i, j).reverse());
          i = j;
        }
        newestFirst = out;
      }
      cached = { src, newestFirst, pos: new Map(newestFirst.map((t, i) => [t.signature, i])), bySig: new Map(src.map((t) => [t.signature, t])) };
    }
    return cached;
  };
  const call: SolRpcCall = async (method, params) => {
    clock.t += 1; // every call costs one "ms" of budget
    const { newestFirst, pos, bySig } = index();
    if (method === "getSignaturesForAddress") {
      counts.sig++;
      const p = params[1] as { before?: string; until?: string; limit: number };
      let start = 0;
      if (p.before) start = (pos.get(p.before) ?? -1) + 1;
      const rows = [];
      if (o.duplicatePages && p.before) { const b = newestFirst[start - 1]; if (b) rows.push(b); }
      for (let i = start; i < newestFirst.length && rows.length < p.limit; i++) {
        if (p.until && newestFirst[i].signature === p.until) break;
        rows.push(newestFirst[i]);
      }
      return rows.map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null }));
    }
    if (method === "getTransaction") {
      counts.tx++;
      if (o.failAt && counts.tx === o.failAt.n) { const e = o.failAt.error; o.failAt = undefined; throw e; }
      if (o.throttleFrom && counts.tx >= o.throttleFrom) throw new SolTransportError("PROVIDER_THROTTLED", "429");
      const t = bySig.get(params[0] as string);
      return t?.view ?? null;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, counts };
}

class MemoryStore implements SolBackfillStore {
  cursor: string | null = null;
  rows = new Map<string, number>();
  coverage: unknown = null;
  commits = 0;
  violations: string[] = [];
  constructor(public anchorValue: { dateISO: string; lamports: bigint; toleranceLamports?: bigint } | null) {}
  legacyValue: { fromISO: string; toISO: string; rows: Map<string, number> } | null = null;
  async legacy() { return this.legacyValue; }
  async readCursor() { return this.cursor; }
  async anchor() { return this.anchorValue; }
  async commit(c: SolBackfillCommit) {
    if (c.expectedCursor !== this.cursor) throw new CheckpointConflictError();
    if (c.replaceAll) this.rows.clear();
    else if (c.deleteFromISO && c.deleteToISO) {
      for (const d of [...this.rows.keys()]) if (d >= c.deleteFromISO && d <= c.deleteToISO) this.rows.delete(d);
    }
    for (const r of c.rows) {
      // The production createMany uses skipDuplicates — a row outside the
      // deleted span would be SILENTLY kept stale. Treat it as a violation.
      if (this.rows.has(r.dateISO)) this.violations.push(r.dateISO);
      this.rows.set(r.dateISO, r.quantity);
    }
    this.cursor = c.nextCursor;
    if (c.coverage) this.coverage = c.coverage;
    this.commits++;
  }
}

const ANCHOR_ISO = "2026-10-28";
function anchorFor(chain: readonly FixtureTx[]) {
  return { dateISO: ANCHOR_ISO, lamports: BigInt(chain.length ? chain[chain.length - 1].post : 0) };
}

function sameAsTruth(store: MemoryStore, chain: readonly FixtureTx[]): { ok: boolean; detail: string } {
  const want = truth(chain, ANCHOR_ISO);
  if (want.size !== store.rows.size) return { ok: false, detail: `rows ${store.rows.size} vs truth ${want.size}` };
  for (const [d, q] of want) {
    const got = store.rows.get(d);
    if (got === undefined || Math.abs(got - q) > 1e-9) return { ok: false, detail: `${d}: got ${got} want ${q}` };
  }
  return { ok: true, detail: "" };
}

/** Run until COMPLETE (or a stop that is not progress), counting runs. */
async function runToEnd(store: MemoryStore, call: SolRpcCall, clock: { t: number }, budgetMs: number, maxRuns = 500) {
  let runs = 0;
  let last;
  do {
    last = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs, now: () => clock.t, concurrency: 4 });
    runs++;
  } while (last.stoppedBecause === "BUDGET" && runs < maxRuns);
  return { runs, last };
}

const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  console.log("\nno ceiling: size × budget");
  for (const [n, budget] of [[4_999, 1e9], [5_001, 1e9], [12_000, 3_000], [52_000, 9_000]] as const) {
    const chain = makeChain(n, { seed: n });
    const clock = { t: 0 };
    const { call, counts } = rpc(() => chain, clock);
    const store = new MemoryStore(anchorFor(chain));
    const { runs, last } = await runToEnd(store, call, clock, budget);
    const cmp = sameAsTruth(store, chain);
    check(`${n.toLocaleString()} transactions → COMPLETE in ${runs} run(s)`, last.status.state === "COMPLETE", `${last.stoppedBecause} ${last.status.state} ${JSON.stringify(last.failure)}`);
    check(`${n.toLocaleString()}: every day equals the chain's true end-of-day balance`, cmp.ok, cmp.detail);
    // Each full page re-lists its trailing slot (it may continue on the next
    // page), so at most one slot's transactions are fetched twice per page.
    check(`${n.toLocaleString()}: each transaction fetched once (plus ≤ 1 deferred slot per page)`, counts.tx >= n && counts.tx <= n + counts.sig, `${counts.tx} for ${counts.sig} pages`);
    check(`${n.toLocaleString()}: no stale-row overwrite (rows always inside the rewritten span)`, store.violations.length === 0, store.violations.slice(0, 3).join(","));
    const cov = store.coverage as { kind: string; fromISO: string; toISO: string };
    check(`${n.toLocaleString()}: licence COMPLETE from the first transaction's day to the observation`,
      cov?.kind === "COMPLETE" && cov.fromISO === new Date(chain[0].blockTime * 1000).toISOString().slice(0, 10) && cov.toISO === ANCHOR_ISO, JSON.stringify(cov));
    if (n > 5_000) check(`${n.toLocaleString()}: needed more than the old 5-page ceiling and got past it`, counts.sig > 5);
  }

  console.log("\npartial history keeps current holdings and says so");
  {
    const chain = makeChain(12_000, { seed: 3 });
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock);
    const store = new MemoryStore(anchorFor(chain));
    const first = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 2_000, now: () => clock.t });
    check("first bounded run stops for BUDGET, having committed progress", first.stoppedBecause === "BUDGET" && first.progressed);
    check("…state IMPORTING (partial), with a proven interval reaching today", first.status.state === "IMPORTING" && first.status.partial && first.status.historyToISO === ANCHOR_ISO, JSON.stringify(first.status));
    const want = truth(chain, ANCHOR_ISO);
    const wrong = [...store.rows].filter(([d, q]) => Math.abs((want.get(d) ?? -1) - q) > 1e-9);
    check("…every row already written is exactly true (no provisional values)", wrong.length === 0, wrong.slice(0, 2).join(" "));
    check("…and no row exists before the proven interval (never zero, never carried)",
      [...store.rows.keys()].every((d) => d >= (first.status.historyFromISO ?? "9999")));
  }

  console.log("\ninterruption, retry, cursor persistence");
  {
    const chain = makeChain(6_000, { seed: 11 });
    const clock = { t: 0 };
    const r = rpc(() => chain, clock, { failAt: { n: 2_500, error: new SolTransportError("PROVIDER_ERROR", "HTTP 502") } });
    const store = new MemoryStore(anchorFor(chain));
    const a = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call: r.call, budgetMs: 1e9, now: () => clock.t, concurrency: 1 });
    const cp = parseCheckpoint(store.cursor, ACCOUNT, OWNER);
    check("a provider failure mid-run ends the run as FAILURE, keeping committed pages", a.stoppedBecause === "FAILURE" && a.progressed && (cp?.signaturesProcessed ?? 0) >= 2_000, `${a.stoppedBecause} ${cp?.signaturesProcessed}`);
    check("…the failure is stored with its code (durable, not a log line)", cp?.lastFailure?.code === "PROVIDER_ERROR" && cp.failures === 1);
    const txBefore = r.counts.tx;
    const b = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call: r.call, budgetMs: 1e9, now: () => clock.t });
    check("the next run resumes from the stored cursor and completes", b.status.state === "COMPLETE");
    check("…re-fetching only the unfinished page, not the proven history",
      r.counts.tx - txBefore <= 6_000 - (cp?.signaturesProcessed ?? 0) + 1_000, `${r.counts.tx - txBefore}`);
    check("…and clears the failure count", parseCheckpoint(store.cursor, ACCOUNT, OWNER)?.failures === 0);
    check("…and the result equals the truth", sameAsTruth(store, chain).ok, sameAsTruth(store, chain).detail);
  }

  console.log("\nduplicate page delivery");
  {
    const chain = makeChain(3_500, { seed: 5 });
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock, { duplicatePages: true });
    const store = new MemoryStore(anchorFor(chain));
    const { last } = await runToEnd(store, call, clock, 1e9);
    check("a page that repeats the boundary signature is de-duplicated, not double-counted", last.status.state === "COMPLETE" && sameAsTruth(store, chain).ok, sameAsTruth(store, chain).detail);
  }

  console.log("\nconcurrent runs");
  {
    const chain = makeChain(2_500, { seed: 9 });
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock);
    const store = new MemoryStore(anchorFor(chain));
    const [x, y] = await Promise.all([
      runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t }),
      runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t }),
    ]);
    const conflicted = [x, y].filter((o) => o.stoppedBecause === "CONFLICT").length;
    check("two runs from the same checkpoint: exactly one advances it, the other stops on CONFLICT", conflicted === 1, `${x.stoppedBecause}/${y.stoppedBecause}`);
    const { last } = await runToEnd(store, call, clock, 1e9);
    check("…and the history is still exactly true afterwards", last.status.state === "COMPLETE" && sameAsTruth(store, chain).ok, sameAsTruth(store, chain).detail);
  }

  console.log("\nrate limiting");
  {
    let n = 0; const slept: number[] = [];
    const fetchImpl = (async () => {
      n++;
      if (n <= 2) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const call = buildRpcCall({ fetchImpl, rpcUrl: "https://rpc.invalid", sleep: async (ms) => { slept.push(ms); }, now: () => 0 }, 1e12);
    const r = await call("getSignaturesForAddress", [OWNER, {}]);
    check("429 is retried, honouring Retry-After", Array.isArray(r) && n === 3 && slept.join(",") === "2000,2000", `${n} ${slept}`);

    let m = 0;
    const always429 = (async () => { m++; return new Response("", { status: 429 }); }) as unknown as typeof fetch;
    const slept2: number[] = [];
    const call2 = buildRpcCall({ fetchImpl: always429, rpcUrl: "https://rpc.invalid", sleep: async (ms) => { slept2.push(ms); }, now: () => 0, maxRetries: 4 }, 1e12);
    let code = "";
    try { await call2("getTransaction", ["x", {}]); } catch (e) { code = e instanceof SolTransportError ? e.code : String(e); }
    check("…exponential backoff, bounded, then PROVIDER_THROTTLED", code === "PROVIDER_THROTTLED" && m === 5 && slept2.join(",") === "500,1000,2000,4000", `${code} ${m} ${slept2}`);

    let k = 0;
    const deadline = buildRpcCall({ fetchImpl: (async () => { k++; return new Response("", { status: 429, headers: { "retry-after": "30" } }); }) as unknown as typeof fetch,
      rpcUrl: "https://rpc.invalid", sleep: async () => {}, now: () => 0 }, 5_000);
    let c3 = "";
    try { await deadline("getTransaction", ["x", {}]); } catch (e) { c3 = e instanceof SolTransportError ? e.code : ""; }
    check("…and never sleeps past the run's deadline", c3 === "PROVIDER_THROTTLED" && k === 1);

    const rpcErr = buildRpcCall({ fetchImpl: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Too many requests" } }), { status: 200 })) as unknown as typeof fetch,
      rpcUrl: "https://rpc.invalid", sleep: async () => {}, now: () => 0, maxRetries: 1 }, 1e12);
    let c4 = "";
    try { await rpcErr("getTransaction", ["x", {}]); } catch (e) { c4 = e instanceof SolTransportError ? e.code : ""; }
    check("a JSON-RPC rate-limit error is throttling too, not a hard failure", c4 === "PROVIDER_THROTTLED");

    // A throttled run commits what it proved and resumes later.
    const chain = makeChain(3_000, { seed: 21 });
    const clock = { t: 0 };
    const r1 = rpc(() => chain, clock, { throttleFrom: 1_500 });
    const store = new MemoryStore(anchorFor(chain));
    const a = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call: r1.call, budgetMs: 1e9, now: () => clock.t });
    check("a throttled run stops as PROVIDER_THROTTLED with its proven pages kept", a.failure?.code === "PROVIDER_THROTTLED" && a.progressed && a.status.state === "IMPORTING", JSON.stringify(a.status));
    const r2 = rpc(() => chain, clock);
    const { last } = await runToEnd(store, r2.call, clock, 1e9);
    check("…and the next, unthrottled run finishes it exactly", last.status.state === "COMPLETE" && sameAsTruth(store, chain).ok);
  }

  console.log("\nnew activity after completion (head)");
  {
    let chain = makeChain(2_000, { seed: 31, endISO: "2026-10-20" });
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock);
    const store = new MemoryStore({ dateISO: "2026-10-20", lamports: BigInt(chain[chain.length - 1].post) });
    await runToEnd(store, call, clock, 1e9);
    // Two new transactions on 10-25 and 10-27.
    const last = chain[chain.length - 1];
    const add = (i: number, iso: string, delta: number, prev: FixtureTx): FixtureTx => {
      const bt = Date.parse(`${iso}T10:00:00Z`) / 1000; const pre = prev.post; const post = pre + delta;
      return { signature: `new${i}`, slot: prev.slot + 10, blockTime: bt, pre, post,
        view: { slot: prev.slot + 10, blockTime: bt, transaction: { message: { accountKeys: [OWNER, OTHER] } }, meta: { preBalances: [pre, 1], postBalances: [post, 1] } } };
    };
    const n1 = add(1, "2026-10-25", 1_000_000_000, last);
    const n2 = add(2, "2026-10-27", -400_000_000, n1);
    chain = [...chain, n1, n2];
    store.anchorValue = anchorFor(chain);
    const o = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t });
    check("new activity extends the head and reports where history changed", o.progressed && o.impactedFromISO === "2026-10-21", `${o.impactedFromISO}`);
    check("…and history is exactly true through the new observation", sameAsTruth(store, chain).ok, sameAsTruth(store, chain).detail);
    const again = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t });
    check("a re-run with nothing new writes nothing (idempotent)", again.rowsWritten === 0 && !again.progressed && again.status.state === "COMPLETE", JSON.stringify({ r: again.rowsWritten, s: again.stoppedBecause }));
  }

  console.log("\nnever guess across a gap");
  {
    const chain = makeChain(4_000, { seed: 41 });
    const hiddenSig = chain[1_200].signature; // a transaction the index does not list
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock, { hidden: new Set([hiddenSig]) });
    const store = new MemoryStore(anchorFor(chain));
    const o = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t });
    const cp = parseCheckpoint(store.cursor, ACCOUNT, OWNER);
    check("a missing transaction is detected as a GAP → RECOVERY_REQUIRED", o.stoppedBecause === "GAP" && o.status.state === "RECOVERY_REQUIRED" && cp?.gap?.side === "HISTORY", JSON.stringify(o.status));
    check("…naming the proven edge and its unproven neighbour", cp?.gap?.provenSignature === chain[1_201].signature && cp?.gap?.neighbourSignature === chain[1_199].signature, JSON.stringify(cp?.gap));
    const gapDay = new Date(chain[1_201].blockTime * 1000).toISOString().slice(0, 10);
    check("…rows exist only from the proven edge's day, never across the gap",
      [...store.rows.keys()].every((d) => d >= gapDay) && o.status.historyFromISO === gapDay, `${o.status.historyFromISO} vs ${gapDay}`);
    const want = truth(chain, ANCHOR_ISO);
    check("…and every row kept above it is exactly true", [...store.rows].every(([d, q]) => Math.abs((want.get(d) ?? -1) - q) < 1e-9));
    const auto = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t });
    check("automatic runs do not hammer a recorded gap (SKIPPED until recovery)", auto.stoppedBecause === "SKIPPED");
  }

  console.log("\nanchor, empty wallet, failure states");
  {
    const chain = makeChain(300, { seed: 51 });
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock);
    const store = new MemoryStore({ dateISO: ANCHOR_ISO, lamports: BigInt(chain[chain.length - 1].post + 1) });
    const o = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t });
    check("the newest transaction must state the observed balance — else ANCHOR_MISMATCH, nothing written", o.failure?.code === "ANCHOR_MISMATCH" && store.rows.size === 0 && store.coverage === null);

    const empty = new MemoryStore({ dateISO: ANCHOR_ISO, lamports: BigInt(0) });
    const e = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: empty }, { call: rpc(() => [], clock).call, budgetMs: 1e9, now: () => clock.t });
    const ecov = empty.coverage as { kind: string; fromISO: string };
    check("an address with no activity and a zero balance is COMPLETE (no rows, licence at the observation)",
      e.status.state === "COMPLETE" && empty.rows.size === 0 && ecov?.kind === "COMPLETE" && ecov.fromISO === ANCHOR_ISO, JSON.stringify(e.status));
    const notEmpty = new MemoryStore({ dateISO: ANCHOR_ISO, lamports: BigInt(5) });
    const ne = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: notEmpty }, { call: rpc(() => [], clock).call, budgetMs: 1e9, now: () => clock.t });
    check("…but no listed activity with a NON-zero balance is a mismatch, not an empty history", ne.failure?.code === "ANCHOR_MISMATCH" && notEmpty.coverage === null);

    const noAnchor = new MemoryStore(null);
    const na = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: noAnchor }, { call, budgetMs: 1e9, now: () => clock.t });
    check("no observed balance yet ⇒ NO_OBSERVED_ANCHOR, queued, nothing written", na.failure?.code === "NO_OBSERVED_ANCHOR" && na.status.state === "QUEUED" && noAnchor.rows.size === 0);

    const flaky = new MemoryStore(anchorFor(chain));
    const bad: SolRpcCall = async () => { clock.t += 1; throw new SolTransportError("PROVIDER_TIMEOUT", "timeout"); };
    let st = "";
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) st = (await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: flaky }, { call: bad, budgetMs: 1e9, now: () => clock.t })).status.state;
    check(`${MAX_CONSECUTIVE_FAILURES} consecutive failures ⇒ FAILED (explicit terminal state)`, st === "FAILED");
    const skipped = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: flaky }, { call, budgetMs: 1e9, now: () => clock.t });
    check("…automatic runs pause (retry daily) instead of hammering the provider", skipped.stoppedBecause === "SKIPPED");
    const resumed = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: flaky, resume: true }, { call, budgetMs: 1e9, now: () => clock.t });
    check("…an explicit resume runs and completes", resumed.status.state === "COMPLETE" && sameAsTruth(flaky, chain).ok);
  }

  console.log("\nreview findings (PR #99)");
  {
    // Two transactions per slot, delivered in chain order and in reversed order.
    for (const reverse of [false, true]) {
      const chain = makeChain(3_000, { seed: 61, sameSlotPairs: true, perDay: 7 });
      const clock = { t: 0 };
      const { call } = rpc(() => chain, clock, { reverseSameSlot: reverse });
      const store = new MemoryStore(anchorFor(chain));
      const { last } = await runToEnd(store, call, clock, 1_500);
      const cmp = sameAsTruth(store, chain);
      check(`same-slot transactions${reverse ? " delivered out of order" : ""}: the day closes on the LATER one`, last.status.state === "COMPLETE" && cmp.ok, `${last.status.state} ${cmp.detail}`);
    }

    // A gap in NEW activity must not license days the proof does not cover.
    const at = (iso: string) => Date.parse(`${iso}T10:00:00Z`) / 1000;
    const mk = (sig: string, slot: number, iso: string, pre: number, post: number): FixtureTx => ({ signature: sig, slot, blockTime: at(iso), pre, post,
      view: { slot, blockTime: at(iso), transaction: { message: { accountKeys: [OWNER, OTHER] } }, meta: { preBalances: [pre, 1], postBalances: [post, 1] } } });
    const S = 1_000_000_000;
    let chain: FixtureTx[] = [mk("t0", 10, "2026-09-20", 0, 5 * S), mk("t1", 20, "2026-10-01", 5 * S, 5 * S + 1)];
    const clock = { t: 0 };
    const hidden = new Set<string>();
    const { call } = rpc(() => chain, clock, { hidden });
    const store = new MemoryStore({ dateISO: "2026-10-01", lamports: BigInt(5 * S + 1) });
    await runToEnd(store, call, clock, 1e9);
    chain = [...chain, mk("a", 30, "2026-10-10", 5 * S + 1, 6 * S + 1), mk("m", 40, "2026-10-12", 6 * S + 1, 3 * S + 1), mk("b", 50, "2026-10-20", 3 * S + 1, 4 * S + 1)];
    hidden.add("m");
    store.anchorValue = { dateISO: ANCHOR_ISO, lamports: BigInt(4 * S + 1) };
    const g = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1e9, now: () => clock.t });
    const cp = parseCheckpoint(store.cursor, ACCOUNT, OWNER);
    check("a HEAD gap stops the licence BEFORE the newest proven transaction's day", g.stoppedBecause === "GAP" && cp?.licensedToISO === "2026-10-09", `${g.stoppedBecause} ${cp?.licensedToISO}`);
    check("…so no day after the hidden transaction carries an unproven balance", ![...store.rows.keys()].some((d) => d >= "2026-10-10"), [...store.rows.keys()].filter((d) => d >= "2026-10-10").join(","));

    // A licence that ran through today from a midday reading is withdrawn for
    // today when later, unproven activity shares the day.
    {
      const at2 = (iso: string, h: number) => Date.parse(`${iso}T${String(h).padStart(2, "0")}:00:00Z`) / 1000;
      const mk2 = (sig: string, slot: number, iso: string, h: number, pre: number, post: number): FixtureTx => ({ signature: sig, slot, blockTime: at2(iso, h), pre, post,
        view: { slot, blockTime: at2(iso, h), transaction: { message: { accountKeys: [OWNER, OTHER] } }, meta: { preBalances: [pre, 1], postBalances: [post, 1] } } });
      let ch = [mk2("x0", 10, "2026-10-20", 9, 0, 5 * S), mk2("x1", 20, "2026-10-28", 9, 5 * S, 6 * S)];
      const ck = { t: 0 }; const hid = new Set<string>();
      const rr = rpc(() => ch, ck, { hidden: hid });
      const st = new MemoryStore({ dateISO: "2026-10-28", lamports: BigInt(6 * S) });
      await runToEnd(st, rr.call, ck, 1e9);
      ch = [...ch, mk2("x2", 30, "2026-10-28", 14, 6 * S, 7 * S), mk2("x3", 40, "2026-10-28", 16, 7 * S, 2 * S), mk2("x4", 50, "2026-10-28", 18, 2 * S, 3 * S)];
      hid.add("x3");
      await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: st }, { call: rr.call, budgetMs: 1e9, now: () => ck.t });
      const cpx = parseCheckpoint(st.cursor, ACCOUNT, OWNER);
      check("an unverified head WITHDRAWS a day it had licensed (and its row)", cpx?.licensedToISO === "2026-10-27" && !st.rows.has("2026-10-28"), `${cpx?.licensedToISO} ${st.rows.get("2026-10-28")}`);
    }

    // An unverified head (balance read raced new activity) never blocks the backfill.
    const big = makeChain(4_000, { seed: 71 });
    const c2 = { t: 0 };
    const r2 = rpc(() => big, c2);
    const s2 = new MemoryStore(anchorFor(big));
    await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: s2 }, { call: r2.call, budgetMs: 1_500, now: () => c2.t });
    s2.anchorValue = { dateISO: ANCHOR_ISO, lamports: anchorFor(big).lamports + BigInt(7) }; // the head no longer reconciles
    const before = parseCheckpoint(s2.cursor, ACCOUNT, OWNER)?.signaturesProcessed ?? 0;
    const h = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: s2 }, { call: r2.call, budgetMs: 1_500, now: () => c2.t });
    const after = parseCheckpoint(s2.cursor, ACCOUNT, OWNER);
    check("an unverified head still lets older history advance", h.progressed && (after?.signaturesProcessed ?? 0) > before && !h.status.headVerified, `${before}→${after?.signaturesProcessed}`);
    check("…and is not a failure (never pauses the backfill)", (after?.failures ?? -1) === 0 && h.failure === null);

    // Float-stored anchors carry their representation error as tolerance.
    const huge = makeChain(50, { seed: 81, startLamports: 4_900_000 * S });
    const c3 = { t: 0 };
    const tol = new MemoryStore({ dateISO: ANCHOR_ISO, lamports: anchorFor(huge).lamports + BigInt(2), toleranceLamports: BigInt(4) });
    const th = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: tol }, { call: rpc(() => huge, c3).call, budgetMs: 1e9, now: () => c3.t });
    check("a 4.9M SOL anchor off by float rounding still reconciles within its stated tolerance", th.status.state === "COMPLETE", JSON.stringify(th.failure));

    // Committed progress then a failure: the run reports what changed.
    const p = makeChain(2_500, { seed: 91 });
    const c4 = { t: 0 };
    const r4 = rpc(() => p, c4, { failAt: { n: 1_800, error: new SolTransportError("PROVIDER_THROTTLED", "429") } });
    const s4 = new MemoryStore(anchorFor(p));
    const pf = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store: s4 }, { call: r4.call, budgetMs: 1e9, now: () => c4.t, concurrency: 1 });
    check("progress then failure still reports rows written and where history changed", pf.progressed && pf.rowsWritten > 0 && pf.impactedFromISO !== null && pf.failure?.code === "PROVIDER_THROTTLED");
    const store99 = read("lib/crypto/sol-history-backfill.store.ts");
    check("…and the refresh treats committed progress as a refresh (snapshot window widens)", /if \(o\.progressed\) \{[\s\S]{0,400}return \{ \.\.\.base, ok: true, \.\.\.refusal \};/.test(store99));
  }

  console.log("\nowner decision 1 — legacy history is preserved until replaced atomically");
  {
    const chain = makeChain(12_000, { seed: 101 });
    const want = truth(chain, ANCHOR_ISO);
    const days = [...want.keys()];
    const legacyFrom = days[0], legacyTo = days[days.length - 3];
    const legacyRows = new Map([...want].filter(([d]) => d <= legacyTo));
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock);
    const store = new MemoryStore(anchorFor(chain));
    for (const [d, q] of legacyRows) store.rows.set(d, q);
    const legacyCov = { kind: "COMPLETE", fromISO: legacyFrom, toISO: legacyTo, source: "solana-rpc+balance-reconciliation" };
    store.coverage = legacyCov;
    store.legacyValue = { fromISO: legacyFrom, toISO: legacyTo, rows: new Map(legacyRows) };
    const first = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 2_000, now: () => clock.t });
    check("while the new proof builds, legacy rows and licence are untouched", store.coverage === legacyCov && store.rows.size === legacyRows.size
      && [...legacyRows].every(([d, q]) => store.rows.get(d) === q) && first.rowsWritten === 0, `${store.rows.size} ${first.rowsWritten}`);
    check("…and the status says the legacy history is the one in force", first.status.legacyInForce && first.status.state === "IMPORTING");
    check("…while the proof itself is durably staged in the checkpoint", (parseCheckpoint(store.cursor, ACCOUNT, OWNER)?.staged?.length ?? 0) > 0);
    const { last } = await runToEnd(store, call, clock, 2_000);
    const cp = parseCheckpoint(store.cursor, ACCOUNT, OWNER);
    check("once the proof covers the legacy interval it is PROMOTED in one commit", (last.promoted === "COVERED" || cp?.promotedAtISO != null) && cp?.mode === "DIRECT" && !cp?.staged);
    check("…the rows are then exactly the proven truth, under the new licence", sameAsTruth(store, chain).ok && (store.coverage as { source: string }).source === "solana-rpc+chain-continuity", sameAsTruth(store, chain).detail);
    check("…and agreement with legacy is recorded as no discrepancy", !cp?.legacyDiscrepancy && !last.status.legacyInForce);
  }
  {
    const chain = makeChain(6_000, { seed: 103 });
    const want = truth(chain, ANCHOR_ISO);
    const days = [...want.keys()];
    const legacyRows = new Map(want);
    const wrongDay = days[days.length - 5];
    legacyRows.set(wrongDay, (legacyRows.get(wrongDay) ?? 0) + 3); // legacy was wrong on one recent day
    const clock = { t: 0 };
    const { call } = rpc(() => chain, clock);
    const store = new MemoryStore(anchorFor(chain));
    for (const [d, q] of legacyRows) store.rows.set(d, q);
    store.coverage = { kind: "COMPLETE", fromISO: days[0], toISO: ANCHOR_ISO, source: "solana-rpc+balance-reconciliation" };
    store.legacyValue = { fromISO: days[0], toISO: ANCHOR_ISO, rows: new Map(legacyRows) };
    const o = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call, budgetMs: 1_200, now: () => clock.t });
    const cp = parseCheckpoint(store.cursor, ACCOUNT, OWNER);
    check("legacy history demonstrably wrong on a proven day is withdrawn at once (not kept on show)", o.promoted === "LEGACY_DISPROVED" && cp?.mode === "DIRECT", `${o.promoted} ${cp?.mode}`);
    check("…the disagreement is disclosed with its first day", cp?.legacyDiscrepancy?.days === 1 && cp.legacyDiscrepancy.firstISO === wrongDay && o.status.legacyDiscrepancy?.days === 1);
    check("…and no legacy row survives beside the proof (projections never mixed)",
      [...store.rows.keys()].every((d) => d >= (cp?.licensedFromISO ?? "9")) && store.rows.get(wrongDay) === want.get(wrongDay));
  }
  {
    // The legacy licence's LAST day is a midday reading; the proof's end-of-day
    // value for it may differ without the legacy history being wrong.
    const staged: Array<[string, string]> = [["2026-10-26", "5000000000"], ["2026-10-27", "6000000000"]];
    const d = decidePromotion({ licensedFromISO: "2026-10-26", licensedToISO: "2026-10-28", reachedBeginning: false, completedAtISO: null },
      staged, { fromISO: "2026-01-01", toISO: "2026-10-27" }, new Map([["2026-10-26", 5], ["2026-10-27", 5.5]]));
    check("a different value on the legacy licence's last (midday-read) day is NOT a disproof", !d.promote && d.discrepancy === null, JSON.stringify(d));
    check("a malformed staged checkpoint is not trusted", parseCheckpoint(JSON.stringify({ ...emptyCheckpoint(ACCOUNT, OWNER, "x"), mode: "STAGING", staged: [["bad", "1"]], legacy: { fromISO: "a", toISO: "b" } }), ACCOUNT, OWNER) === null);
  }
  {
    const chain = makeChain(500, { seed: 105 });
    const clock = { t: 0 };
    const store = new MemoryStore(anchorFor(chain));
    store.rows.set("2020-01-01", 42); // an UNLICENSED leftover
    const o = await runSolHistoryBackfill({ accountId: ACCOUNT, address: OWNER, store }, { call: rpc(() => chain, clock).call, budgetMs: 1e9, now: () => clock.t });
    check("no licensed legacy ⇒ direct writes; unlicensed leftovers are replaced", o.status.state === "COMPLETE" && !store.rows.has("2020-01-01") && sameAsTruth(store, chain).ok);
  }

  console.log("\nunits");
  {
    const p = (sig: string, slot: number, iso: string, pre: number, post: number) =>
      ({ signature: sig, slot, blockTime: Date.parse(`${iso}T12:00:00Z`) / 1000, dateISO: iso, preLamports: String(pre), postLamports: String(post) });
    const closings = dailyClosings([p("a", 1, "2026-01-01", 0, 10), p("b", 2, "2026-01-03", 10, 4)], "2025-12-31", "2026-01-04");
    check("daily closings: no row before the first point; carried between; stepped on the day",
      JSON.stringify(closings.map((c) => [c.dateISO, Number(c.lamports)])) === JSON.stringify([["2026-01-01", 10], ["2026-01-02", 10], ["2026-01-03", 4], ["2026-01-04", 4]]));
    const g = extendBackward(p("b", 2, "2026-01-03", 10, 4), [p("a", 1, "2026-01-01", 0, 9)]);
    check("continuity: post(older) ≠ pre(newer) is a gap", g.kind === "GAP");
    check("status of no checkpoint is QUEUED", backfillStatus(null).state === "QUEUED");
    const raw = JSON.stringify({ kind: "sol-history", v: 1 });
    check("a SOL checkpoint is recognisable, so source health never reads it as BTC discovery",
      isSolBackfillCursor(raw) && !isSolBackfillCursor('{"v":1,"xpub":"…"}') && !isSolBackfillCursor(null));
  }

  console.log("\nwiring");
  {
    const refresh = read("lib/crypto/wallet-history-refresh.ts");
    check("the wallet refresh runs the RESUMABLE backfill for SOL", /SOL_NATIVE\.chain \? \(a: [^)]*\) => reconstructSolHistoryResumable\(\{ \.\.\.a, client: db \}\)/.test(refresh));
    const run = read("lib/crypto/sol-history-backfill.ts") + read("lib/crypto/sol-history-backfill.store.ts");
    check("no transaction-count ceiling: runs are bounded by wall-clock only", !/pageBudget|PAGE_BUDGET/.test(run) && /deadlineMs/.test(run));
    check("the checkpoint is compare-and-swapped in the SAME transaction as rows and licence",
      /\$transaction\(async \(tx\) => \{\s*const swapped = await tx\.connection\.updateMany\(\{ where: \{ id: connectionId, cursor: c\.expectedCursor \}/.test(run)
      && /persistPositionCoverage\(tx,/.test(run));
    check("only DERIVED rows of this source are ever deleted", /origin: PositionOrigin\.DERIVED, source: SOL_RECONSTRUCTION_SOURCE/.test(run) && !/OBSERVED[^\n]*deleteMany|deleteMany[^\n]*OBSERVED/.test(run));
    const health = read("lib/connections/space-data.ts") + read("lib/connections/space-data-health.ts");
    check("the wallet state derivation excludes it too (never 'importing' on a SOL checkpoint)",
      /discoveryCursor: c\.cursor && !isSolBackfillCursor\(c\.cursor\) \? c\.cursor : null/.test(read("lib/sync/wallet-connections.ts")));
    check("both source-health readers exclude the SOL checkpoint from 'discovery in progress'",
      (health.match(/discoveryCursor: !!\w+\.cursor && !isSolBackfillCursor\(\w+\.cursor\)/g) ?? []).length === 2);
    check("standard RPC methods only, finalized, v0-aware",
      /"getSignaturesForAddress"/.test(run) && /"getTransaction"/.test(run) && /commitment: "finalized"/.test(run) && /maxSupportedTransactionVersion: 0/.test(run));
  }

  console.log(`\nsol-history-resumable: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
