/**
 * lib/crypto/btc-history-resumable.test.ts
 *
 * The resumable Bitcoin backfill against a deterministic in-memory Esplora: no
 * network, no database. The REAL transport (btc-explorer's esploraGetJson, with
 * its 429/Retry-After backoff) is driven through an injected fetch. Every
 * scenario ends by comparing the stored rows with the fixture's TRUE end-of-day
 * balances, day by day, and the imported Transaction set with the chain's.
 *
 *   npx tsx lib/crypto/btc-history-resumable.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  runBtcHistoryBackfill, CheckpointConflictError, btcSyncHeadOnly, btcSyncRunBudgetMs,
  type BtcBackfillStore, type BtcBackfillCommit, type BtcBackfillDeps,
} from "@/lib/crypto/btc-history-backfill";
import {
  parseCheckpoint, backfillStatus, dailyClosings, pointFromTransaction, statsMismatch, MISMATCH_RECOVERY_THRESHOLD, MAX_CONSECUTIVE_FAILURES,
  BTC_CHAIN_STATS_SOURCE, type BtcBackfillCheckpoint,
} from "@/lib/crypto/btc-history-backfill.core";
import { fetchAddressTxsRawPaged } from "@/lib/crypto/btc-explorer";
import { btcWorkerConfig, orderBtcCandidates } from "@/lib/crypto/btc-backfill-worker.core";
import { workerConfig } from "@/lib/crypto/sol-backfill-worker.core";
import { solHistoryBackfill, type SolBackfillJobDeps } from "@/jobs/sol-history-backfill";
import type { BtcResumableResult } from "@/lib/crypto/btc-history-backfill.store";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const A = "bc1qfixtureaddressaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bc1qfixtureaddressbbbbbbbbbbbbbbbbbbbbbbb";
const C = "bc1qfixtureaddresscccccccccccccccccccccccc";
const EXT = "bc1qsomeoneelsexxxxxxxxxxxxxxxxxxxxxxxxxx";
const ACCOUNT = "acct_btc_fixture";
const NOW_ISO = "2026-10-28T12:00:00.000Z";
const TODAY = NOW_ISO.slice(0, 10);
const YESTERDAY = "2026-10-27";

// ── A deterministic UTXO chain ───────────────────────────────────────────────

interface FxTx {
  txid: string;
  height: number;
  time: number;
  vin: Array<{ prevout: { scriptpubkey_address: string; value: number } | null }>;
  vout: Array<{ scriptpubkey_address: string; value: number }>;
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

interface World {
  txs: FxTx[];
  tip: number;
  /** Txids hidden from the address index (still counted by chain_stats). */
  hidden: Set<string>;
  utxo: Map<string, Array<{ value: number }>>;
  rnd: () => number;
  nextHeight: number;
  nextTime: number;
  seq: number;
}

/**
 * `n` transactions over `addresses`, oldest first, `perBlock` per block, about
 * `perDay` per day, ending before NOW. Receipts, sends with change (sometimes
 * to a sibling address — an xpub's internal move) and the odd consolidation.
 */
function makeWorld(n: number, opts: { addresses?: string[]; seed?: number; perBlock?: number; perDay?: number; startHeight?: number } = {}): World {
  const addresses = opts.addresses ?? [A];
  const perBlock = opts.perBlock ?? 3;
  const perDay = opts.perDay ?? 30;
  const blocksPerDay = Math.max(1, Math.ceil(perDay / perBlock));
  const end = Date.parse(NOW_ISO) / 1000 - 3 * 3600; // the newest block is three hours old
  const days = Math.ceil(n / perDay) + 1;
  const w: World = {
    txs: [], tip: 0, hidden: new Set(), utxo: new Map(addresses.map((a) => [a, []])), rnd: prng(opts.seed ?? 11),
    nextHeight: opts.startHeight ?? 700_000, nextTime: end - days * 86_400, seq: 0,
  };
  const step = Math.floor(86_400 / blocksPerDay);
  let inBlock = 0;
  for (let i = 0; i < n; i++) {
    addTx(w, addresses);
    if (++inBlock >= perBlock) { inBlock = 0; w.nextHeight++; w.nextTime += step; }
  }
  w.tip = w.txs.length ? w.txs[w.txs.length - 1].height + 10 : w.nextHeight; // all settled at the start
  return w;
}

function addTx(w: World, addresses: string[], kind?: "receive"): FxTx {
  const rnd = w.rnd;
  const txid = `${String(w.seq++).padStart(8, "0")}${"f".repeat(56)}`;
  const own = (k: number) => addresses[k % addresses.length];
  const balance = (a: string) => (w.utxo.get(a) ?? []).reduce((s, u) => s + u.value, 0);
  const pick = addresses[Math.floor(rnd() * addresses.length)];
  const fee = 200 + Math.floor(rnd() * 800);
  let tx: FxTx;
  if (kind === "receive" || balance(pick) < 200_000 || rnd() < 0.55) {
    const v = 10_000 + Math.floor(rnd() * 5_000_000);
    const to = pick;
    tx = { txid, height: w.nextHeight, time: w.nextTime, vin: [{ prevout: { scriptpubkey_address: EXT, value: v + fee } }], vout: [{ scriptpubkey_address: to, value: v }] };
    w.utxo.get(to)!.push({ value: v });
  } else {
    // Spend every UTXO of `pick` (simple coin selection): send some out, change back.
    const inputs = w.utxo.get(pick)!.splice(0);
    const total = inputs.reduce((s, u) => s + u.value, 0);
    const out = Math.floor((total - fee) * (0.1 + rnd() * 0.6));
    const change = total - fee - out;
    const changeTo = addresses.length > 1 && rnd() < 0.4 ? own(addresses.indexOf(pick) + 1) : pick;
    const internal = addresses.length > 1 && rnd() < 0.3;
    const vout = internal
      ? [{ scriptpubkey_address: own(addresses.indexOf(pick) + 1), value: out }, { scriptpubkey_address: changeTo, value: change }]
      : [{ scriptpubkey_address: EXT, value: out }, { scriptpubkey_address: changeTo, value: change }];
    tx = { txid, height: w.nextHeight, time: w.nextTime, vin: inputs.map((u) => ({ prevout: { scriptpubkey_address: pick, value: u.value } })), vout };
    for (const o of vout) if (w.utxo.has(o.scriptpubkey_address)) w.utxo.get(o.scriptpubkey_address)!.push({ value: o.value });
  }
  w.txs.push(tx);
  return tx;
}

/** Mine `blocks` new blocks of `perBlock` transactions each, dated now-ish. */
function mine(w: World, addresses: string[], blocks: number, perBlock = 2, nowSec = Date.parse(NOW_ISO) / 1000): void {
  w.nextHeight = Math.max(w.nextHeight, w.tip + 1);
  for (let b = 0; b < blocks; b++) {
    w.nextTime = Math.min(nowSec - 60, w.nextTime + 600);
    for (let i = 0; i < perBlock; i++) addTx(w, addresses);
    w.tip = w.nextHeight;
    w.nextHeight++;
  }
}

const touches = (t: FxTx, a: string) => t.vout.some((o) => o.scriptpubkey_address === a) || t.vin.some((i) => i.prevout?.scriptpubkey_address === a);
const confirmed = (w: World) => w.txs.filter((t) => t.height <= w.tip);
const net = (t: FxTx, addresses: string[]) =>
  t.vout.reduce((s, o) => s + (addresses.includes(o.scriptpubkey_address) ? o.value : 0), 0)
  - t.vin.reduce((s, i) => s + (i.prevout && addresses.includes(i.prevout.scriptpubkey_address) ? i.prevout.value : 0), 0);

/**
 * End-of-day truth for every day from the first confirmed transaction to
 * `toISO`, each block dated by the latest block time among the wallet's blocks
 * at or below its height (the chain's own order, never a spend before its coin).
 */
function truth(w: World, addresses: string[], toISO = TODAY): Map<string, number> {
  const m = new Map<string, number>();
  const txs = confirmed(w).filter((t) => addresses.some((a) => touches(t, a))).sort((x, y) => x.height - y.height);
  if (txs.length === 0) return m;
  const byDay = new Map<string, number>();
  let maxTime = 0;
  for (const t of txs) {
    maxTime = Math.max(maxTime, t.time);
    const d = new Date(maxTime * 1000).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + net(t, addresses));
  }
  let run = 0;
  for (let d = [...byDay.keys()].sort()[0]; d <= toISO; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    run += byDay.get(d) ?? 0;
    m.set(d, run / 1e8);
  }
  return m;
}

// ── A fake Esplora, served through the real transport ────────────────────────

interface ExplorerOpts {
  /** 429 (with Retry-After seconds) for the Nth..Mth requests overall (1-based). */
  throttle?: { from: number; to: number; retryAfterS?: number };
  /** Prepend the previous page's last `k` rows to every continued page (duplicate delivery). */
  duplicateRows?: number;
  /** Ignore the cursor on the Nth paged request (returns the newest page again). */
  ignoreCursorAt?: number;
  /** Network failure on the Nth request overall, once. */
  failAt?: number;
  /** Called on every chain_stats read, before answering (a block can land here). */
  onStats?: () => void;
  /** Reverse the within-block order of the listing from the Nth paged request on. */
  reverseBlocksFrom?: number;
}

function explorer(world: () => World, clock: { t: number }, o: ExplorerOpts = {}) {
  const counts = { all: 0, txs: 0, stats: 0, tip: 0, paged: 0, byCursor: new Map<string, number>() };
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const listFor = (w: World, a: string) => {
    const list = confirmed(w).filter((t) => touches(t, a) && !w.hidden.has(t.txid)).reverse(); // newest first
    if (!o.reverseBlocksFrom || counts.paged < o.reverseBlocksFrom) return list;
    // The order WITHIN a block is not a contract: deliver each block reversed.
    const out: FxTx[] = [];
    for (let i = 0; i < list.length; ) {
      let j = i + 1;
      while (j < list.length && list[j].height === list[i].height) j++;
      out.push(...list.slice(i, j).reverse());
      i = j;
    }
    return out;
  };
  const esplora = (t: FxTx) => ({ txid: t.txid, vin: t.vin, vout: t.vout, fee: 0, status: { confirmed: true, block_height: t.height, block_time: t.time } });
  const fetchImpl = (async (url: string) => {
    clock.t += 1;
    counts.all++;
    if (o.failAt && counts.all === o.failAt) { o.failAt = undefined; throw new TypeError("fetch failed"); }
    if (o.throttle && counts.all >= o.throttle.from && counts.all <= o.throttle.to) {
      return respond(429, null, o.throttle.retryAfterS ? { "retry-after": String(o.throttle.retryAfterS) } : {});
    }
    const u = new URL(url);
    if (u.pathname.match(/^\/api\/address\/[^/]+$/)) o.onStats?.();
    const w = world();
    const p = u.pathname;
    if (p === "/api/blocks/tip/height") { counts.tip++; return respond(200, w.tip); }
    let m = p.match(/^\/api\/address\/([^/]+)\/txs\/chain(?:\/([^/]+))?$/);
    if (m) {
      counts.txs++;
      const a = decodeURIComponent(m[1]);
      const last = m[2] ? decodeURIComponent(m[2]) : null;
      const list = listFor(w, a);
      let start = 0;
      if (last) {
        counts.paged++;
        counts.byCursor.set(last, (counts.byCursor.get(last) ?? 0) + 1);
        if (o.ignoreCursorAt && counts.paged === o.ignoreCursorAt) start = 0;
        else {
          const i = list.findIndex((t) => t.txid === last);
          if (i < 0) return respond(400, "Transaction not found");
          start = i + 1;
        }
      }
      const rows = list.slice(start, start + 25).map(esplora);
      if (last && o.duplicateRows && start > 0) rows.unshift(...list.slice(Math.max(0, start - o.duplicateRows), start).map(esplora));
      return respond(200, rows);
    }
    m = p.match(/^\/api\/address\/([^/]+)$/);
    if (m) {
      counts.stats++;
      const a = decodeURIComponent(m[1]);
      const txs = confirmed(w).filter((t) => touches(t, a));
      const funded = txs.reduce((s, t) => s + t.vout.reduce((x, v) => x + (v.scriptpubkey_address === a ? v.value : 0), 0), 0);
      const spent = txs.reduce((s, t) => s + t.vin.reduce((x, v) => x + (v.prevout?.scriptpubkey_address === a ? v.prevout.value : 0), 0), 0);
      return respond(200, { address: a, chain_stats: { funded_txo_sum: funded, spent_txo_sum: spent, tx_count: txs.length }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
    }
    return respond(404, "not found");
  }) as unknown as typeof fetch;
  return { fetchImpl, counts };
}

class MemoryStore implements BtcBackfillStore {
  cursor: string | null = null;
  rows = new Map<string, number>();
  /** OBSERVED rows — the store must never touch them. */
  observed = new Map<string, number>([[TODAY, 1.2345]]);
  coverage: unknown = null;
  commits = 0;
  replaceAllCommits = 0;
  imported = new Set<string>();
  importedTimes = new Map<string, number>();
  violations: string[] = [];
  legacyValue: { fromISO: string; toISO: string; rows: Map<string, number> } | null = null;
  constructor(public addressSet: { addresses: string[]; complete: boolean }, public accountId = ACCOUNT) {}
  async readCursor() { return this.cursor; }
  async addresses() { return { addresses: [...this.addressSet.addresses], complete: this.addressSet.complete }; }
  async legacy() { return this.legacyValue; }
  async commit(c: BtcBackfillCommit) {
    if (c.expectedCursor !== this.cursor) throw new CheckpointConflictError();
    if (c.replaceAll) { this.rows.clear(); this.replaceAllCommits++; }
    else if (c.deleteFromISO && c.deleteToISO) {
      for (const d of [...this.rows.keys()]) if (d >= c.deleteFromISO && d <= c.deleteToISO) this.rows.delete(d);
    }
    for (const r of c.rows) {
      // Production createMany uses skipDuplicates — a row outside the deleted span would stay stale.
      if (this.rows.has(r.dateISO)) this.violations.push(r.dateISO);
      this.rows.set(r.dateISO, r.quantity);
    }
    for (const t of c.rawTxs) { this.imported.add(t.txid); this.importedTimes.set(t.txid, (this.importedTimes.get(t.txid) ?? 0) + 1); }
    this.cursor = c.nextCursor;
    if (c.coverage) this.coverage = c.coverage;
    this.commits++;
  }
  checkpoint(): BtcBackfillCheckpoint | null { return parseCheckpoint(this.cursor, this.accountId); }
}

/** Stored rows vs the truth, through the licensed edge (rows beyond it are never written). */
function sameAsTruth(store: MemoryStore, w: World, addresses: string[]): { ok: boolean; detail: string } {
  const to = (store.coverage as { toISO?: string } | null)?.toISO ?? TODAY;
  const want = truth(w, addresses, to);
  if (want.size !== store.rows.size) return { ok: false, detail: `rows ${store.rows.size} vs truth ${want.size}` };
  for (const [d, q] of want) {
    const got = store.rows.get(d);
    if (got === undefined || Math.abs(got - q) > 5e-9) return { ok: false, detail: `${d}: got ${got} want ${q}` };
  }
  return { ok: true, detail: "" };
}

/** Every confirmed transaction touching the wallet was imported as a Transaction row. */
function importedAll(store: MemoryStore, w: World, addresses: string[]): { ok: boolean; detail: string } {
  const want = confirmed(w).filter((t) => addresses.some((a) => touches(t, a)) && !w.hidden.has(t.txid)).map((t) => t.txid);
  const missing = want.filter((t) => !store.imported.has(t));
  return { ok: missing.length === 0, detail: `${missing.length} of ${want.length} missing` };
}

function depsFor(ex: ReturnType<typeof explorer>, clock: { t: number }, over: BtcBackfillDeps = {}): BtcBackfillDeps {
  return {
    fetchImpl: ex.fetchImpl, explorerBaseUrl: "https://esplora.test",
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, budgetMs: 1e12, requestTimeoutMs: 60_000, ...over,
  };
}

async function runToEnd(store: MemoryStore, deps: () => BtcBackfillDeps, maxRuns = 400) {
  let runs = 0;
  let last;
  while (runs < maxRuns) {
    last = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, deps());
    runs++;
    if (last.status.state === "COMPLETE" || last.status.state === "RECOVERY_REQUIRED" || last.status.state === "FAILED") break;
  }
  return { runs, last: last! };
}

async function main() {
  const clockAt = () => ({ t: Date.parse(NOW_ISO) });

  console.log("small and boundary wallets (one run each)");
  for (const n of [999, 1_001]) {
    const w = makeWorld(n, { seed: n });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    const cmp = sameAsTruth(store, w, [A]);
    check(`${n} txs: COMPLETE in one run`, o.status.state === "COMPLETE" && o.verified === true, `${o.status.state} ${o.stoppedBecause}`);
    check(`${n} txs: every stored day equals the true end-of-day balance`, cmp.ok, cmp.detail);
    check(`${n} txs: each page listed once (${Math.floor(n / 25) + 1} pages, no re-list)`, ex.counts.txs === Math.floor(n / 25) + 1 && [...ex.counts.byCursor.values()].every((c) => c === 1), String(ex.counts.txs));
    check(`${n} txs: every transaction imported as a Transaction row`, importedAll(store, w, [A]).ok, importedAll(store, w, [A]).detail);
    check(`${n} txs: licensed COMPLETE from the first transaction through YESTERDAY — today's end is not known yet (${BTC_CHAIN_STATS_SOURCE})`,
      JSON.stringify(store.coverage) === JSON.stringify({ kind: "COMPLETE", fromISO: [...truth(w, [A]).keys()][0], toISO: YESTERDAY, source: BTC_CHAIN_STATS_SOURCE }), JSON.stringify(store.coverage));
    check(`${n} txs: OBSERVED rows untouched, no stale-row overlap`, store.observed.get(TODAY) === 1.2345 && store.violations.length === 0);
  }

  console.log("beyond the old ceiling: 5,200 and 20,000 transactions, many bounded runs");
  for (const [n, pagesPerRun] of [[5_200, 40], [20_000, 120]] as const) {
    const w = makeWorld(n, { seed: n, perDay: 60, perBlock: 4 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    const { runs, last } = await runToEnd(store, () => depsFor(ex, clock, { requestBudget: pagesPerRun }));
    const cmp = sameAsTruth(store, w, [A]);
    const cp = store.checkpoint()!;
    check(`${n} txs: COMPLETE after ${runs} runs of ≤ ${pagesPerRun} requests (resumed from the checkpoint each time)`, last.status.state === "COMPLETE" && runs > 1, `${last.status.state} after ${runs}`);
    check(`${n} txs: every stored day equals the true end-of-day balance`, cmp.ok, cmp.detail);
    check(`${n} txs: each transaction folded exactly once (count = chain_stats.tx_count)`, cp.addresses[0].txCount === n && cp.txsProcessed === n, `${cp.addresses[0].txCount}`);
    check(`${n} txs: no page cursor listed twice across runs`, [...ex.counts.byCursor.values()].every((c) => c === 1));
    check(`${n} txs: every transaction imported as a Transaction row`, importedAll(store, w, [A]).ok, importedAll(store, w, [A]).detail);
    check(`${n} txs: no licence and no rows until the whole listing was proven`, store.replaceAllCommits === 1);
  }

  console.log("interruption and resume");
  {
    const w = makeWorld(3_000, { seed: 5 });
    const clock = clockAt();
    const ex = explorer(() => w, clock, { failAt: 37 });
    const store = new MemoryStore({ addresses: [A], complete: true });
    const first = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { commitEveryPages: 5 }));
    const mid = store.checkpoint()!;
    check("a network failure mid-run ends the run as PROVIDER_ERROR and keeps the committed progress",
      first.stoppedBecause === "FAILURE" && first.failure?.code === "PROVIDER_ERROR" && mid.addresses[0].txCount > 0 && mid.failures === 1, JSON.stringify(first.failure));
    check("…writing no rows or licence for a partial listing", store.rows.size === 0 && store.coverage === null);
    const second = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    const cmp = sameAsTruth(store, w, [A]);
    check("the next run resumes from the checkpoint and completes", second.status.state === "COMPLETE", second.status.state);
    check("…every day equals the truth and no transaction was counted twice", cmp.ok && store.checkpoint()!.addresses[0].txCount === 3_000, cmp.detail);
    check("…and the failure counter is reset by progress", store.checkpoint()!.failures === 0);
  }

  console.log("429 backoff (Retry-After honoured) and exhaustion");
  {
    const w = makeWorld(600, { seed: 9 });
    const clock = clockAt();
    const slept: number[] = [];
    const ex = explorer(() => w, clock, { throttle: { from: 3, to: 5, retryAfterS: 2 } });
    const store = new MemoryStore({ addresses: [A], complete: true });
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { sleep: async (ms) => { slept.push(ms); clock.t += ms; } }));
    const cmp = sameAsTruth(store, w, [A]);
    check("three 429s are retried after the server's Retry-After (2 s each) and the run completes",
      o.status.state === "COMPLETE" && slept.length === 3 && slept.every((ms) => ms === 2_000), `${o.status.state} ${slept.join(",")}`);
    check("…every day equals the truth", cmp.ok, cmp.detail);
    check("…and every attempt (retries included) is metered", (store.checkpoint()!.usage?.requests ?? 0) === ex.counts.all, `${store.checkpoint()!.usage?.requests} vs ${ex.counts.all}`);

    const w2 = makeWorld(300, { seed: 10 });
    const c2 = clockAt();
    const ex2 = explorer(() => w2, c2, { throttle: { from: 1, to: 1e9 } });
    const s2 = new MemoryStore({ addresses: [A], complete: true });
    let last;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) last = await runBtcHistoryBackfill({ accountId: ACCOUNT, store: s2 }, depsFor(ex2, c2, { maxRetries: 2, backoffBaseMs: 10 }));
    check("persistent throttling ⇒ PROVIDER_THROTTLED, and six in a row ⇒ FAILED (daily retry)",
      last!.failure?.code === "PROVIDER_THROTTLED" && last!.status.state === "FAILED", `${last!.failure?.code} ${last!.status.state}`);
    const paused = await runBtcHistoryBackfill({ accountId: ACCOUNT, store: s2 }, depsFor(ex2, c2));
    check("…an automatic run inside the pause does nothing", paused.stoppedBecause === "SKIPPED");
    const c3 = { t: c2.t };
    const ex3 = explorer(() => w2, c3);
    const resumed = await runBtcHistoryBackfill({ accountId: ACCOUNT, store: s2, resume: true }, depsFor(ex3, c3));
    check("…operator resume clears it and completes", resumed.status.state === "COMPLETE" && sameAsTruth(s2, w2, [A]).ok);

    const w4 = makeWorld(300, { seed: 12 });
    const c4 = clockAt();
    const ex4 = explorer(() => w4, c4, { throttle: { from: 2, to: 2, retryAfterS: 60 } });
    const s4 = new MemoryStore({ addresses: [A], complete: true });
    const o4 = await runBtcHistoryBackfill({ accountId: ACCOUNT, store: s4 }, depsFor(ex4, c4, { budgetMs: 5_000 }));
    check("a backoff past the run's deadline gives up as throttled instead of overstaying", o4.failure?.code === "PROVIDER_THROTTLED" && c4.t - Date.parse(NOW_ISO) < 5_000, `${o4.failure?.code}`);
  }

  console.log("duplicate pages and a cursor the explorer ignored");
  {
    const w = makeWorld(1_500, { seed: 21, perBlock: 7 });
    const clock = clockAt();
    const ex = explorer(() => w, clock, { duplicateRows: 3 });
    const store = new MemoryStore({ addresses: [A], complete: true });
    const { last } = await runToEnd(store, () => depsFor(ex, clock, { requestBudget: 15 }));
    const cmp = sameAsTruth(store, w, [A]);
    check("rows repeated at every page boundary are deduped by block (and resumed across runs)", last.status.state === "COMPLETE" && cmp.ok && store.checkpoint()!.addresses[0].txCount === 1_500, cmp.detail);

    const w2 = makeWorld(800, { seed: 22 });
    const c2 = clockAt();
    const ex2 = explorer(() => w2, c2, { ignoreCursorAt: 6 });
    const s2 = new MemoryStore({ addresses: [A], complete: true });
    const first = await runBtcHistoryBackfill({ accountId: ACCOUNT, store: s2 }, depsFor(ex2, c2));
    check("a page that ignores the cursor adds nothing ⇒ PROVIDER_ERROR, never a double count", first.failure?.code === "PROVIDER_ERROR" && s2.checkpoint()!.addresses[0].txCount < 800, JSON.stringify(first.failure));
    const second = await runBtcHistoryBackfill({ accountId: ACCOUNT, store: s2 }, depsFor(ex2, c2));
    check("…the next run resumes and every day equals the truth", second.status.state === "COMPLETE" && sameAsTruth(s2, w2, [A]).ok && s2.checkpoint()!.addresses[0].txCount === 800);
  }

  console.log("head: new blocks, a tip reorg, and a reorg deeper than the settled top");
  {
    const w = makeWorld(400, { seed: 31 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    const before = store.checkpoint()!;
    mine(w, [A], 8, 2); // 16 new txs; the newest 5 blocks are shallow
    const head = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    const cp = store.checkpoint()!;
    check("head-only: new blocks are listed down to the settled top, verified, and the rows equal the truth",
      head.verified === true && sameAsTruth(store, w, [A]).ok && head.impactedFromISO !== null, sameAsTruth(store, w, [A]).detail);
    check("…only blocks ≥ 6 deep are settled into the checkpoint; the shallow head is re-listed each run",
      cp.addresses[0].txCount === before.addresses[0].txCount + 6 && cp.headFromISO !== null, String(cp.addresses[0].txCount - before.addresses[0].txCount));

    // Tip reorg: the two newest (shallow) blocks are replaced by a different branch.
    const cut = w.tip - 1;
    w.txs = w.txs.filter((t) => t.height < cut);
    // Rebuild the fixture's UTXO view from the surviving chain.
    w.utxo = new Map([[A, []]]);
    for (const t of w.txs) {
      for (const i of t.vin) if (i.prevout?.scriptpubkey_address === A) w.utxo.set(A, []);
      for (const o of t.vout) if (o.scriptpubkey_address === A) w.utxo.get(A)!.push({ value: o.value });
    }
    w.tip = cut - 1; w.nextHeight = cut;
    mine(w, [A], 3, 1);
    const re = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    check("a tip reorg re-verifies the head against chain_stats and rewrites the rows that relied on it",
      re.verified === true && sameAsTruth(store, w, [A]).ok, sameAsTruth(store, w, [A]).detail);

    // Deep reorg: the settled top itself disappears.
    const top = store.checkpoint()!.addresses[0].top!;
    const rowsBefore = new Map(store.rows);
    w.txs = w.txs.filter((t) => t.height < top.height - 2);
    w.utxo = new Map([[A, []]]);
    for (const t of w.txs) {
      for (const i of t.vin) if (i.prevout?.scriptpubkey_address === A) w.utxo.set(A, []);
      for (const o of t.vout) if (o.scriptpubkey_address === A) w.utxo.get(A)!.push({ value: o.value });
    }
    w.tip = top.height - 3; w.nextHeight = w.tip + 1;
    mine(w, [A], 8, 1);
    const deep = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    check("a reorg deeper than the settled top ⇒ RECOVERY_REQUIRED (HEAD_BOUNDARY_LOST), never walked across",
      deep.status.state === "RECOVERY_REQUIRED" && store.checkpoint()!.recovery?.reason === "HEAD_BOUNDARY_LOST", deep.status.state);
    check("…the rows in force are kept untouched", [...rowsBefore].every(([d, q]) => store.rows.get(d) === q) && store.rows.size === rowsBefore.size);
    const auto = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("…automatic runs skip it", auto.stoppedBecause === "SKIPPED");
    const resumed = await runBtcHistoryBackfill({ accountId: ACCOUNT, store, resume: true }, depsFor(ex, clock));
    check("…operator resume re-imports a new generation and the rows equal the new chain's truth",
      resumed.status.state === "COMPLETE" && sameAsTruth(store, w, [A]).ok && store.violations.length === 0, sameAsTruth(store, w, [A]).detail);
  }

  console.log("an unverifiable head withdraws the licence from the rows that relied on it");
  {
    const w = makeWorld(500, { seed: 33 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    mine(w, [A], 3, 2); // all shallow
    await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    const headFrom = store.checkpoint()!.headFromISO!;
    mine(w, [A], 1, 1);
    w.hidden.add(w.txs[w.txs.length - 1].txid); // listed nowhere, counted by chain_stats
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    const cov = store.coverage as { toISO: string };
    const dayBefore = new Date(Date.parse(`${headFrom}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const kept = [...truth(w, [A])].filter(([d]) => d < headFrom);
    check("the licence is withdrawn to the day before the shallow head, and those rows are deleted",
      o.verified === false && cov.toISO === dayBefore && store.rows.size === kept.length && kept.every(([d, q]) => Math.abs((store.rows.get(d) ?? NaN) - q) < 5e-9),
      `${cov.toISO} vs ${dayBefore}; rows ${store.rows.size} vs ${kept.length}`);
    check("…reported as impacted from the withdrawn day (snapshot rebuild)", o.impactedFromISO === headFrom);
    check("…and the disagreeing address is queued for a full re-list (an unstable within-block order heals there, never wedges)",
      store.checkpoint()!.addresses[0].reachedBeginning === false && store.checkpoint()!.addresses[0].txCount === 0 && store.checkpoint()!.mismatchStreak === 1);
    w.hidden.clear();
    const back = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("…and the next reconciling run re-lists it and restores the licence through today (shallow head re-verified)",
      back.verified === true && (store.coverage as { toISO: string }).toISO === TODAY && sameAsTruth(store, w, [A]).ok && store.violations.length === 0
      && store.checkpoint()!.mismatchStreak === 0, sameAsTruth(store, w, [A]).detail);
  }

  console.log("review fixes: non-monotonic block times");
  {
    // Block h+1 is stamped EARLIER than block h, across a UTC midnight, and spends h's coin.
    const w = makeWorld(0);
    const recv: FxTx = { txid: `r${"0".repeat(63)}`, height: 800_000, time: Date.parse("2026-10-20T00:10:00Z") / 1000,
      vin: [{ prevout: { scriptpubkey_address: EXT, value: 100_001_000 } }], vout: [{ scriptpubkey_address: A, value: 100_000_000 }] };
    const spend: FxTx = { txid: `s${"0".repeat(63)}`, height: 800_001, time: Date.parse("2026-10-19T23:50:00Z") / 1000,
      vin: [{ prevout: { scriptpubkey_address: A, value: 100_000_000 } }], vout: [{ scriptpubkey_address: EXT, value: 60_000_000 }, { scriptpubkey_address: A, value: 39_999_000 }] };
    w.txs = [recv, spend];
    w.tip = 800_020;
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("a spend stamped before the receipt it spends is dated by the monotone block time — no negative day, no refusal",
      o.status.state === "COMPLETE" && store.rows.get("2026-10-19") === undefined && store.rows.get("2026-10-20") === 0.39999 && sameAsTruth(store, w, [A]).ok,
      `${o.status.state} ${o.failure?.detail ?? ""} ${store.rows.get("2026-10-20")}`);
  }

  console.log("review fixes: a block landing between the listing and chain_stats is a race, not evidence");
  {
    const w = makeWorld(300, { seed: 35 });
    const clock = clockAt();
    let mineOnStats = 1;
    const ex = explorer(() => w, clock, { onStats: () => { if (mineOnStats-- > 0) mine(w, [A], 1, 1); } });
    const store = new MemoryStore({ addresses: [A], complete: true });
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("the tip is re-read after the disagreement, the head re-listed once, and the run proves",
      o.verified === true && o.status.state === "COMPLETE" && store.checkpoint()!.mismatchStreak === 0 && sameAsTruth(store, w, [A]).ok, `${o.verified} ${o.status.state}`);
    mineOnStats = 1e9; // a block lands on EVERY stats read
    let last = o;
    for (let i = 0; i < MISMATCH_RECOVERY_THRESHOLD + 1; i++) last = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    check(`…a tip that keeps moving is never counted: ${MISMATCH_RECOVERY_THRESHOLD + 1} racing runs, streak 0, no RECOVERY_REQUIRED`,
      last.verified === false && store.checkpoint()!.mismatchStreak === 0 && last.status.state !== "RECOVERY_REQUIRED", `${last.status.state} ${store.checkpoint()!.mismatchStreak}`);
    mineOnStats = 0;
    const calm = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    check("…and the first calm run proves again with rows equal to the truth", calm.verified === true && sameAsTruth(store, w, [A]).ok, sameAsTruth(store, w, [A]).detail);
    const src = readFileSync(path.join(process.cwd(), "lib/crypto/btc-history-backfill.ts"), "utf8");
    check("chain_stats are read from the SAME host as the listing (never BTC_BALANCE_API_URL)",
      !/btcBalanceBaseUrl|balanceBaseUrl/.test(src) && /\$\{explorer\}\/api\/address\/\$\{encodeURIComponent\(address\)\}`, "balance", "stats"/.test(src));
  }

  console.log("review fixes: the explorer's order within a block is not a contract");
  {
    const w = makeWorld(1_200, { seed: 37, perBlock: 9 });
    const clock = clockAt();
    const ex = explorer(() => w, clock, { reverseBlocksFrom: 4 });
    const store = new MemoryStore({ addresses: [A], complete: true });
    const { last } = await runToEnd(store, () => depsFor(ex, clock, { requestBudget: 6 }));
    check("resumed walks re-list the whole bottom block, so a reordered block never loses a transaction",
      last.status.state === "COMPLETE" && store.checkpoint()!.addresses[0].txCount === 1_200 && sameAsTruth(store, w, [A]).ok && store.checkpoint()!.mismatchStreak === 0,
      `${last.status.state} ${store.checkpoint()!.addresses[0].txCount}`);
  }

  console.log("review fixes: a large xpub proves across runs");
  {
    const many = Array.from({ length: 40 }, (_, i) => `bc1qbigxpub${String(i).padStart(3, "0")}${"q".repeat(26)}`);
    const w = makeWorld(1_600, { addresses: many, seed: 39 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: many, complete: true });
    const budget = 25; // far fewer than the 2 requests × 40 addresses one run would need to verify all
    const { runs, last } = await runToEnd(store, () => depsFor(ex, clock, { requestBudget: budget }), 200);
    check(`40 addresses at ≤ ${budget} requests per run: verification persists per address and rotates, COMPLETE after ${runs} runs`,
      last.status.state === "COMPLETE" && runs > 3 && sameAsTruth(store, w, many).ok, `${last.status.state} after ${runs}: ${sameAsTruth(store, w, many).detail}`);
    const cp = store.checkpoint()!;
    check("…every address carries its own verification", cp.addresses.every((a) => a.verifiedAtISO !== null));
    // Two days later, with new blocks stamped yesterday (10-29).
    clock.t += 2 * 86_400_000;
    w.nextTime = clock.t / 1000 - 86_400 - 6 * 3600;
    mine(w, many, 10, 1, clock.t / 1000 - 86_400);
    const lic = () => (store.coverage as { toISO: string }).toISO;
    let n = 0;
    while (lic() !== "2026-10-29" && n < 30) { await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true, requestBudget: budget })); n++; }
    check(`…the licence stays at the day before the oldest verification relied on until every address is revisited (${n} bounded head runs, least recently verified first)`,
      lic() === "2026-10-29" && n > 1, `${lic()} after ${n}`);
    check("…and the rows then equal the truth through it, the new activity included", sameAsTruth(store, w, many).ok, sameAsTruth(store, w, many).detail);
  }

  console.log("xpub: per-address proof over several derived addresses");
  {
    const addrs = [A, B, C];
    const w = makeWorld(2_400, { addresses: addrs, seed: 41 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: addrs, complete: false });
    const early = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("discovery unfinished ⇒ every address listed, but NO licence and no rows", early.verified === null && store.rows.size === 0 && store.coverage === null
      && store.checkpoint()!.addresses.every((a) => a.reachedBeginning), early.stoppedBecause);
    store.addressSet.complete = true;
    const done = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    const cmp = sameAsTruth(store, w, addrs);
    check("discovery complete ⇒ each address reconciles with its OWN chain_stats; COMPLETE", done.status.state === "COMPLETE" && done.verified === true);
    check("…every stored day equals the wallet's true end-of-day balance (internal moves net out)", cmp.ok, cmp.detail);
    const multi = confirmed(w).filter((t) => addrs.filter((a) => touches(t, a)).length > 1).length;
    check(`…transactions touching two own addresses (${multi}) are imported once per txid`, multi > 0 && importedAll(store, w, addrs).ok);

    // A newly used address joins after completion.
    const D = "bc1qfixtureaddressddddddddddddddddddddddd";
    w.utxo.set(D, []);
    const all = [...addrs, D];
    mine(w, all, 12, 2);
    store.addressSet.addresses = all;
    const joined = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("a newly used address re-opens the import and is re-proven; rows equal the truth",
      joined.status.state === "COMPLETE" && sameAsTruth(store, w, all).ok, `${joined.status.state} ${sameAsTruth(store, w, all).detail}`);
  }

  console.log("balance mismatch ⇒ no licence");
  {
    const w = makeWorld(700, { seed: 51 });
    w.hidden.add(w.txs[123].txid); // the address index omits one transaction chain_stats still counts
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("an omitted transaction makes the sums disagree with chain_stats: verified=false, no rows, no licence",
      o.verified === false && store.rows.size === 0 && store.coverage === null && o.status.state === "IMPORTING", o.status.state);
    let last = o;
    for (let i = 1; i < MISMATCH_RECOVERY_THRESHOLD; i++) last = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check(`…${MISMATCH_RECOVERY_THRESHOLD} fully-listed disagreements in a row ⇒ RECOVERY_REQUIRED (BALANCE_MISMATCH), still no rows`,
      last.status.state === "RECOVERY_REQUIRED" && store.checkpoint()!.recovery?.reason === "BALANCE_MISMATCH" && store.rows.size === 0, last.status.state);
    check("the mismatch detail names the three sums, never a guess",
      /listed funded \d+ \/ spent \d+ \/ 699 txs; chain_stats funded \d+ \/ spent \d+ \/ 700 txs/.test(store.checkpoint()!.recovery!.detail), store.checkpoint()!.recovery!.detail);
  }

  console.log("empty address");
  {
    const w = makeWorld(0);
    w.tip = 868_000; w.nextHeight = 868_001; w.nextTime = Date.parse(NOW_ISO) / 1000 - 5 * 3600;
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    const o = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    check("no confirmed activity and chain_stats zero ⇒ COMPLETE, licensed through yesterday only, no rows (absent, never zero-filled)",
      o.status.state === "COMPLETE" && store.rows.size === 0 && JSON.stringify(store.coverage) === JSON.stringify({ kind: "COMPLETE", fromISO: YESTERDAY, toISO: YESTERDAY, source: BTC_CHAIN_STATS_SOURCE }), o.status.state);
    check("…in three requests (tip, one empty page, chain_stats)", ex.counts.all === 3, String(ex.counts.all));
    w.utxo.set(A, []);
    w.nextTime = Date.parse(NOW_ISO) / 1000 - 30 * 3600; // yesterday
    for (let i = 0; i < 12; i++) { w.nextTime += 60; addTx(w, [A], "receive"); }
    w.tip = w.nextHeight + 10;
    const later = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    check("…later activity on it is picked up by a head-only sync and the rows equal the truth", later.verified === true && store.rows.size === 1 && sameAsTruth(store, w, [A]).ok, sameAsTruth(store, w, [A]).detail);
  }

  console.log("legacy history preserved until the replacement is proven, then promoted atomically");
  {
    const w = makeWorld(2_000, { seed: 61 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    const t = truth(w, [A]);
    const dates = [...t.keys()];
    // The wholesale path licensed only its last 1,000 transactions' days — and one of its days is wrong.
    const legacyFrom = dates[Math.floor(dates.length / 2)];
    const legacyRows = new Map([...t].filter(([d]) => d >= legacyFrom && d <= TODAY).map(([d, q]) => [d, q]));
    legacyRows.set(dates[dates.length - 3], (legacyRows.get(dates[dates.length - 3]) ?? 0) + 0.5);
    store.legacyValue = { fromISO: legacyFrom, toISO: TODAY, rows: legacyRows };
    for (const [d, q] of legacyRows) store.rows.set(d, q);
    store.coverage = { kind: "COMPLETE", fromISO: legacyFrom, toISO: TODAY, source: "btc-ledger+balance-reconciliation" };
    const snapshotRows = JSON.stringify([...store.rows]);
    const snapshotCov = JSON.stringify(store.coverage);
    const r1 = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { requestBudget: 30 }));
    check("while importing (STAGING) the legacy rows and licence are exactly as they were",
      r1.status.state === "IMPORTING" && r1.status.legacyInForce && JSON.stringify([...store.rows]) === snapshotRows && JSON.stringify(store.coverage) === snapshotCov, r1.status.state);
    const commitsBefore = store.replaceAllCommits;
    const { last } = await runToEnd(store, () => depsFor(ex, clock, { requestBudget: 30 }));
    const cmp = sameAsTruth(store, w, [A]);
    check("the first proof replaces the legacy history in ONE commit (replaceAll) and the rows equal the truth",
      last.status.state === "COMPLETE" && store.replaceAllCommits === commitsBefore + 1 && cmp.ok && store.violations.length === 0, cmp.detail);
    check("…the licence is now the proven one, from the first transaction", JSON.stringify(store.coverage) === JSON.stringify({ kind: "COMPLETE", fromISO: dates[0], toISO: YESTERDAY, source: BTC_CHAIN_STATS_SOURCE }));
    check("…and the legacy discrepancy is disclosed (1 day), not hidden", JSON.stringify(last.status.legacyDiscrepancy) === JSON.stringify({ days: 1, firstISO: dates[dates.length - 3] }), JSON.stringify(last.status.legacyDiscrepancy));
    check("…with the replaced legacy interval reported as impacted (snapshot rebuild)", last.impactedFromISO !== null && last.impactedFromISO <= dates[0]);
  }

  console.log("compare-and-swap: concurrent runs");
  {
    const w = makeWorld(900, { seed: 71 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { requestBudget: 5 }));
    const [x, y] = await Promise.all([
      runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { requestBudget: 8 })),
      runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { requestBudget: 8 })),
    ]);
    check("two runs from the same checkpoint: exactly one advances, the other stops on CONFLICT",
      [x, y].filter((o) => o.stoppedBecause === "CONFLICT").length === 1, `${x.stoppedBecause} ${y.stoppedBecause}`);
    const { last } = await runToEnd(store, () => depsFor(ex, clock));
    check("…and the history still completes exactly, each transaction once", last.status.state === "COMPLETE" && sameAsTruth(store, w, [A]).ok && store.checkpoint()!.addresses[0].txCount === 900);
  }

  console.log("idempotent re-run");
  {
    const w = makeWorld(300, { seed: 81 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const store = new MemoryStore({ addresses: [A], complete: true });
    await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock));
    const rows = JSON.stringify([...store.rows]);
    const again = await runBtcHistoryBackfill({ accountId: ACCOUNT, store }, depsFor(ex, clock, { headOnly: true }));
    check("a head-only re-run with no new activity verifies, writes no rows and reports nothing impacted",
      again.verified === true && again.rowsWritten === 0 && again.impactedFromISO === null && JSON.stringify([...store.rows]) === rows);
  }

  console.log("pure pieces");
  {
    const p = pointFromTransaction({ txid: "t", vin: [{ prevout: { scriptpubkey_address: A, value: 700 } }, { prevout: null }], vout: [{ scriptpubkey_address: A, value: 300 }, { scriptpubkey_address: EXT, value: 350 }],
      status: { confirmed: true, block_height: 10, block_time: Date.parse("2026-01-02T05:00:00Z") / 1000 } }, A);
    check("a spend with change: funded = change, spent = the address's inputs (coinbase input ignored)", p.funded === BigInt(300) && p.spent === BigInt(700) && p.dateISO === "2026-01-02");
    let threw = false;
    try { pointFromTransaction({ txid: "u", vin: [], vout: [], status: { confirmed: false } }, A); } catch { threw = true; }
    check("an unconfirmed transaction in the chain listing is refused, not counted", threw);
    const closes = dailyClosings(new Map([["2026-01-03", BigInt(5)], ["2026-01-01", BigInt(10)]]), "2025-12-30", "2026-01-04");
    check("closings: absent before the first transaction, running sums after (never zero-filled)",
      JSON.stringify(closes.map((c) => [c.dateISO, Number(c.sats)])) === JSON.stringify([["2026-01-01", 10], ["2026-01-02", 10], ["2026-01-03", 15], ["2026-01-04", 15]]));
    check("stats mismatch reports all three sums", statsMismatch({ funded: BigInt(1), spent: BigInt(0), txCount: 1 }, { funded: BigInt(1), spent: BigInt(0), txCount: 1 }) === null
      && statsMismatch({ funded: BigInt(1), spent: BigInt(0), txCount: 1 }, { funded: BigInt(1), spent: BigInt(0), txCount: 2 }) !== null);
    check("status of no checkpoint is QUEUED", backfillStatus(null).state === "QUEUED");
    check("a foreign or malformed checkpoint is no checkpoint", parseCheckpoint('{"r":3,"c":0}', ACCOUNT) === null && parseCheckpoint("{", ACCOUNT) === null
      && parseCheckpoint(JSON.stringify({ kind: "sol-history", v: 1 }), ACCOUNT) === null);
    check("syncs are head-only, 15 s, only while the worker carries Bitcoin",
      btcSyncHeadOnly({ SOL_BACKFILL_ENABLED: "true" }) && !btcSyncHeadOnly({ SOL_BACKFILL_ENABLED: "true", BTC_BACKFILL_ENABLED: "false" }) && !btcSyncHeadOnly({})
      && btcSyncRunBudgetMs({ SOL_BACKFILL_ENABLED: "true" }) === 15_000 && btcSyncRunBudgetMs({}) === 45_000);
  }

  console.log("the inline import's page budget is no longer a silent truncation");
  {
    const w = makeWorld(1_010, { seed: 91 });
    const clock = clockAt();
    const ex = explorer(() => w, clock);
    const prev = process.env.BTC_EXPLORER_BASE_URL;
    process.env.BTC_EXPLORER_BASE_URL = "https://esplora.test";
    const big = await fetchAddressTxsRawPaged(A, ex.fetchImpl);
    const w2 = makeWorld(990, { seed: 92 });
    const small = await fetchAddressTxsRawPaged(A, explorer(() => w2, clock).fetchImpl);
    const head = await fetchAddressTxsRawPaged(A, ex.fetchImpl, { pageBudget: 1 });
    if (prev === undefined) delete process.env.BTC_EXPLORER_BASE_URL; else process.env.BTC_EXPLORER_BASE_URL = prev;
    check("1,010 txs: 1,000 listed and truncated=true (the sync hands the wallet to the resumable backfill)", big.txs.length === 1_000 && big.truncated);
    check("990 txs: all listed, truncated=false (wholesale path unchanged)", small.txs.length === 990 && !small.truncated);
    check("a one-page head listing reports truncation too", head.txs.length === 25 && head.truncated);
  }

  console.log("the worker carries Bitcoin in the same job");
  {
    const cfg = { ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }) };
    const btcCfg = btcWorkerConfig({ SOL_BACKFILL_ENABLED: "true" });
    check("BTC worker: on with the worker, off with BTC_BACKFILL_ENABLED=false; 4 req/s, 20k requests/day by default",
      btcCfg.enabled && !btcWorkerConfig({ SOL_BACKFILL_ENABLED: "true", BTC_BACKFILL_ENABLED: "false" }).enabled && !btcWorkerConfig({}).enabled
      && btcCfg.maxRequestsPerSecond === 4 && btcCfg.dailyRequestCap === 20_000);
    const cpOf = (over: Partial<BtcBackfillCheckpoint>) => JSON.stringify({ ...parseCheckpoint(JSON.stringify({
      kind: "btc-history", v: 1, accountId: "x", addresses: [], verifyCursor: 0, dirtyFromISO: null, provenOnce: false, licensedFromISO: null, licensedToISO: null,
      headFromISO: null, headVerifiedAtISO: null, headUnverifiedSinceISO: null, mismatchStreak: 0, recovery: null, failures: 0, lastFailure: null,
      txsProcessed: 0, startedAtISO: NOW_ISO, lastProgressAtISO: null, completedAtISO: null }), "x"), ...over });
    const ordered = orderBtcCandidates([
      { accountId: "recent", connectionId: "c1", cursor: null, checkpoint: { ...JSON.parse(cpOf({ txsProcessed: 5, lastProgressAtISO: "2026-10-28T09:00:00Z" })), accountId: "recent" } },
      { accountId: "new", connectionId: "c2", cursor: null, checkpoint: null },
      { accountId: "stale", connectionId: "c3", cursor: null, checkpoint: { ...JSON.parse(cpOf({ txsProcessed: 5, lastProgressAtISO: "2026-10-27T09:00:00Z" })), accountId: "stale" } },
      { accountId: "gap", connectionId: "c4", cursor: null, checkpoint: { ...JSON.parse(cpOf({ recovery: { reason: "BALANCE_MISMATCH", address: A, detail: "", detectedAtISO: NOW_ISO } })), accountId: "gap" } },
    ], Date.parse(NOW_ISO));
    check("fair order: never progressed, then least recently progressed; recovery skipped", ordered.map((r) => r.accountId).join(",") === "new,stale,recent", ordered.map((r) => r.accountId).join(","));
    const done = (verifiedAtISO: string) => ({ ...JSON.parse(cpOf({ txsProcessed: 5, provenOnce: true, completedAtISO: NOW_ISO, licensedFromISO: "2026-01-01", licensedToISO: YESTERDAY,
      addresses: [{ address: A, top: null, bottom: null, reachedBeginning: true, funded: "0", spent: "0", txCount: 0, blocks: [], verifiedAtISO }] })), accountId: "d" });
    const nowMs = Date.parse(NOW_ISO);
    check("a COMPLETE wallet is a worker candidate (rate-limited) only while a verification is stale or missing",
      orderBtcCandidates([{ accountId: "d", connectionId: "c", cursor: null, checkpoint: done(new Date(nowMs - 7 * 3600_000).toISOString()) }], nowMs).length === 1
      && orderBtcCandidates([{ accountId: "d", connectionId: "c", cursor: null, checkpoint: done(new Date(nowMs - 3600_000).toISOString()) }], nowMs).length === 0);

    // End to end: one SOL wallet with work, two BTC wallets; real BTC runs against the fake explorer.
    const DAY = TODAY;
    let t = Date.parse(`${DAY}T10:00:00Z`);
    const locks = new Map<string, number>();
    const log: string[] = [];
    const worlds = { b1: makeWorld(1_500, { seed: 101 }), b2: makeWorld(400, { seed: 102 }) } as Record<string, World>;
    const stores = { b1: new MemoryStore({ addresses: [A], complete: true }, "b1"), b2: new MemoryStore({ addresses: [A], complete: true }, "b2") } as Record<string, MemoryStore>;
    const clk = { get t() { return t; }, set t(v: number) { t = v; } };
    const deps: SolBackfillJobDeps = {
      now: () => t, sleep: async (ms) => { t += ms; },
      wakeStartedAt: async () => null,
      wallets: async () => [{ accountId: "s1", connectionId: "c-s1", address: "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN", cursor: null }],
      claimLock: async (c, s) => { if (locks.has(c)) return false; locks.set(c, s); return true; },
      renewLock: async (c, f, to) => { if (locks.get(c) !== f) return false; locks.set(c, to); return true; },
      releaseLock: async (c, s) => { if (locks.get(c) === s) locks.delete(c); else log.push(`release-refused:${c}`); },
      reconstruct: async ({ accountId, deps: d }) => {
        log.push(`sol:${accountId}:${Math.round((d?.budgetMs ?? 0) / 1000)}`); t += 5_000;
        return { accountId, ok: true, derivedRowsWritten: 0, mode: "NO_CHANGE", impactedFromISO: null,
          backfill: { status: { state: "IMPORTING" } as never, progressed: true, rowsWritten: 0, impactedFromISO: null, signaturesProcessed: 1, pagesFetched: 1, stoppedBecause: "BUDGET", failure: null } };
      },
      store: async () => null,
      regenerationEnabled: () => true,
      regenerate: async (id) => { t += 1_000; log.push(`regen:${id}`); },
      btc: {
        wallets: async () => Object.keys(stores).map((id) => ({ accountId: id, connectionId: `c-${id}`, cursor: stores[id].cursor })),
        reconstruct: async ({ accountId, deps: d }): Promise<BtcResumableResult> => {
          log.push(`btc:${accountId}`);
          const ex = explorer(() => worlds[accountId], clk);
          const o = await runBtcHistoryBackfill({ accountId, store: stores[accountId] }, { ...depsFor(ex, clk), ...d });
          return { accountId, ok: true, derivedRowsWritten: o.rowsWritten, mode: o.impactedFromISO ? "INCREMENTAL" : "NO_CHANGE", impactedFromISO: o.impactedFromISO, backfill: o };
        },
        store: async (id) => stores[id],
      },
    };
    const s = await solHistoryBackfill({ config: cfg, btcConfig: btcCfg, deps });
    check("both chains run in one job; Solana is planned to half the budget while Bitcoin waits",
      log[0] === `sol:s1:${Math.round((cfg.jobBudgetMs / 2 - 60_000 / 2) / 1000)}` && log.includes("btc:b1") && log.includes("btc:b2"), log.join(","));
    check("Bitcoin's requests are metered and rate-limited separately", (s.btc?.requests.total ?? 0) > 0 && s.btc?.dailyRequestCap === 20_000, JSON.stringify(s.btc?.requests));
    check("BTC wallets are regenerated over the rows they changed, under their locks (all released)",
      log.includes("regen:b1") && log.includes("regen:b2") && locks.size === 0 && !log.some((x) => x.startsWith("release-refused")), log.join(","));
    check("…and finished wallets equal their truth", stores.b2.checkpoint() !== null && sameAsTruth(stores.b2, worlds.b2, [A]).ok && sameAsTruth(stores.b1, worlds.b1, [A]).ok,
      `${sameAsTruth(stores.b1, worlds.b1, [A]).detail} ${sameAsTruth(stores.b2, worlds.b2, [A]).detail}`);
    check("the job's deferred count covers both chains (self-continuation)", s.deferred >= 1);
    const broken = await solHistoryBackfill({ config: cfg, btcConfig: btcCfg, deps: { ...deps, btc: { ...deps.btc!, wallets: async () => { throw new Error('column "historyCheckpoint" does not exist'); } } } });
    check("a failing BTC listing (e.g. migration not yet applied) never takes the Solana pass down", broken.walletsRun === 1 && broken.btc?.eligible === 0, JSON.stringify({ r: broken.walletsRun, e: broken.btc?.eligible }));
    const s2 = await solHistoryBackfill({ config: cfg, btcConfig: btcCfg, deps: { ...deps, wallets: async () => [] } });
    check("a second wake with no SOL work and COMPLETE BTC wallets is NO_WORK", s2.stoppedBecause === "NO_WORK" && s2.btc?.stoppedBecause === "NO_WORK" && s2.btc.eligible === 0, JSON.stringify({ a: s2.stoppedBecause, b: s2.btc?.stoppedBecause, e: s2.btc?.eligible }));
  }

  console.log("wiring (source pins)");
  {
    const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
    const refresh = read("lib/crypto/wallet-history-refresh.ts");
    check("the wallet refresh routes BTC to the resumable backfill when it owns the history (head-only with the worker)",
      /BTC_NATIVE\.chain \? \(a: [^)]*\) => reconstructBtcHistoryOrResumable\(\{ \.\.\.a, client: db, headOnly: btcSyncHeadOnly\(\) \}\)/.test(refresh));
    const storeSrc = read("lib/crypto/btc-history-backfill.store.ts");
    check("…otherwise the wholesale reconstruction, unchanged", /return reconstructBtcHistory\(\{ accountId: args\.accountId, windowFromISO/.test(storeSrc));
    check("the store writes only DERIVED rows of its source (OBSERVED rows are never deleted)",
      /origin: PositionOrigin\.DERIVED, source: BTC_RECONSTRUCTION_SOURCE \};/.test(storeSrc) && !/origin: PositionOrigin\.OBSERVED/.test(storeSrc));
    check("…and imports Transaction rows through the ONE writer (btc-sync's persistBtcRawTxs) inside the CAS transaction",
      /casHistoryCheckpoint\(tx, connectionId, c\.expectedCursor, c\.nextCursor\)/.test(storeSrc) && /persistBtcRawTxs\(tx,/.test(storeSrc));
    const ck = read("lib/crypto/btc-history-checkpoint.ts");
    check("the checkpoint lives on Connection.historyCheckpoint, never Connection.cursor (xpub discovery's)",
      /"historyCheckpoint" IS NOT DISTINCT FROM/.test(ck) && !/SET "cursor"/.test(ck));
    const sync = read("lib/crypto/btc-sync.ts");
    check("the sync hands a truncated import to the resumable backfill, and lists one page once it owns the history",
      /if \(truncated && !owned\)/.test(sync) && /enqueueBtcHistoryBackfill\(db, account\.id\)/.test(sync) && /pageBudget: BTC_SYNC_HEAD_PAGES/.test(sync));
    const wholesale = read("lib/crypto/btc-history-sync.ts");
    check("the wholesale path refuses when the resumable licence is in force", /RESUMABLE_HISTORY_IN_FORCE/.test(wholesale));
    const mig = read("prisma/migrations/20261028120000_connection_history_checkpoint/migration.sql");
    check("the migration is one additive nullable column", /^ALTER TABLE "Connection" ADD COLUMN "historyCheckpoint" TEXT;$/m.test(mig) && (mig.match(/^[A-Z]/gm) ?? []).length === 1);
  }

  console.log(`\nbtc-history-resumable: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
