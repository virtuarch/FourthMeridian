/**
 * lib/crypto/spl-history.test.ts
 *
 * SPL token history against a deterministic in-memory chain: no network, no
 * database. Every scenario compares the stored rows with the chain's TRUE
 * end-of-day token balances, day by day — and every refusal with "no rows".
 *
 *   npx tsx lib/crypto/spl-history.test.ts
 */

import {
  runSplTokenHistory, createSplDiscoveryCollector, annotateWithDiscoveries,
  type SplHistoryStore, type SplCommit,
} from "@/lib/crypto/spl-history";
import {
  parseSplState, mintExtensionVerdict, attributedRaw, stateKey, splWorkOwed, discoverOwnedTokenAccounts,
  tokenPointFromTransaction, mergeDiscovered, freshSplState, MAX_TRACKED_ACCOUNTS, HEAD_MISMATCH_LIMIT,
  SPL_CONTINUITY_SOURCE, type SplHistoryState,
} from "@/lib/crypto/spl-history.core";
import {
  runSolHistoryBackfill, buildRpcCall, CheckpointConflictError,
  type SolBackfillStore, type SolBackfillCommit, type SolRpcCall,
} from "@/lib/crypto/sol-history-backfill";
import { emptyCheckpoint, serializeCheckpoint, parseCheckpoint, type SolBackfillCheckpoint, type SolTxForProof } from "@/lib/crypto/sol-history-backfill.core";
import { orderCandidates } from "@/lib/crypto/sol-backfill-worker.core";
import { walletHistoryComplete, facetFromCoverage } from "@/lib/crypto/wallet-instrument-history";
import { splInventoryCompleteFromCursor } from "@/lib/crypto/spl-history-inventory";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@/lib/crypto/token-asset";
import { tokenHistoryText, tokenUnverifiedReason } from "@/lib/connections/connection-detail.core";
import { planTokenPriceRequest } from "@/lib/prices/token-history-prices";
import { fetchCoinGeckoTokenDailyClosesUsd, parseMarketChartCloses } from "@/lib/prices/providers/coingecko";
import type { ChainCoverage } from "@/lib/crypto/chain-movement";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const OWNER = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";   // case-significant base58
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";   // Token-2022 (transferFeeConfig in fixture)
const YIELD = "YiE1dBearingMint1111111111111111111111111111";   // Token-2022 interest-bearing (fixture)
const SPAM = "SpamMint11111111111111111111111111111111111";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = "2026-10-28";

// ── A deterministic token ledger ─────────────────────────────────────────────

interface Acc { mint: string; owner: string; amount: bigint; program: string; decimals: number }
interface FixtureTx { signature: string; slot: number; blockTime: number; keys: string[]; view: unknown; endState: Map<string, Acc | null> }

class Chain {
  state = new Map<string, Acc | null>();
  txs: FixtureTx[] = [];
  /** Signatures the address index does NOT list for an address (ALT-style hazard). */
  hidden = new Map<string, Set<string>>();
  private n = 0;
  private slot = 200_000_000;
  tx(dayISO: string, hour: number, keys: string[], mutate: (s: Map<string, Acc | null>) => void): string {
    const entries = (side: Map<string, Acc | null>) => keys.flatMap((k, i) => {
      const a = side.get(k);
      return a ? [{ accountIndex: i, mint: a.mint, owner: a.owner, programId: a.program, uiTokenAmount: { amount: a.amount.toString(), decimals: a.decimals, uiAmount: null } }] : [];
    });
    const pre = entries(this.state);
    mutate(this.state);
    const post = entries(this.state);
    const signature = `tx${String(this.n++).padStart(5, "0")}`;
    const blockTime = Math.floor(Date.parse(`${dayISO}T${String(hour).padStart(2, "0")}:00:00Z`) / 1000);
    this.slot += 5;
    const view = { slot: this.slot, blockTime,
      transaction: { message: { accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: true, source: "transaction" })) } },
      meta: { err: null, fee: 5000, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), preTokenBalances: pre, postTokenBalances: post } };
    this.txs.push({ signature, slot: this.slot, blockTime, keys, view, endState: new Map(this.state) });
    return signature;
  }
  create(acct: string, mint: string, opts: { owner?: string; program?: string; decimals?: number } = {}) {
    return (s: Map<string, Acc | null>) => s.set(acct, { mint, owner: opts.owner ?? OWNER, amount: BigInt(0), program: opts.program ?? SPL_TOKEN_PROGRAM_ID, decimals: opts.decimals ?? 6 });
  }
  hide(address: string, signature: string) { (this.hidden.get(address) ?? this.hidden.set(address, new Set()).get(address)!).add(signature); }
  /** The wallet's true raw amount of `mint` at the end of `dayISO`. */
  truth(mint: string, dayISO: string): bigint {
    let st: Map<string, Acc | null> = new Map();
    for (const t of this.txs) if (new Date(t.blockTime * 1000).toISOString().slice(0, 10) <= dayISO) st = t.endState;
    let sum = BigInt(0);
    for (const a of st.values()) if (a && a.owner === OWNER && a.mint === mint) sum += a.amount;
    return sum;
  }
  current(program: string) {
    const value = [...this.state.entries()].filter(([, a]) => a && a.owner === OWNER && a.program === program).map(([pubkey, a]) => ({
      pubkey, account: { data: { parsed: { info: { mint: a!.mint, owner: OWNER, tokenAmount: { amount: a!.amount.toString(), decimals: a!.decimals } } } } },
    }));
    return { value };
  }
}

const mv = (acct: string, delta: number) => (s: Map<string, Acc | null>) => { const a = s.get(acct)!; s.set(acct, { ...a, amount: a.amount + BigInt(delta) }); };
const close = (acct: string) => (s: Map<string, Acc | null>) => { s.set(acct, null); };
const all = (...fs: Array<(s: Map<string, Acc | null>) => void>) => (s: Map<string, Acc | null>) => fs.forEach((f) => f(s));

/** The fixture RPC — getTokenAccountsByOwner / getAccountInfo / getSignaturesForAddress / getTransaction. */
function fixtureRpc(chain: Chain, opts: { mintExtensions?: Record<string, string[]>; overrideCurrent?: (program: string) => unknown } = {}): SolRpcCall {
  return async (method, params) => {
    if (method === "getTokenAccountsByOwner") {
      const program = (params[1] as { programId: string }).programId;
      return opts.overrideCurrent ? opts.overrideCurrent(program) : chain.current(program);
    }
    if (method === "getAccountInfo") {
      const ext = opts.mintExtensions?.[params[0] as string] ?? [];
      return { value: { data: { parsed: { type: "mint", info: { extensions: ext.map((e) => ({ extension: e, state: {} })) } } } } };
    }
    if (method === "getSignaturesForAddress") {
      const addr = params[0] as string;
      const o = params[1] as { before?: string; until?: string; limit: number };
      const hidden = chain.hidden.get(addr) ?? new Set<string>();
      let list = chain.txs.filter((t) => t.keys.includes(addr) && !hidden.has(t.signature)).sort((a, b) => b.slot - a.slot);
      if (o.before) { const i = list.findIndex((t) => t.signature === o.before); list = i >= 0 ? list.slice(i + 1) : list; }
      if (o.until) { const i = list.findIndex((t) => t.signature === o.until); list = i >= 0 ? list.slice(0, i) : list; }
      return list.slice(0, o.limit).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null }));
    }
    if (method === "getTransaction") {
      const t = chain.txs.find((x) => x.signature === params[0]);
      return t ? t.view : null;
    }
    throw new Error(`unexpected method ${method}`);
  };
}

/** A native checkpoint whose history is COMPLETE (token history needs native first). */
function nativeCursor(extra: Partial<SolBackfillCheckpoint> = {}): string {
  const p = { signature: "native1", slot: 1, blockTime: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000), dateISO: "2026-09-01", preLamports: "0", postLamports: "5000000" };
  return serializeCheckpoint({ ...emptyCheckpoint("acct_sol", OWNER, "2026-09-01T00:00:00Z"), top: p, bottom: p, reachedBeginning: true,
    licensedFromISO: "2026-09-01", licensedToISO: TODAY, completedAtISO: "2026-09-02T00:00:00Z", mode: "DIRECT", ...extra });
}

interface MemStore extends SplHistoryStore {
  rows: Map<string, Map<string, number>>;
  coverage: Map<string, ChainCoverage>;
  commits: SplCommit[];
  priceCalls: Array<{ mint: string; fromISO: string; toISO: string }>;
  cursor(): string | null;
}
function memStore(initial: string | null, priced: ReadonlySet<string> = new Set()): MemStore {
  let cursor = initial;
  const rows = new Map<string, Map<string, number>>();
  const coverage = new Map<string, ChainCoverage>();
  const commits: SplCommit[] = [];
  const priceCalls: MemStore["priceCalls"] = [];
  return {
    rows, coverage, commits, priceCalls, cursor: () => cursor,
    async readCursor() { return cursor; },
    async commit(c) {
      if (c.expectedCursor !== cursor) throw new CheckpointConflictError();
      cursor = c.nextCursor;
      commits.push(c);
      const m = c.mint;
      if (!m) return;
      let r = rows.get(m.mint) ?? new Map<string, number>();
      if (m.replaceAll) r = new Map();
      if (m.deleteBeforeISO) for (const d of [...r.keys()]) if (d < m.deleteBeforeISO) r.delete(d);
      if (m.deleteFromISO && m.deleteToISO) for (const d of [...r.keys()]) if (d >= m.deleteFromISO && d <= m.deleteToISO) r.delete(d);
      for (const x of m.rows) r.set(x.dateISO, x.quantity);
      rows.set(m.mint, r);
      coverage.set(m.mint, m.coverage);
    },
    async pricedMints(mints) { return new Set(mints.filter((m) => priced.has(m))); },
    async acquirePrices(m) { priceCalls.push({ mint: m.mint, fromISO: m.fromISO, toISO: m.toISO }); return { inserted: 0, earliestISO: null }; },
  };
}

function runOnce(chain: Chain, store: MemStore, opts: { requestBudget?: number; headOnly?: boolean; freshSource?: "NATIVE" | "WALK"; discovered?: ReturnType<typeof discoverOwnedTokenAccounts>; rpc?: SolRpcCall; nowMs?: number } = {}) {
  const meter: Record<string, number> = {};
  const now = () => opts.nowMs ?? NOW;
  const call = buildRpcCall({ call: opts.rpc ?? fixtureRpc(chain), meter }, now() + 60_000);
  const sent = () => Object.values(meter).reduce((a, b) => a + b, 0);
  return runSplTokenHistory({ owner: OWNER, store, headOnly: opts.headOnly, freshSource: opts.freshSource, discovered: opts.discovered },
    { call, deadlineMs: now() + 60_000, now, sent, requestBudget: opts.requestBudget, concurrency: 2 }).then((o) => ({ o, meter }));
}

function stateOf(store: MemStore): SplHistoryState {
  return parseSplState((JSON.parse(store.cursor()!) as { tokens?: unknown }).tokens)!;
}

/** Every licensed day's stored quantity equals the chain's truth; no row outside the licence. */
function rowsMatchTruth(chain: Chain, store: MemStore, mint: string, decimals: number): { ok: boolean; detail: string } {
  const cov = store.coverage.get(mint);
  const r = store.rows.get(mint) ?? new Map();
  if (!cov || cov.kind === "UNKNOWN") return { ok: r.size === 0, detail: `no licence, ${r.size} rows` };
  const from = cov.kind === "COMPLETE" ? cov.fromISO : cov.coveredFromISO!;
  const to = cov.kind === "COMPLETE" ? cov.toISO : cov.coveredToISO!;
  for (const d of r.keys()) if (d < from || d > to) return { ok: false, detail: `row ${d} outside ${from}..${to}` };
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    const want = Number(chain.truth(mint, d)) / 10 ** decimals;
    if (r.get(d) === undefined || Math.abs((r.get(d) ?? -1) - want) > 1e-9) return { ok: false, detail: `${d}: stored ${r.get(d)} truth ${want}` };
  }
  return { ok: true, detail: `${r.size} rows ${from}..${to}` };
}

async function main() {
  // ══ 1. MULTIPLE ACCOUNTS PER MINT, an incoming transfer the owner did not sign ══
  console.log("multiple accounts per mint");
  {
    const c = new Chain();
    const ata = "AtaUsdc1111111111111111111111111111111111111", aux = "AuxUsdc1111111111111111111111111111111111111";
    c.tx("2026-10-02", 9, [OWNER, ata], c.create(ata, USDC));
    c.tx("2026-10-03", 9, [OTHER, ata], mv(ata, 5_000_000));             // incoming: owner NOT a key, not a signer
    c.tx("2026-10-05", 9, [OWNER, aux], c.create(aux, USDC));
    c.tx("2026-10-06", 9, [OWNER, ata, aux], all(mv(ata, -2_000_000), mv(aux, 2_000_000)));
    c.tx("2026-10-06", 15, [OTHER, aux], mv(aux, 1_250_000));
    c.tx("2026-10-20", 9, [OWNER, ata, OTHER], mv(ata, -500_000));
    const store = memStore(nativeCursor(), new Set([USDC]));
    const { o, meter } = await runOnce(c, store, { freshSource: "NATIVE" });
    const cov = store.coverage.get(USDC);
    check("USDC is COMPLETE from its first account's creation day", cov?.kind === "COMPLETE" && cov.fromISO === "2026-10-02" && cov.toISO === TODAY && cov.source === SPL_CONTINUITY_SOURCE, JSON.stringify(cov));
    const m = rowsMatchTruth(c, store, USDC, 6);
    check("two accounts summed per day equal the chain's true end-of-day balance, every day", m.ok, m.detail);
    check("the incoming transfer the owner never signed is in the history (account-indexed, 6.25 on Oct 6)", store.rows.get(USDC)?.get("2026-10-06") === 6.25, String(store.rows.get(USDC)?.get("2026-10-06")));
    check("the outcome reports rows and the earliest impacted day (snapshot regeneration input)", o.rowsWritten === 27 && o.impactedFromISO === "2026-10-02", `${o.rowsWritten} ${o.impactedFromISO}`);
    check("historical prices are requested for the PRICED mint over its licence", store.priceCalls.length === 1 && store.priceCalls[0].fromISO === "2026-10-02");
    // Request cost: 2 anchors + per account (1 sig page + 1 head page) + one getTransaction per distinct signature (cache).
    check("request cost is the anchor + one signature page per account + each transaction once", meter.getTokenAccountsByOwner === 2 && meter.getSignaturesForAddress === 2 && meter.getTransaction === 6, JSON.stringify(meter));
    const st = stateOf(store);
    check("inventory is complete (NATIVE discovery done, every mint COMPLETE)", st.inventoryComplete === true && splInventoryCompleteFromCursor(store.cursor()) === true);
    // A second run with new activity only extends the head.
    c.tx("2026-10-28", 11, [OTHER, ata], mv(ata, 1_000_000));
    const r2 = await runOnce(c, store, { headOnly: true });
    const m2 = rowsMatchTruth(c, store, USDC, 6);
    check("a head-only run extends the licence with the new activity (rows still equal truth)", m2.ok && r2.o.rowsWritten === 1, `${m2.detail} rows ${r2.o.rowsWritten}`);
    check("…and spends no getTransaction on history it already proved", r2.meter.getTransaction === 1, JSON.stringify(r2.meter));
  }

  // ══ 2. CREATED, CLOSED, RE-CREATED at the same address; closed mint found by WALK ══
  console.log("created → closed → re-created; discovery of a closed account");
  {
    const c = new Chain();
    const ata = "AtaBonk1111111111111111111111111111111111111";
    const gone = "GoneUsdc111111111111111111111111111111111111";
    c.tx("2026-10-01", 9, [OWNER, ata], c.create(ata, BONK, { decimals: 5 }));
    c.tx("2026-10-02", 9, [OTHER, ata], mv(ata, 700_000));
    c.tx("2026-10-04", 9, [OWNER, ata, OTHER], mv(ata, -700_000));
    c.tx("2026-10-04", 10, [OWNER, ata], close(ata));
    c.tx("2026-10-10", 9, [OWNER, ata], c.create(ata, BONK, { decimals: 5 }));
    c.tx("2026-10-11", 9, [OTHER, ata], mv(ata, 300_000));
    // A USDC account opened and fully closed — no current trace at all.
    c.tx("2026-10-12", 9, [OWNER, gone], c.create(gone, USDC));
    c.tx("2026-10-13", 9, [OTHER, gone], mv(gone, 9_000_000));
    c.tx("2026-10-15", 9, [OWNER, gone, OTHER], mv(gone, -9_000_000));
    c.tx("2026-10-15", 10, [OWNER, gone], close(gone));
    const store = memStore(nativeCursor(), new Set([USDC, BONK]));
    await runOnce(c, store, { freshSource: "WALK" });
    const st = stateOf(store);
    check("the WALK found the closed USDC account from the owner's own transactions", st.discovery.walkDone && st.accounts.some((a) => a.address === gone));
    const bonk = rowsMatchTruth(c, store, BONK, 5);
    check("re-created account: COMPLETE across its closure, zero while closed", store.coverage.get(BONK)?.kind === "COMPLETE" && bonk.ok
      && store.rows.get(BONK)?.get("2026-10-07") === 0 && store.rows.get(BONK)?.get("2026-10-11") === 3, bonk.detail);
    const usdc = rowsMatchTruth(c, store, USDC, 6);
    check("closed account: COMPLETE, 9 on Oct 13–14, 0 after closure", store.coverage.get(USDC)?.kind === "COMPLETE" && usdc.ok
      && store.rows.get(USDC)?.get("2026-10-14") === 9 && store.rows.get(USDC)?.get("2026-10-20") === 0, usdc.detail);
  }

  // ══ 3. TOKEN-2022 ════════════════════════════════════════════════════════════
  console.log("Token-2022");
  {
    const c = new Chain();
    const a1 = "AtaPyusd111111111111111111111111111111111111", a2 = "AtaYield111111111111111111111111111111111111";
    c.tx("2026-10-03", 9, [OWNER, a1], c.create(a1, PYUSD, { program: TOKEN_2022_PROGRAM_ID }));
    c.tx("2026-10-03", 10, [OWNER, a2], c.create(a2, YIELD, { program: TOKEN_2022_PROGRAM_ID }));
    c.tx("2026-10-04", 9, [OTHER, a1], mv(a1, 2_000_000));
    c.tx("2026-10-05", 9, [OTHER, a2], mv(a2, 1_000_000));
    const rpc = fixtureRpc(c, { mintExtensions: { [PYUSD]: ["transferFeeConfig", "metadataPointer", "tokenMetadata"], [YIELD]: ["interestBearingConfig"] } });
    const store = memStore(nativeCursor(), new Set([PYUSD, YIELD]));
    const { meter } = await runOnce(c, store, { freshSource: "NATIVE", rpc });
    const p = rowsMatchTruth(c, store, PYUSD, 6);
    check("Token-2022 with transfer fees (amount deltas stated) ⇒ COMPLETE, rows equal truth", store.coverage.get(PYUSD)?.kind === "COMPLETE" && p.ok, p.detail);
    const y = store.coverage.get(YIELD);
    check("interest-bearing Token-2022 ⇒ UNSUPPORTED (PROOF_PREMISES_UNMET), and NO rows", y?.kind === "UNKNOWN" && y.caveats.includes("PROOF_PREMISES_UNMET") && (store.rows.get(YIELD)?.size ?? 0) === 0, JSON.stringify(y));
    check("each Token-2022 mint is checked once (getAccountInfo)", meter.getAccountInfo === 2, JSON.stringify(meter));
    check("mint extension verdicts: scaled UI / confidential / unknown are refused, none ⇒ OK",
      mintExtensionVerdict({ value: { data: { parsed: { type: "mint", info: { extensions: [{ extension: "scaledUiAmountConfig" }] } } } } }) === "BALANCE_EXTENSION"
      && mintExtensionVerdict({ value: { data: { parsed: { type: "mint", info: { extensions: [{ extension: "confidentialTransferMint" }] } } } } }) === "CONFIDENTIAL_BALANCES"
      && mintExtensionVerdict({ value: { data: { parsed: { type: "mint", info: { extensions: [{ extension: "somethingNew" }] } } } } }) === "UNRECOGNISED_EXTENSION"
      && mintExtensionVerdict({ value: { data: { parsed: { type: "mint", info: {} } } } }) === "OK");
    const st = stateOf(store);
    check("a refused mint keeps the inventory incomplete (wallet cannot read complete)", st.inventoryComplete === false);
    const again = await runOnce(c, store, {});
    check("a refused mint is not re-checked, and owes no further work", again.meter.getAccountInfo === undefined && splWorkOwed(stateOf(store), { reachedBeginning: true, gap: null, top: {} }) === false, JSON.stringify(again.meter));
  }

  // ══ 4. RECONCILIATION MISMATCH ⇒ NO FABRICATED ROWS; a mid-history gap ⇒ PARTIAL ══
  console.log("reconciliation");
  {
    const c = new Chain();
    const ata = "AtaUsdc2222222222222222222222222222222222222";
    c.tx("2026-10-02", 9, [OWNER, ata], c.create(ata, USDC));
    c.tx("2026-10-03", 9, [OTHER, ata], mv(ata, 1_000_000));
    const lost = c.tx("2026-10-08", 9, [OTHER, ata], mv(ata, 4_000_000));
    c.tx("2026-10-12", 9, [OTHER, ata], mv(ata, 2_000_000));
    c.hide(ata, lost); // the index does not list it
    const store = memStore(nativeCursor(), new Set([USDC]));
    await runOnce(c, store, { freshSource: "NATIVE" });
    const cov = store.coverage.get(USDC);
    const m = rowsMatchTruth(c, store, USDC, 6);
    check("a missing transaction mid-history ⇒ PARTIAL, licensed only from the proven later start", cov?.kind === "PARTIAL" && cov.coveredFromISO === "2026-10-12" && m.ok, `${JSON.stringify(cov)} ${m.detail}`);
    check("…and not one row before that start", [...(store.rows.get(USDC)?.keys() ?? [])].every((d) => d >= "2026-10-12"));
    check("PARTIAL keeps the wallet's inventory incomplete", stateOf(store).inventoryComplete === false);
  }
  {
    const c = new Chain();
    const ata = "AtaUsdc3333333333333333333333333333333333333";
    c.tx("2026-10-02", 9, [OWNER, ata], c.create(ata, USDC));
    c.tx("2026-10-03", 9, [OTHER, ata], mv(ata, 1_000_000));
    // The chain says the account now holds MORE than any listed transaction explains.
    const lying = (program: string) => program === SPL_TOKEN_PROGRAM_ID
      ? { value: [{ pubkey: ata, account: { data: { parsed: { info: { mint: USDC, tokenAmount: { amount: "9000000", decimals: 6 } } } } } }] } : { value: [] };
    const rpc = fixtureRpc(c, { overrideCurrent: lying });
    const store = memStore(nativeCursor(), new Set([USDC]));
    for (let i = 0; i < HEAD_MISMATCH_LIMIT; i++) await runOnce(c, store, { freshSource: "NATIVE", rpc });
    const cov = store.coverage.get(USDC);
    check("replay end ≠ current balance (every run) ⇒ UNSUPPORTED, ADDRESS_INDEX_INCOMPLETE", cov?.kind === "UNKNOWN" && cov.caveats.includes("ADDRESS_INDEX_INCOMPLETE"), JSON.stringify(cov));
    check("reconciliation mismatch ⇒ NO fabricated rows", (store.rows.get(USDC)?.size ?? 0) === 0);
    // The chain agrees again later ⇒ the mint is re-decided (the refusal was retryable).
    await runOnce(c, store, { freshSource: "NATIVE" });
    check("a later match re-decides the mint COMPLETE (mismatch refusals are retried)", store.coverage.get(USDC)?.kind === "COMPLETE" && rowsMatchTruth(c, store, USDC, 6).ok);
  }

  // ══ 5. RESUMPTION + BUDGET EXHAUSTION ═══════════════════════════════════════
  console.log("resumption and budget");
  {
    const build = () => {
      const c = new Chain();
      const ata = "AtaUsdc4444444444444444444444444444444444444";
      c.tx("2026-10-01", 9, [OWNER, ata], c.create(ata, USDC));
      for (let i = 0; i < 40; i++) c.tx(`2026-10-${String(2 + Math.floor(i / 2)).padStart(2, "0")}`, 9 + (i % 2) * 4, [OTHER, ata], mv(ata, (i % 3 === 2 ? -1 : 3) * 100_000));
      return c;
    };
    const ref = build();
    const refStore = memStore(nativeCursor(), new Set([USDC]));
    await runOnce(ref, refStore, { freshSource: "NATIVE" });
    const c = build();
    const store = memStore(nativeCursor(), new Set([USDC]));
    const first = await runOnce(c, store, { freshSource: "NATIVE", requestBudget: 1 });
    check("budget of 1 request ⇒ stops, no rows, nothing fabricated", first.o.stoppedBecause === "BUDGET" && store.rows.size === 0 && (first.meter.getTokenAccountsByOwner ?? 0) <= 2, `${first.o.stoppedBecause} ${JSON.stringify(first.meter)}`);
    let runs = 1;
    while (store.coverage.get(USDC)?.kind !== "COMPLETE" && runs < 40) { await runOnce(c, store, { requestBudget: 9 }); runs++; }
    const m = rowsMatchTruth(c, store, USDC, 6);
    check(`resumed in bounded chunks (${runs} runs) ⇒ the SAME rows as one unbounded run`, m.ok && JSON.stringify([...store.rows.get(USDC)!]) === JSON.stringify([...refStore.rows.get(USDC)!]), m.detail);
    check("every chunk was committed by CAS (checkpoint advanced each run)", store.commits.length >= runs);
    // A conflicting writer: the step stops, never overwrites.
    const s2 = memStore(nativeCursor(), new Set([USDC]));
    const racing: MemStore = { ...s2, async commit(x) { await s2.commit({ ...x, expectedCursor: "someone-else" }); } };
    const r = await runOnce(c, racing, { freshSource: "NATIVE" });
    check("a checkpoint moved by another runner ⇒ CONFLICT, nothing written", r.o.stoppedBecause === "CONFLICT" && s2.rows.size === 0);
  }

  // ══ 6. PRICED-FIRST ORDERING; unpriced spam may stay "not reconstructed" ═══
  console.log("priced first");
  {
    const c = new Chain();
    const spamAta = "AaaSpam11111111111111111111111111111111111111"; // sorts FIRST by address
    const usdcAta = "ZzzUsdc11111111111111111111111111111111111111";
    c.tx("2026-10-02", 9, [OTHER, spamAta], c.create(spamAta, SPAM, { decimals: 0 }));
    c.tx("2026-10-02", 10, [OTHER, spamAta], mv(spamAta, 1_000_000));
    c.tx("2026-10-03", 9, [OWNER, usdcAta], c.create(usdcAta, USDC));
    c.tx("2026-10-04", 9, [OTHER, usdcAta], mv(usdcAta, 3_000_000));
    const store = memStore(nativeCursor(), new Set([USDC]));
    // Enough for anchors + one account's walk (sig page + 2 tx) + its head page, not the spam's.
    await runOnce(c, store, { freshSource: "NATIVE", requestBudget: 6 });
    check("with budget for one, the PRICED mint is reconstructed and the spam waits", store.coverage.get(USDC)?.kind === "COMPLETE" && !store.coverage.has(SPAM), JSON.stringify([...store.coverage.keys()]));
    const st = stateOf(store);
    check("…the spam mint is honestly PENDING (\"Not reconstructed yet\") and the inventory incomplete", st.mints.find((m) => m.mint === SPAM)?.status === "PENDING" && !st.inventoryComplete);
    check("the account bound puts priced mints' accounts first", (() => {
      const many = Array.from({ length: MAX_TRACKED_ACCOUNTS + 3 }, (_, i) => ({ address: `A${String(i).padStart(3, "0")}`, mint: SPAM, program: SPL_TOKEN_PROGRAM_ID, decimals: 0 }));
      const s = mergeDiscovered(freshSplState("NATIVE"), [...many, { address: "Z999", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }], (m) => m === USDC);
      return s.accounts.some((a) => a.address === "Z999") && s.overflow === 4 && s.accounts.length === MAX_TRACKED_ACCOUNTS;
    })());
  }

  // ══ 7. NATIVE COVERAGE UNTOUCHED; discovery rides on the native fetch ═══════
  console.log("native independence");
  {
    const c = new Chain();
    const ata = "AtaUsdc5555555555555555555555555555555555555";
    c.tx("2026-10-02", 9, [OWNER, ata], c.create(ata, USDC));
    c.tx("2026-10-03", 9, [OTHER, ata], mv(ata, 1_000_000));
    const before = JSON.parse(nativeCursor());
    const store = memStore(nativeCursor(), new Set([USDC]));
    await runOnce(c, store, { freshSource: "NATIVE" });
    const after = JSON.parse(store.cursor()!);
    delete after.tokens;
    check("the token step leaves every native checkpoint field byte-identical", JSON.stringify(after) === JSON.stringify(before));
    check("native proven-history status is not changed by token outcomes", parseCheckpoint(store.cursor(), "acct_sol", OWNER)?.reachedBeginning === true && parseCheckpoint(store.cursor(), "acct_sol", OWNER)?.licensedFromISO === "2026-09-01");
    const nothing = await runSplTokenHistory({ owner: OWNER, store: memStore(null) }, { call: fixtureRpc(c), deadlineMs: NOW + 1, now: () => NOW, sent: () => 0 });
    check("no native checkpoint ⇒ the token step does nothing (native first)", nothing.stoppedBecause === "SKIPPED" && nothing.requests === 0);

    // The native run with the hooks: identical native commits, discoveries folded into its checkpoint.
    const DAY = 86_400;
    const t0 = Math.floor(Date.parse("2026-10-20T10:00:00Z") / 1000);
    const nativeTxs: Array<{ signature: string; slot: number; blockTime: number; view: SolTxForProof & { meta: Record<string, unknown> } }> = [0, 1, 2].map((i) => ({
      signature: `n${i}`, slot: 500 + i, blockTime: t0 + i * DAY,
      view: { slot: 500 + i, blockTime: t0 + i * DAY, transaction: { message: { accountKeys: [OWNER, ata] } },
        meta: { preBalances: [1_000_000_000 - i * 5000, 2], postBalances: [1_000_000_000 - (i + 1) * 5000, 2],
          preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: OWNER, programId: SPL_TOKEN_PROGRAM_ID, uiTokenAmount: { amount: "1", decimals: 6 } }] } },
    }));
    const nativeCall: SolRpcCall = async (method, params) => {
      if (method === "getSignaturesForAddress") { const o = params[1] as { before?: string }; return o.before ? [] : [...nativeTxs].reverse().map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null })); }
      return nativeTxs.find((t) => t.signature === params[0])!.view;
    };
    const nativeStore = (): SolBackfillStore & { commits: SolBackfillCommit[]; cur: () => string | null } => {
      let cur: string | null = null;
      const commits: SolBackfillCommit[] = [];
      return { commits, cur: () => cur, async readCursor() { return cur; },
        async anchor() { return { dateISO: "2026-10-22", lamports: BigInt(1_000_000_000 - 3 * 5000) }; },
        async commit(x) { if (x.expectedCursor !== cur) throw new CheckpointConflictError(); cur = x.nextCursor; commits.push(x); } };
    };
    const plain = nativeStore();
    await runSolHistoryBackfill({ accountId: "acct_sol", address: OWNER, store: plain }, { call: nativeCall, now: () => NOW });
    const hooked = nativeStore();
    const col = createSplDiscoveryCollector(OWNER);
    await runSolHistoryBackfill({ accountId: "acct_sol", address: OWNER, store: hooked }, { call: nativeCall, now: () => NOW,
      observeTransaction: col.observe, annotateCheckpoint: (cp) => annotateWithDiscoveries(cp, col.all(), "NATIVE") });
    const strip = (x: SolBackfillCommit) => JSON.stringify({ ...x, expectedCursor: null, nextCursor: null });
    check("native rows + coverage are identical with the token hooks installed", plain.commits.map(strip).join() === hooked.commits.map(strip).join() && plain.commits.length > 0);
    const hookedCp = JSON.parse(hooked.cur()!) as { tokens?: unknown };
    const tokState = parseSplState(hookedCp.tokens);
    check("the native fetch discovered the wallet's token account at no extra request (source NATIVE)", tokState?.discovery.source === "NATIVE" && tokState.accounts.some((a) => a.address === ata));
    check("the hooked native cursor is still a SOL checkpoint (readers use isSolBackfillCursor)", hooked.cur()!.startsWith('{"kind":"sol-history"'));
  }

  // ══ 8. WALLET COMPLETENESS REQUIRES TOKENS ══════════════════════════════════
  console.log("wallet completeness");
  {
    const nativeDone = { instrumentId: "n", assetKey: null, label: "SOL", ...facetFromCoverage({ kind: "COMPLETE", fromISO: "2022-01-01", toISO: TODAY, source: "x" }) };
    const tok = (cov: ChainCoverage | null) => ({ instrumentId: "t", assetKey: "k", label: "USDC", standard: "SPL" as const, contract: USDC, quantity: 1, held: true,
      firstObservedISO: TODAY, lastObservedISO: TODAY, priceStatus: "MARKET_PRICE" as const, ...facetFromCoverage(cov) });
    const full = tok({ kind: "COMPLETE", fromISO: "2026-10-02", toISO: TODAY, source: SPL_CONTINUITY_SOURCE });
    const partial = tok({ kind: "PARTIAL", coveredFromISO: "2026-10-12", coveredToISO: TODAY, caveats: ["ADDRESS_INDEX_INCOMPLETE"], source: SPL_CONTINUITY_SOURCE });
    check("native complete + token COMPLETE but inventory not proven ⇒ NOT complete", walletHistoryComplete({ chain: "SOL", native: nativeDone, tokens: [full] }) === false);
    check("native complete + every token COMPLETE + inventory proven ⇒ complete", walletHistoryComplete({ chain: "SOL", native: nativeDone, tokens: [full], tokenInventoryComplete: true }) === true);
    check("a token verified only from a later start (PARTIAL) ⇒ NOT complete", walletHistoryComplete({ chain: "SOL", native: nativeDone, tokens: [partial], tokenInventoryComplete: true }) === false);
    check("native NOT complete ⇒ never complete, whatever the tokens", walletHistoryComplete({ chain: "SOL", native: { ...nativeDone, ...facetFromCoverage(null) }, tokens: [full], tokenInventoryComplete: true }) === false);
    check("ETH (no token history wired here) stays incomplete", walletHistoryComplete({ chain: "ETH", native: nativeDone, tokens: [], tokenInventoryComplete: true }) === false);
    check("inventory from a cursor: absent / foreign ⇒ false", splInventoryCompleteFromCursor(null) === false && splInventoryCompleteFromCursor('{"kind":"btc"}') === false && splInventoryCompleteFromCursor(nativeCursor()) === false);
  }

  // ══ 9. CUSTOMER COPY (no quantities — PCS-2) ════════════════════════════════
  console.log("Connections copy");
  {
    const base = { label: "USDC", standard: "SPL" as const, priceStatus: "MARKET_PRICE" as const, firstObservedISO: TODAY, lastObservedISO: TODAY };
    check("COMPLETE ⇒ 'History verified since <date>'", tokenHistoryText({ ...base, historyState: "RECONSTRUCTED", coverageKind: "COMPLETE", licensedFromISO: "2026-10-02" }) === "History verified since Oct 2, 2026");
    check("PARTIAL ⇒ 'Verified from <date> — earlier history couldn’t be proven'", tokenHistoryText({ ...base, historyState: "RECONSTRUCTED", coverageKind: "PARTIAL", licensedFromISO: "2026-10-12" }) === "Verified from Oct 12, 2026 — earlier history couldn’t be proven");
    check("UNSUPPORTED ⇒ 'Couldn’t be verified — <plain reason>; current balance only'",
      tokenHistoryText({ ...base, historyState: "UNLICENSED", coverageKind: "UNKNOWN", caveats: ["PROOF_PREMISES_UNMET"] }) === "Couldn’t be verified — this token’s balance can change without a recorded transfer; current balance only");
    check("no record ⇒ 'Not reconstructed yet'", tokenHistoryText({ ...base, historyState: "NOT_RECONSTRUCTED" }) === "Not reconstructed yet");
    check("reasons are plain words, never codes", !/[A-Z]{3,}_/.test(tokenUnverifiedReason(["ADDRESS_INDEX_INCOMPLETE"])) && !/[A-Z]{3,}_/.test(tokenUnverifiedReason([])));
  }

  // ══ 10. WORKER + PRICES ═════════════════════════════════════════════════════
  console.log("worker eligibility + historical prices");
  {
    const cp = parseCheckpoint(nativeCursor(), "acct_sol", OWNER)!;
    const row = { accountId: "acct_sol", connectionId: "c", cursor: nativeCursor(), address: OWNER, checkpoint: cp };
    check("a COMPLETE native wallet with token work owed is a worker candidate (when enabled)", orderCandidates([row], NOW, true).length === 1);
    check("…and is not when token history is disabled (native behaviour unchanged)", orderCandidates([row], NOW, false).length === 0);
    const doneState = { ...freshSplState("NATIVE"), inventoryComplete: true };
    const doneCp = { ...cp, tokens: doneState };
    check("a wallet with no token work left is not re-run", orderCandidates([{ ...row, checkpoint: doneCp }], NOW, true).length === 0);

    check("price plan: clamps to the vendor floor and yesterday",
      JSON.stringify(planTokenPriceRequest({ fromISO: "2024-01-01", toISO: TODAY }, { floorISO: "2025-10-28", yesterdayISO: "2026-10-27", marker: null, nowMs: NOW })) === JSON.stringify({ fromISO: "2025-10-28", toISO: "2026-10-27" }));
    check("price plan: a covered range is not re-fetched (deduped across customers); a tail only fetches the tail",
      planTokenPriceRequest({ fromISO: "2026-10-02", toISO: TODAY }, { floorISO: "2025-10-28", yesterdayISO: "2026-10-27", marker: { fromISO: "2026-10-01", toISO: "2026-10-27", attemptedAt: "2026-10-28T00:00:00Z", outcome: "OK" }, nowMs: NOW }) === null
      && planTokenPriceRequest({ fromISO: "2026-10-02", toISO: TODAY }, { floorISO: "2025-10-28", yesterdayISO: "2026-10-27", marker: { fromISO: "2026-10-01", toISO: "2026-10-20", attemptedAt: "2026-10-21T00:00:00Z", outcome: "OK" }, nowMs: NOW })?.fromISO === "2026-10-21");
    check("price plan: an unlisted answer is not re-asked within a day",
      planTokenPriceRequest({ fromISO: "2026-10-02", toISO: TODAY }, { floorISO: "2025-10-28", yesterdayISO: "2026-10-27", marker: { fromISO: "2026-10-02", toISO: "2026-10-27", attemptedAt: "2026-10-28T06:00:00Z", outcome: "UNLISTED" }, nowMs: NOW }) === null);
    let url = "";
    const meter: Record<string, number> = {};
    const r = await fetchCoinGeckoTokenDailyClosesUsd("solana", USDC, "2026-10-01", "2026-10-03", { apiKey: "k", meter,
      fetchImpl: async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ prices: [[Date.parse("2026-10-01T05:00:00Z"), 1.0], [Date.parse("2026-10-01T23:00:00Z"), 0.999], [Date.parse("2026-10-02T12:00:00Z"), 0]] }) }; } });
    check("token closes: by platform + EXACT (case-preserved) mint, metered before sending", url.includes(`/coins/solana/contract/${USDC}/market_chart/range`) && meter["market_chart/range:solana"] === 1, url);
    check("token closes: last point of the UTC day; a zero price is dropped, never stored", r.closes.length === 1 && r.closes[0].price === 0.999);
    const unl = await fetchCoinGeckoTokenDailyClosesUsd("ethereum", "0xABCdef0000000000000000000000000000000001", "2026-10-01", "2026-10-03", { apiKey: "k", fetchImpl: async (u) => { url = u; return { ok: false, status: 404, json: async () => ({}) }; } });
    check("token closes: 404 ⇒ unlisted, no closes (UNPRICED, never zero); EVM contract lowercased", unl.unlisted && unl.closes.length === 0 && url.includes("0xabcdef"));
    check("the shared close parser is the native one (same daily rule)", parseMarketChartCloses({ prices: [[Date.parse("2026-10-01T01:00:00Z"), 5]] }, "2026-10-01", "2026-10-01")[0].price === 5);
  }

  // ══ 11. PURE PIECES ════════════════════════════════════════════════════════
  console.log("pure core");
  {
    check("attribution: another owner / another mint / absent ⇒ 0", attributedRaw(`${USDC}:X:5`, USDC) === BigInt(0) && attributedRaw(`${USDC}:W:5`, BONK) === BigInt(0) && attributedRaw("-", USDC) === BigInt(0) && attributedRaw(`${USDC}:W:5`, USDC) === BigInt(5));
    check("state key is raw-amount exact past float range", stateKey({ address: "a", mint: USDC, owner: OWNER, program: null, amount: BigInt("18446744073709551615"), decimals: 6 }, OWNER) === `${USDC}:W:18446744073709551615`);
    let threw = false;
    try {
      tokenPointFromTransaction({ slot: 1, blockTime: 1, transaction: { message: { accountKeys: [OWNER, "acc"] } },
        meta: { preTokenBalances: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: { amount: "1.5", decimals: 6 } }], postTokenBalances: [] } }, "s", "acc", OWNER);
    } catch { threw = true; }
    check("an unreadable balance for the account is refused, never read as absent", threw);
    const disc = discoverOwnedTokenAccounts({ slot: 1, blockTime: 1, transaction: { message: { accountKeys: [OTHER, "x1"] } },
      meta: { preTokenBalances: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: { amount: "1", decimals: 6 } }], postTokenBalances: [], loadedAddresses: { writable: ["x2"], readonly: [] } } }, OWNER);
    check("discovery reads the closing transaction's pre-balance owner", disc.length === 1 && disc[0].address === "x1");
    check("json-encoded keys append lookup-table addresses (v0)", discoverOwnedTokenAccounts({ slot: 1, blockTime: 1, transaction: { message: { accountKeys: [OTHER] } },
      meta: { preTokenBalances: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: { amount: "1", decimals: 6 } }], postTokenBalances: [], loadedAddresses: { writable: ["viaAlt"], readonly: [] } } }, OWNER)[0]?.address === "viaAlt");
    check("a malformed token state is never trusted", parseSplState({ kind: "spl-history", v: 1, discovery: { source: "X" }, accounts: [], mints: [] }) === null && parseSplState(undefined) === null);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
