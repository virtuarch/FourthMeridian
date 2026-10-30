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
  SPL_CONTINUITY_SOURCE, MAX_OVERFLOW_RECORDS, MAX_OVERFLOW_MINTS, MAX_PENDING_DISCOVERED, MAX_DAYS_PER_ACCOUNT, BACKOFF_AFTER, BACKOFF_MS,
  decideMint, overflowedMints, inventoryCompleteOf, nativeWatchIntact, needsExtensionCheck, stagedDays, discoveryComplete,
  type SplHistoryState,
} from "@/lib/crypto/spl-history.core";
import {
  runSolHistoryBackfill, buildRpcCall, CheckpointConflictError, SolTransportError,
  type SolBackfillStore, type SolBackfillCommit, type SolRpcCall,
} from "@/lib/crypto/sol-history-backfill";
import { emptyCheckpoint, serializeCheckpoint, parseCheckpoint, type SolBackfillCheckpoint, type SolTxForProof } from "@/lib/crypto/sol-history-backfill.core";
import { orderCandidates } from "@/lib/crypto/sol-backfill-worker.core";
import { walletHistoryComplete, facetFromCoverage } from "@/lib/crypto/wallet-instrument-history";
import { splInventoryCompleteFromCursor } from "@/lib/crypto/spl-history-inventory";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@/lib/crypto/token-asset";
import { tokenHistoryText, tokenUnverifiedReason } from "@/lib/connections/connection-detail.core";
import { planTokenPriceRequest, acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import { splSyncRequestLimit } from "@/lib/crypto/spl-history.store";
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
      return { value: { owner: TOKEN_2022_PROGRAM_ID, data: { parsed: { type: "mint", info: { extensions: ext.map((e) => ({ extension: e, state: {} })) } } } } };
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

/** A native checkpoint whose token discovery hook has WATCHED every native commit (source NATIVE, intact). */
function watchedCursor(extra: Partial<SolBackfillCheckpoint> = {}): string {
  return JSON.stringify(annotateWithDiscoveries(JSON.parse(nativeCursor(extra)), [], "NATIVE"));
}

interface MemStore extends SplHistoryStore {
  rows: Map<string, Map<string, number>>;
  coverage: Map<string, ChainCoverage>;
  commits: SplCommit[];
  priceCalls: Array<{ mint: string; fromISO: string; toISO: string }>;
  cursor(): string | null;
}
function memStore(initial: string | null, priced: ReadonlySet<string> = new Set(), priceStatus?: string): MemStore {
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
    async acquirePrices(m) { priceCalls.push({ mint: m.mint, fromISO: m.fromISO, toISO: m.toISO }); return { inserted: 0, earliestISO: null, ...(priceStatus ? { status: priceStatus } : {}) }; },
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
    const store = memStore(watchedCursor(), new Set([USDC]));
    const { o, meter } = await runOnce(c, store, { freshSource: "NATIVE" });
    const cov = store.coverage.get(USDC);
    check("USDC is COMPLETE from its first account's creation day", cov?.kind === "COMPLETE" && cov.fromISO === "2026-10-02" && cov.toISO === TODAY && cov.source === SPL_CONTINUITY_SOURCE, JSON.stringify(cov));
    const m = rowsMatchTruth(c, store, USDC, 6);
    check("two accounts summed per day equal the chain's true end-of-day balance, every day", m.ok, m.detail);
    check("the incoming transfer the owner never signed is in the history (account-indexed, 6.25 on Oct 6)", store.rows.get(USDC)?.get("2026-10-06") === 6.25, String(store.rows.get(USDC)?.get("2026-10-06")));
    check("the outcome reports rows and the earliest impacted day (snapshot regeneration input)", o.rowsWritten === 27 && o.impactedFromISO === "2026-10-02", `${o.rowsWritten} ${o.impactedFromISO}`);
    check("historical prices are requested for the PRICED mint over its licence", store.priceCalls.length === 1 && store.priceCalls[0].fromISO === "2026-10-02");
    check("re-review F4: a price run that was not stopped reports COMPLETE", o.prices.status === "COMPLETE" && o.prices.reason === null && o.prices.mintsSkipped === 0, JSON.stringify(o.prices));
    // Re-review F4 (SPL ≡ ERC-20) — the shared path's BUDGET status is never discarded.
    const budgetStore = memStore(watchedCursor(), new Set([USDC]), "BUDGET");
    const { o: ob } = await runOnce(c, budgetStore, { freshSource: "NATIVE" });
    check("re-review F4: the token budget stopping SPL pricing ⇒ prices BUDGET_STOPPED with a reason (not silent)",
      ob.prices.status === "BUDGET_STOPPED" && /budget/.test(ob.prices.reason ?? "") && ob.prices.mintsSkipped === 1 && ob.stoppedBecause === "DONE", JSON.stringify(ob.prices));
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
    const store = memStore(watchedCursor(), new Set([PYUSD, YIELD]));
    const { meter } = await runOnce(c, store, { freshSource: "NATIVE", rpc });
    const p = rowsMatchTruth(c, store, PYUSD, 6);
    check("Token-2022 with transfer fees (amount deltas stated) ⇒ COMPLETE, rows equal truth", store.coverage.get(PYUSD)?.kind === "COMPLETE" && p.ok, p.detail);
    const y = store.coverage.get(YIELD);
    check("interest-bearing Token-2022 ⇒ UNSUPPORTED (PROOF_PREMISES_UNMET), and NO rows", y?.kind === "UNKNOWN" && y.caveats.includes("PROOF_PREMISES_UNMET") && (store.rows.get(YIELD)?.size ?? 0) === 0, JSON.stringify(y));
    check("each Token-2022 mint is checked once (getAccountInfo)", meter.getAccountInfo === 2, JSON.stringify(meter));
    check("mint extension verdicts: scaled UI / confidential / unknown are refused, none ⇒ OK",
      mintExtensionVerdict({ value: { owner: TOKEN_2022_PROGRAM_ID, data: { parsed: { type: "mint", info: { extensions: [{ extension: "scaledUiAmountConfig" }] } } } } }) === "BALANCE_EXTENSION"
      && mintExtensionVerdict({ value: { owner: TOKEN_2022_PROGRAM_ID, data: { parsed: { type: "mint", info: { extensions: [{ extension: "confidentialTransferMint" }] } } } } }) === "CONFIDENTIAL_BALANCES"
      && mintExtensionVerdict({ value: { owner: TOKEN_2022_PROGRAM_ID, data: { parsed: { type: "mint", info: { extensions: [{ extension: "somethingNew" }] } } } } }) === "UNRECOGNISED_EXTENSION"
      && mintExtensionVerdict({ value: { owner: TOKEN_2022_PROGRAM_ID, data: { parsed: { type: "mint", info: {} } } } }) === "OK");
    const st = stateOf(store);
    check("a refused mint keeps the inventory incomplete (wallet cannot read complete)", st.inventoryComplete === false);
    const again = await runOnce(c, store, {});
    check("a refused mint is not re-checked, and owes no further work", again.meter.getAccountInfo === undefined && splWorkOwed(stateOf(store), JSON.parse(store.cursor()!) as SolBackfillCheckpoint) === false, JSON.stringify(again.meter));
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
    const store = memStore(watchedCursor(), new Set([USDC]));
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
    const store = memStore(watchedCursor(), new Set([USDC]));
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
    const refStore = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(ref, refStore, { freshSource: "NATIVE" });
    const c = build();
    const store = memStore(watchedCursor(), new Set([USDC]));
    const first = await runOnce(c, store, { freshSource: "NATIVE", requestBudget: 1 });
    check("budget of 1 request ⇒ stops, no rows, nothing fabricated", first.o.stoppedBecause === "BUDGET" && store.rows.size === 0 && (first.meter.getTokenAccountsByOwner ?? 0) <= 2, `${first.o.stoppedBecause} ${JSON.stringify(first.meter)}`);
    let runs = 1;
    let maxSent = 0;
    while (store.coverage.get(USDC)?.kind !== "COMPLETE" && runs < 40) {
      const r = await runOnce(c, store, { requestBudget: 9 }); runs++;
      maxSent = Math.max(maxSent, Object.values(r.meter).reduce((x, y) => x + y, 0));
    }
    check("no run sends past its request allowance (a fetch batch never overshoots)", maxSent <= 9, String(maxSent));
    const m = rowsMatchTruth(c, store, USDC, 6);
    check(`resumed in bounded chunks (${runs} runs) ⇒ the SAME rows as one unbounded run`, m.ok && JSON.stringify([...store.rows.get(USDC)!]) === JSON.stringify([...refStore.rows.get(USDC)!]), m.detail);
    check("every chunk was committed by CAS (checkpoint advanced each run)", store.commits.length >= runs);
    // A conflicting writer: the step stops, never overwrites.
    const s2 = memStore(watchedCursor(), new Set([USDC]));
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
    const store = memStore(watchedCursor(), new Set([USDC]));
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
    const before = JSON.parse(watchedCursor());
    delete before.tokens;
    const store = memStore(watchedCursor(), new Set([USDC]));
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
    check("the native fetch discovered the wallet's token account at no extra request (source NATIVE)", tokState?.discovery.source === "NATIVE" && (tokState.pendingDiscovered ?? []).some((a) => a.address === ata)
      && tokState.discovery.watchedTop === (JSON.parse(hooked.cur()!) as SolBackfillCheckpoint).top?.signature);
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
    // ERC-20 history (PR #122) wires ETH through the same inventory rule: unproven ⇒ incomplete.
    check("ETH without a proven token inventory stays incomplete", walletHistoryComplete({ chain: "ETH", native: nativeDone, tokens: [] }) === false
      && walletHistoryComplete({ chain: "ETH", native: nativeDone, tokens: [], tokenInventoryComplete: false }) === false);
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
    const doneState = { ...parseSplState((JSON.parse(watchedCursor()) as { tokens: unknown }).tokens)!, inventoryComplete: true };
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

  // ══ 12. REVIEW FIXES ═══════════════════════════════════════════════════════
  console.log("review: account bound never understates a mint");
  {
    const spam = Array.from({ length: MAX_TRACKED_ACCOUNTS }, (_, i) => ({ address: `Spam${String(i).padStart(3, "0")}`, mint: SPAM, program: SPL_TOKEN_PROGRAM_ID, decimals: 0 }));
    // One slot left: USDC's first account is tracked, its second is not.
    let st = mergeDiscovered(freshSplState("NATIVE"), spam.slice(1));
    // Every spam account has started walking: none may be evicted.
    st = { ...st, accounts: st.accounts.map((a) => ({ ...a, top: { signature: "s", slot: 1, blockTime: 1, dateISO: "2026-10-01", preLamports: "-", postLamports: "-" }, bottom: { signature: "s", slot: 1, blockTime: 1, dateISO: "2026-10-01", preLamports: "-", postLamports: "-" } })) };
    st = mergeDiscovered(st, [{ address: "UsdcA", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }, { address: "UsdcB", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }], (m) => m === USDC);
    check("an untracked account is REMEMBERED with its mint (and the mint is known)", (st.overflowed ?? []).some(([a, m]) => a === "UsdcB" && m === USDC) && st.mints.some((m) => m.mint === USDC));
    const usdc = st.mints.find((m) => m.mint === USDC)!;
    const verifiedAll = new Set(st.accounts.map((a) => a.address));
    const d = decideMint(usdc, st.accounts, { discoveryComplete: true, verifiedThisRun: verifiedAll, todayISO: TODAY, overflowed: overflowedMints(st) });
    check("a mint with an untracked account is NEVER COMPLETE (TOO_MANY_ACCOUNTS)", d.status === "UNSUPPORTED" && d.reason === "TOO_MANY_ACCOUNTS");
    check("…and the inventory reads incomplete", inventoryCompleteOf(st, true) === false);
    // An unstarted spam account yields its slot to a priced one, and is remembered.
    const fresh = mergeDiscovered(freshSplState("NATIVE"), spam);
    const evicted = mergeDiscovered(fresh, [{ address: "UsdcC", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }], (m) => m === USDC);
    check("a priced account evicts an unstarted unpriced one; the evicted pair is remembered (its mint held)",
      evicted.accounts.some((a) => a.address === "UsdcC") && overflowedMints(evicted).has(SPAM) && !overflowedMints(evicted).has(USDC));
    // A spam-heavy wallet: hundreds of untracked accounts of ONE mint never saturate — USDC stays decidable.
    const flood = Array.from({ length: MAX_OVERFLOW_RECORDS * 2 }, (_, i) => ({ address: `Flood${i}`, mint: SPAM, program: SPL_TOKEN_PROGRAM_ID, decimals: 0 }));
    const spammy = mergeDiscovered(mergeDiscovered(freshSplState("NATIVE"), [{ address: "UsdcOnly", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }], (m) => m === USDC), flood, (m) => m === USDC);
    const usdcOnly = spammy.accounts.filter((x) => x.mints.includes(USDC));
    check("hundreds of untracked spam accounts hold only THEIR mint: no saturation, USDC still decidable, checkpoint bounded",
      !spammy.overflowSaturated && overflowedMints(spammy).has(SPAM) && !overflowedMints(spammy).has(USDC)
      && (spammy.overflowed ?? []).length <= MAX_OVERFLOW_RECORDS && spammy.accounts.length === MAX_TRACKED_ACCOUNTS
      && decideMint(spammy.mints.find((m) => m.mint === USDC)!, usdcOnly.map((x) => ({ ...x, creation: true, days: [["2026-10-01", `${USDC}:W:1`]] })),
        { discoveryComplete: true, verifiedThisRun: new Set(usdcOnly.map((x) => x.address)), todayISO: TODAY, overflowed: overflowedMints(spammy) }).status === "COMPLETE");
    const many = Array.from({ length: MAX_OVERFLOW_MINTS + 5 }, (_, i) => ({ address: `Over${i}`, mint: `M${i}`, program: SPL_TOKEN_PROGRAM_ID, decimals: 0 }));
    // A fully tracked USDC, then more untracked NFT mints than the memory holds.
    const base = mergeDiscovered(mergeDiscovered(freshSplState("NATIVE"), spam.slice(1)), [{ address: "UsdcTracked", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }], (m) => m === USDC);
    const sat = mergeDiscovered(base, many);
    const tracked = sat.accounts.filter((x) => x.mints.includes(USDC)).map((x) => ({ ...x, creation: true, days: [["2026-10-01", `${USDC}:W:1`]] as Array<[string, string]> }));
    check("past the untracked-mint memory the state is SATURATED (inventory incomplete) …", sat.overflowSaturated === true && inventoryCompleteOf(sat, true) === false);
    check("…but a FULLY TRACKED mint recorded before saturation is still decided per mint (COMPLETE)",
      decideMint(sat.mints.find((m) => m.mint === USDC)!, tracked, { discoveryComplete: true, verifiedThisRun: new Set(tracked.map((x) => x.address)), todayISO: TODAY, overflowed: overflowedMints(sat) }).status === "COMPLETE");
    check("an untracked-only mint gets no mint record (bounded checkpoint)", !sat.mints.some((m) => m.mint === "M7"));
    // After saturation: a mint first RECORDED now may have lost an untracked account ⇒ never COMPLETE (honest reason).
    const late = mergeDiscovered({ ...sat, accounts: sat.accounts.filter((x) => x.address !== "Spam001") }, [{ address: "LateAcct", mint: BONK, program: SPL_TOKEN_PROGRAM_ID, decimals: 5 }]);
    const bonk = late.mints.find((m) => m.mint === BONK)!;
    check("…a mint first recorded AFTER saturation is never COMPLETE (TOO_MANY_ACCOUNTS)", bonk.afterSaturation === true
      && decideMint(bonk, late.accounts.filter((x) => x.mints.includes(BONK)).map((x) => ({ ...x, creation: true })), { discoveryComplete: true, verifiedThisRun: new Set(["LateAcct"]), todayISO: TODAY, overflowed: overflowedMints(late) }).reason === "TOO_MANY_ACCOUNTS");
    // A recorded mint overflowing once the memory is full is held on its own record — never lost.
    const usdcOver = mergeDiscovered(sat, [{ address: "UsdcSecond", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }]); // no slot to take (unpriced here)
    check("…and a recorded mint that overflows once the memory is full is held on its record (never COMPLETE)",
      usdcOver.mints.find((m) => m.mint === USDC)?.untracked === true
      && decideMint(usdcOver.mints.find((m) => m.mint === USDC)!, tracked, { discoveryComplete: true, verifiedThisRun: new Set(tracked.map((x) => x.address)), todayISO: TODAY, overflowed: overflowedMints(usdcOver) }).status === "UNSUPPORTED");
    // Native-hook finds are QUEUED, then placed priced-first by the token step.
    const c = new Chain();
    const usdcAta = "ZzzUsdcLast1111111111111111111111111111111111";
    c.tx("2026-10-03", 9, [OWNER, usdcAta], c.create(usdcAta, USDC));
    c.tx("2026-10-04", 9, [OTHER, usdcAta], mv(usdcAta, 3_000_000));
    const hookFinds = [...Array.from({ length: MAX_TRACKED_ACCOUNTS + 10 }, (_, i) => ({ address: `Aaa${String(i).padStart(3, "0")}`, mint: SPAM, program: SPL_TOKEN_PROGRAM_ID, decimals: 0 })),
      { address: usdcAta, mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }];
    const cur = JSON.stringify(annotateWithDiscoveries(JSON.parse(nativeCursor()), hookFinds, "NATIVE"));
    const qs = parseSplState((JSON.parse(cur) as { tokens: unknown }).tokens)!;
    check("the native hook QUEUES its finds (no address-order slot grab)", qs.accounts.length === 0 && (qs.pendingDiscovered ?? []).length === hookFinds.length);
    const store = memStore(cur, new Set([USDC]));
    await runOnce(c, store, {});
    const after = stateOf(store);
    check("…and the token step places them priced-first: USDC tracked, spam overflow remembered", after.accounts.some((a) => a.address === usdcAta) && overflowedMints(after).has(SPAM) && (after.pendingDiscovered ?? []).length === 0);
  }

  console.log("review: a full discovery queue re-walks (priced-first), never refuses");
  {
    const c = new Chain();
    const usdcClosed = "ClosedUsdcQ11111111111111111111111111111111";
    c.tx("2026-10-04", 9, [OWNER, usdcClosed], c.create(usdcClosed, USDC));
    c.tx("2026-10-05", 9, [OTHER, usdcClosed], mv(usdcClosed, 4_000_000));
    c.tx("2026-10-08", 9, [OWNER, usdcClosed, OTHER], mv(usdcClosed, -4_000_000));
    c.tx("2026-10-08", 10, [OWNER, usdcClosed], close(usdcClosed));
    // One native run sees 600 airdropped spam ATAs, then the closed USDC account.
    const finds = [...Array.from({ length: 600 }, (_, i) => ({ address: `Air${String(i).padStart(4, "0")}`, mint: `Drop${i}`, program: SPL_TOKEN_PROGRAM_ID, decimals: 0 })),
      { address: usdcClosed, mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }];
    const cur = annotateWithDiscoveries(JSON.parse(nativeCursor()), finds, "NATIVE") as SolBackfillCheckpoint & { tokens: SplHistoryState };
    const qs = parseSplState(cur.tokens)!;
    check("a full queue refuses nothing: USDC is not held, discovery falls back to a WALK",
      !overflowedMints(qs).has(USDC) && !qs.overflowSaturated && qs.discovery.source === "WALK" && !qs.discovery.walkDone && (qs.pendingDiscovered ?? []).length === MAX_PENDING_DISCOVERED);
    const store = memStore(JSON.stringify(cur), new Set([USDC]));
    for (let i = 0; i < 4 && store.coverage.get(USDC)?.kind !== "COMPLETE"; i++) await runOnce(c, store, {});
    const m = rowsMatchTruth(c, store, USDC, 6);
    check("…the re-walk finds the closed USDC account, places it priced-first, and USDC is COMPLETE = truth",
      store.coverage.get(USDC)?.kind === "COMPLETE" && m.ok && stateOf(store).accounts.some((x) => x.address === usdcClosed), `${JSON.stringify(store.coverage.get(USDC))} ${m.detail}`);
  }

  console.log("review: flag toggled mid-import");
  {
    const c = new Chain();
    const gone = "GoneUsdc222222222222222222222222222222222222";
    c.tx("2026-10-12", 9, [OWNER, gone], c.create(gone, USDC));
    c.tx("2026-10-13", 9, [OTHER, gone], mv(gone, 9_000_000));
    c.tx("2026-10-15", 9, [OWNER, gone, OTHER], mv(gone, -9_000_000));
    c.tx("2026-10-15", 10, [OWNER, gone], close(gone));
    // Watched at top "native1"; then native advanced WITHOUT the hook (flag off).
    const watched = JSON.parse(watchedCursor()) as SolBackfillCheckpoint & { tokens: unknown };
    const moved = { ...watched, top: { ...watched.top!, signature: "native2", slot: 2 } };
    const st0 = parseSplState(moved.tokens)!;
    check("a native move the hook did not watch is detected", nativeWatchIntact(st0, moved) === false && splWorkOwed(st0, moved, NOW) === true);
    const store = memStore(JSON.stringify(moved), new Set([USDC]));
    const r = await runOnce(c, store, {});
    const st = stateOf(store);
    check("…discovery falls back to a WALK of the owner's transactions (never trusts native reachedBeginning)",
      st.discovery.source === "WALK" && st.discovery.walkDone && (r.meter.getSignaturesForAddress ?? 0) >= 1);
    check("…and the closed account native never showed the hook is found and proven", store.coverage.get(USDC)?.kind === "COMPLETE" && rowsMatchTruth(c, store, USDC, 6).ok);
    const demoted = parseSplState((annotateWithDiscoveries(moved, [], "NATIVE", { demote: true }) as { tokens?: unknown }).tokens)!;
    check("the native hook itself demotes when told the watch broke", demoted.discovery.source === "WALK");
  }

  console.log("review: an account joining a committed mint ⇒ exact rewrite from the trim point, never from a trimmed list");
  {
    const c = new Chain();
    const a = "AtaUsdc6666666666666666666666666666666666666", b = "HandOver666666666666666666666666666666666666";
    c.tx("2026-10-01", 9, [OTHER, b], c.create(b, USDC, { owner: OTHER }));
    c.tx("2026-10-02", 9, [OTHER, b], mv(b, 4_000_000));
    c.tx("2026-10-05", 9, [OWNER, a], c.create(a, USDC));
    c.tx("2026-10-06", 9, [OTHER, a], mv(a, 2_000_000));
    const store = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(c, store, { nowMs: Date.parse("2026-10-20T12:00:00Z") });
    check("first licence: COMPLETE from A's creation", store.coverage.get(USDC)?.kind === "COMPLETE" && rowsMatchTruth(c, store, USDC, 6).ok);
    const trimmedA = stateOf(store).accounts.find((x) => x.address === a)!;
    check("the commit trims A and records from when its staged days are still exact", trimmedA.trimmedFromISO === "2026-10-06" && trimmedA.days.length === 1, JSON.stringify(trimmedA.days));
    const oct05 = store.rows.get(USDC)?.get("2026-10-05");
    // SetAuthority: B (held by someone else since Oct 1) becomes the wallet's on Oct 22.
    c.tx("2026-10-22", 9, [OTHER, b], (st) => { const x = st.get(b)!; st.set(b, { ...x, owner: OWNER }); });
    const r = await runOnce(c, store, {});
    const m = rowsMatchTruth(c, store, USDC, 6);
    check("B carried nothing of the wallet's before the hand-over ⇒ no rebuild; rows rewritten only from A's trim point, all equal truth",
      r.o.rebuilt.length === 0 && m.ok && store.rows.get(USDC)?.get("2026-10-05") === oct05 && store.rows.get(USDC)?.get("2026-10-21") === 2 && store.rows.get(USDC)?.get("2026-10-22") === 6, m.detail);
  }

  console.log("review: a closed account found AFTER commit (re-walk) ⇒ rebuild, proven rows never overwritten from a trimmed list");
  {
    const build = () => {
      const c = new Chain();
      const a = "AtaUsdc4444444444444444444444444444444444444", x = "ClosedLater44444444444444444444444444444444";
      c.tx("2026-10-02", 9, [OWNER, a], c.create(a, USDC));
      c.tx("2026-10-03", 9, [OTHER, a], mv(a, 1_000_000));
      c.tx("2026-10-06", 10, [OWNER, x], c.create(x, USDC));
      c.tx("2026-10-07", 10, [OTHER, x], mv(x, 3_000_000));
      c.tx("2026-10-09", 10, [OWNER, x, OTHER], mv(x, -3_000_000));
      c.tx("2026-10-09", 11, [OWNER, x], close(x));
      c.tx("2026-10-12", 9, [OTHER, a], mv(a, 5_000_000));
      return { c, a, x };
    };
    const { c } = build();
    // Run 1: NATIVE discovery the hook never fed X to (as if the flag had been off when native saw it).
    const store = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(c, store, { nowMs: Date.parse("2026-10-20T12:00:00Z") });
    check("first licence committed without X (A trimmed: exact from Oct 12)", store.coverage.get(USDC)?.kind === "COMPLETE"
      && stateOf(store).accounts.find((y) => y.trimmedFromISO === "2026-10-12") !== undefined);
    // The flag goes off and on: native moved unwatched ⇒ discovery re-walks, and finds X.
    const cp = JSON.parse(store.cursor()!) as SolBackfillCheckpoint;
    const moved = JSON.stringify({ ...cp, top: { ...cp.top!, signature: "native-moved-unwatched", slot: cp.top!.slot + 1 } });
    const s2 = memStore(moved, new Set([USDC]));
    for (const [k, v] of store.rows) s2.rows.set(k, new Map(v));
    for (const [k, v] of store.coverage) s2.coverage.set(k, v);
    const r2 = await runOnce(c, s2, {});
    const st2 = stateOf(s2);
    check("X joined the committed mint with balances before A's trim point ⇒ REBUILD: mint PENDING, accounts reset",
      r2.o.rebuilt.includes(USDC) && st2.mints.find((y) => y.mint === USDC)?.status === "PENDING" && st2.accounts.every((y) => y.top === null && y.days.length === 0), JSON.stringify(r2.o.rebuilt));
    check("…meanwhile the licence is WITHDRAWN (rows lacked X), never rewritten with short sums",
      s2.coverage.get(USDC)?.kind === "UNKNOWN" && (s2.rows.get(USDC)?.size ?? 0) === 0, JSON.stringify(s2.coverage.get(USDC)));
    for (let i = 0; i < 4 && s2.coverage.get(USDC)?.kind !== "COMPLETE"; i++) await runOnce(c, s2, {});
    const m = rowsMatchTruth(c, s2, USDC, 6);
    check("…the rebuilt licence equals the chain's truth every day, X included", s2.coverage.get(USDC)?.kind === "COMPLETE" && m.ok && s2.rows.get(USDC)?.get("2026-10-07") === 4 && s2.rows.get(USDC)?.get("2026-10-11") === 1, m.detail);
  }

  console.log("review: a WALK's watch — native moving unwatched after the walk restarts it");
  {
    const c = new Chain();
    const a = "AtaUsdc3333333333333333333333333333333333333", y = "ClosedLate333333333333333333333333333333333";
    c.tx("2026-10-02", 9, [OWNER, a], c.create(a, USDC));
    c.tx("2026-10-03", 9, [OTHER, a], mv(a, 1_000_000));
    // No token state: the step starts a WALK, watched from the native top as it is now.
    const store = memStore(nativeCursor(), new Set([USDC]));
    await runOnce(c, store, { nowMs: Date.parse("2026-10-20T12:00:00Z") });
    const st1 = stateOf(store);
    const cp1 = JSON.parse(store.cursor()!) as SolBackfillCheckpoint;
    check("a state the step starts is a WALK watched from the native top", st1.discovery.source === "WALK" && st1.discovery.walkDone
      && st1.discovery.watchedTop === cp1.top?.signature && store.coverage.get(USDC)?.kind === "COMPLETE");
    // Flag off: a token account is opened and closed while native moves unwatched.
    c.tx("2026-10-24", 9, [OWNER, y], c.create(y, USDC));
    c.tx("2026-10-24", 10, [OTHER, y], mv(y, 7_000_000));
    c.tx("2026-10-26", 9, [OWNER, y, OTHER], mv(y, -7_000_000));
    c.tx("2026-10-26", 10, [OWNER, y], close(y));
    const moved = { ...cp1, top: { ...cp1.top!, signature: "native-head-unwatched", slot: cp1.top!.slot + 9 } };
    check("…a WALK whose native top moved unwatched is NOT complete discovery", discoveryComplete(st1, moved) === false && splWorkOwed(st1, moved, NOW) === true);
    const s2 = memStore(JSON.stringify(moved), new Set([USDC]));
    for (const [k, v] of store.rows) s2.rows.set(k, new Map(v));
    for (const [k, v] of store.coverage) s2.coverage.set(k, v);
    for (let i = 0; i < 3 && !(stateOf(s2).discovery.walkDone && stateOf(s2).accounts.some((x) => x.address === y && x.creation)); i++) await runOnce(c, s2, {});
    const m = rowsMatchTruth(c, s2, USDC, 6);
    check("…the walk starts over, finds the account opened and closed meanwhile, and its days are in the licence",
      stateOf(s2).accounts.some((x) => x.address === y) && s2.coverage.get(USDC)?.kind === "COMPLETE" && m.ok && s2.rows.get(USDC)?.get("2026-10-25") === 8, m.detail);
    const reWalk = parseSplState((annotateWithDiscoveries({ ...moved, tokens: st1 }, [], "WALK", { demote: true }) as { tokens?: unknown }).tokens)!;
    check("…and the hook restarts a WALK when told the watch broke", reWalk.discovery.source === "WALK" && reWalk.discovery.walkDone === false && reWalk.discovery.watchedTop === "native-head-unwatched");
  }

  console.log("review: an untracked account appearing for a COMMITTED mint withdraws it (never kept as proven)");
  {
    const c = new Chain();
    const a = "AtaUsdc2222222222222222222222222222222222222";
    c.tx("2026-10-02", 9, [OWNER, a], c.create(a, USDC));
    c.tx("2026-10-03", 9, [OTHER, a], mv(a, 1_000_000));
    const store = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(c, store);
    check("COMPLETE first", store.coverage.get(USDC)?.kind === "COMPLETE");
    // The bound is full and an account of USDC could not be tracked (its history is unknown).
    const cp = JSON.parse(store.cursor()!) as SolBackfillCheckpoint & { tokens: SplHistoryState };
    // …while its licensed account also disagrees with the chain (a freeze-able failure on its own).
    const over = { ...cp, tokens: { ...cp.tokens, overflowed: [["UntrackedUsdc111111111111111111111111111111", USDC]], overflow: 1,
      accounts: cp.tokens.accounts.map((x) => ({ ...x, headMismatches: HEAD_MISMATCH_LIMIT })) } };
    const s2 = memStore(JSON.stringify(over), new Set([USDC]));
    for (const [k, v] of store.rows) s2.rows.set(k, new Map(v));
    const lying = (program: string) => program === SPL_TOKEN_PROGRAM_ID
      ? { value: [{ pubkey: a, account: { data: { parsed: { info: { mint: USDC, owner: OWNER, tokenAmount: { amount: "7", decimals: 6 } } } } } }] } : { value: [] };
    await runOnce(c, s2, { rpc: fixtureRpc(c, { overrideCurrent: lying }) });
    const cov = s2.coverage.get(USDC);
    check("…the licence is WITHDRAWN: UNSUPPORTED with an honest reason, no rows, inventory incomplete",
      cov?.kind === "UNKNOWN" && cov.caveats.includes("PAGE_BUDGET_EXHAUSTED") && (s2.rows.get(USDC)?.size ?? 0) === 0
      && stateOf(s2).mints.find((m) => m.mint === USDC)?.reason === "TOO_MANY_ACCOUNTS" && stateOf(s2).inventoryComplete === false, JSON.stringify(cov));
    check("…the refusal is final: its account stages nothing and owes no work", stateOf(s2).accounts.every((x) => x.days.length === 0)
      && splWorkOwed(stateOf(s2), JSON.parse(s2.cursor()!) as SolBackfillCheckpoint, NOW) === false);
    check("…and tokenUnverifiedReason states it plainly", tokenUnverifiedReason(cov && cov.kind === "UNKNOWN" ? cov.caveats : []) === "it has more activity than could be checked so far");
  }

  console.log("review: a head-mismatch freeze thaws when the chain agrees again");
  {
    const c = new Chain();
    const a = "AtaUsdc1212121212121212121212121212121212121";
    c.tx("2026-10-02", 9, [OWNER, a], c.create(a, USDC));
    c.tx("2026-10-03", 9, [OTHER, a], mv(a, 1_000_000));
    const store = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(c, store, { nowMs: Date.parse("2026-10-20T12:00:00Z") });
    const lying = (program: string) => program === SPL_TOKEN_PROGRAM_ID
      ? { value: [{ pubkey: a, account: { data: { parsed: { info: { mint: USDC, owner: OWNER, tokenAmount: { amount: "9000000", decimals: 6 } } } } } }] } : { value: [] };
    for (let i = 0; i < HEAD_MISMATCH_LIMIT; i++) await runOnce(c, store, { rpc: fixtureRpc(c, { overrideCurrent: lying }), nowMs: Date.parse(`2026-10-2${1 + i}T12:00:00Z`) });
    const frozen = store.coverage.get(USDC);
    check("repeated head mismatches FREEZE a committed licence: PARTIAL through its last proven day",
      frozen?.kind === "PARTIAL" && frozen.coveredToISO === "2026-10-20" && stateOf(store).mints.find((m) => m.mint === USDC)?.frozen === "RECONCILIATION_MISMATCH" && stateOf(store).inventoryComplete === false, JSON.stringify(frozen));
    await runOnce(c, store);
    const m = rowsMatchTruth(c, store, USDC, 6);
    check("…a later match THAWS it back to COMPLETE through today, rows equal truth", store.coverage.get(USDC)?.kind === "COMPLETE" && m.ok
      && (store.coverage.get(USDC) as { toISO: string }).toISO === TODAY && !stateOf(store).mints.find((x) => x.mint === USDC)?.frozen, m.detail);
  }

  console.log("review: a walk that finishes before its mint is decided is still rewritten (durable dirty day)");
  {
    const c = new Chain();
    const a = "AtaUsdc5656565656565656565656565656565656565", x = "ClosedLater56565656565656565656565656565656";
    c.tx("2026-10-02", 9, [OWNER, a], c.create(a, USDC));
    c.tx("2026-10-03", 9, [OTHER, a], mv(a, 1_000_000));
    c.tx("2026-10-06", 10, [OWNER, x], c.create(x, USDC));
    c.tx("2026-10-07", 10, [OTHER, x], mv(x, 3_000_000));
    c.tx("2026-10-09", 10, [OWNER, x, OTHER], mv(x, -3_000_000));
    c.tx("2026-10-09", 11, [OWNER, x], close(x));
    c.tx("2026-10-12", 9, [OTHER, a], mv(a, 5_000_000));
    const store = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(c, store, { nowMs: Date.parse("2026-10-20T12:00:00Z") });
    // X is found (the hook queues it); this run A disagrees with the chain, so USDC is not decided — X's walk finishes anyway.
    const cp = JSON.parse(store.cursor()!) as SolBackfillCheckpoint & { tokens: SplHistoryState };
    const queued = { ...cp, tokens: { ...cp.tokens, pendingDiscovered: [{ address: x, mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }] } };
    const s2 = memStore(JSON.stringify(queued), new Set([USDC]));
    for (const [k, v] of store.rows) s2.rows.set(k, new Map(v));
    for (const [k, v] of store.coverage) s2.coverage.set(k, v);
    const lying = (program: string) => program === SPL_TOKEN_PROGRAM_ID
      ? { value: [{ pubkey: a, account: { data: { parsed: { info: { mint: USDC, owner: OWNER, tokenAmount: { amount: "1", decimals: 6 } } } } } }] } : { value: [] };
    const r2 = await runOnce(c, s2, { rpc: fixtureRpc(c, { overrideCurrent: lying }) });
    const xs = stateOf(s2).accounts.find((y) => y.address === x)!;
    check("X walked to creation while USDC waited (no decision this run)", xs.creation && r2.o.mintsCommitted.length === 0 && xs.dirtyFromISO === "2026-10-06", JSON.stringify(r2.o.mintsCommitted));
    const r3 = await runOnce(c, s2);
    check("…the next run still sees X's early days and REBUILDS (never keeps rows that lack X)", r3.o.rebuilt.includes(USDC) && s2.coverage.get(USDC)?.kind === "UNKNOWN");
    for (let i = 0; i < 4 && s2.coverage.get(USDC)?.kind !== "COMPLETE"; i++) await runOnce(c, s2);
    const m = rowsMatchTruth(c, s2, USDC, 6);
    check("…then equals the chain's truth", s2.coverage.get(USDC)?.kind === "COMPLETE" && m.ok, m.detail);
  }

  console.log("review: Token-2022 / unknown program");
  {
    const st = mergeDiscovered(freshSplState("NATIVE"), [{ address: "x", mint: "NoProgMint", program: null, decimals: 6 }]);
    const m = st.mints[0];
    check("a mint first seen WITHOUT a program id is checked, never assumed classic", m.extension === null && needsExtensionCheck(m));
    const weird = mergeDiscovered(freshSplState("NATIVE"), [{ address: "y", mint: "WeirdMint", program: "SomeOtherProgram111111111111111111111111111", decimals: 6 }]);
    check("a mint seen under an UNKNOWN token program is refused outright (fail closed, no request spent)",
      weird.mints[0].extension === "UNRECOGNISED_EXTENSION" && !needsExtensionCheck(weird.mints[0])
      && decideMint(weird.mints[0], weird.accounts, { discoveryComplete: true, verifiedThisRun: new Set(["y"]), todayISO: TODAY }).status === "UNSUPPORTED");
    const later = mergeDiscovered(mergeDiscovered(freshSplState("NATIVE"), [{ address: "z", mint: "LaterMint", program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }]),
      [{ address: "z2", mint: "LaterMint", program: "SomeOtherProgram111111111111111111111111111", decimals: 6 }]);
    check("…even when first seen as classic SPL", later.mints[0].extension === "UNRECOGNISED_EXTENSION");
    let threw = false;
    try { mintExtensionVerdict({ value: { data: { parsed: { type: "mint", info: {} } } } }); } catch { threw = true; }
    check("a mint answer that states no owning program is unreadable (retried), never assumed safe", threw);
    check("a mint owned by an unknown program is refused", mintExtensionVerdict({ value: { owner: "SomeOtherProgram111111111111111111111111111", data: { parsed: { type: "mint", info: {} } } } }) === "UNRECOGNISED_EXTENSION");
    check("a mint owned by classic SPL with no extensions is OK", mintExtensionVerdict({ value: { owner: SPL_TOKEN_PROGRAM_ID, data: { parsed: { type: "mint", info: {} } } } }) === "OK");
    check("an unchecked mint is never decided", decideMint(m, st.accounts, { discoveryComplete: true, verifiedThisRun: new Set(["x"]), todayISO: TODAY }).status === "PENDING");
  }

  console.log("review: frozen licence after a head gap");
  {
    const c = new Chain();
    const ata = "AtaUsdc7777777777777777777777777777777777777";
    c.tx("2026-10-02", 9, [OWNER, ata], c.create(ata, USDC));
    c.tx("2026-10-03", 9, [OTHER, ata], mv(ata, 1_000_000));
    const store = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(c, store, {});
    check("COMPLETE first", store.coverage.get(USDC)?.kind === "COMPLETE");
    const rowsBefore = JSON.stringify([...store.rows.get(USDC)!]);
    const lost = c.tx("2026-10-29", 9, [OTHER, ata], mv(ata, 5_000_000));
    c.tx("2026-10-30", 9, [OTHER, ata], mv(ata, 1_000_000));
    c.hide(ata, lost);
    const later = Date.parse("2026-10-31T12:00:00Z");
    await runOnce(c, store, { nowMs: later });
    const cov = store.coverage.get(USDC);
    const ms = stateOf(store).mints.find((m) => m.mint === USDC)!;
    check("a head gap after commit FREEZES the licence: PARTIAL through its last proven day, rows untouched",
      cov?.kind === "PARTIAL" && cov.coveredToISO === TODAY && ms.frozen === "RECONCILIATION_MISMATCH" && JSON.stringify([...store.rows.get(USDC)!]) === rowsBefore, JSON.stringify(cov));
    check("…the wallet's token inventory is no longer complete", stateOf(store).inventoryComplete === false);
    await runOnce(c, store, { nowMs: later + 86_400_000 });
    check("…and it never extends again", store.coverage.get(USDC)?.kind === "PARTIAL" && (store.coverage.get(USDC) as { coveredToISO: string }).coveredToISO === TODAY);
    // Later: a re-walk finds an OLDER closed USDC account the frozen rows never summed ⇒ withdrawn.
    const older = "OlderClosed7777777777777777777777777777777";
    const cpF = JSON.parse(store.cursor()!) as SolBackfillCheckpoint & { tokens: SplHistoryState };
    const withOlder = { ...cpF, tokens: { ...cpF.tokens, pendingDiscovered: [{ address: older, mint: USDC, program: SPL_TOKEN_PROGRAM_ID, decimals: 6 }] } };
    c.txs.unshift(...(() => { const o = new Chain(); o.tx("2026-10-01", 1, [OWNER, older], o.create(older, USDC)); o.tx("2026-10-01", 2, [OTHER, older], mv(older, 2_000_000));
      o.tx("2026-10-02", 1, [OWNER, older, OTHER], mv(older, -2_000_000)); o.tx("2026-10-02", 2, [OWNER, older], close(older));
      return o.txs.map((t, i) => ({ ...t, slot: 100 + i, view: { ...(t.view as object), slot: 100 + i } })); })());
    const sF = memStore(JSON.stringify(withOlder), new Set([USDC]));
    for (const [k, v] of store.rows) sF.rows.set(k, new Map(v));
    await runOnce(c, sF, { nowMs: later + 2 * 86_400_000 });
    check("a FROZEN licence is re-checked: a later-found account that held the mint during it WITHDRAWS it (no stale PARTIAL rows)",
      sF.coverage.get(USDC)?.kind === "UNKNOWN" && (sF.rows.get(USDC)?.size ?? 0) === 0, JSON.stringify(sF.coverage.get(USDC)));
    const cpU = JSON.parse(store.cursor()!) as SolBackfillCheckpoint & { tokens: SplHistoryState };
    const sU = memStore(JSON.stringify({ ...cpU, tokens: { ...cpU.tokens, overflowMints: [USDC], overflow: 1 } }), new Set([USDC]));
    for (const [k, v] of store.rows) sU.rows.set(k, new Map(v));
    await runOnce(c, sU, { nowMs: later + 2 * 86_400_000 });
    check("…and an untracked account of it withdraws it too", sU.coverage.get(USDC)?.kind === "UNKNOWN" && (sU.rows.get(USDC)?.size ?? 0) === 0, JSON.stringify(sU.coverage.get(USDC)));
    const facet = { label: "USDC", standard: "SPL" as const, priceStatus: "MARKET_PRICE" as const, firstObservedISO: "2026-10-02", lastObservedISO: "2026-10-31",
      historyState: "RECONSTRUCTED" as const, coverageKind: "PARTIAL" as const, licensedFromISO: "2026-10-02", licensedToISO: TODAY };
    check("customer copy says the verified stretch ENDS, not that earlier history is missing",
      tokenHistoryText(facet) === "Verified from Oct 2, 2026 through Oct 28, 2026 — later activity couldn’t be proven", tokenHistoryText(facet));
  }

  console.log("review: a transient throttle is not an unproductive run");
  {
    const c = new Chain();
    const ata = "AtaThrottle1111111111111111111111111111111111";
    c.tx("2026-10-03", 9, [OWNER, ata], c.create(ata, USDC));
    const throttled: SolRpcCall = async (method) => { if (method === "getTokenAccountsByOwner") throw new SolTransportError("PROVIDER_THROTTLED", "429"); return null; };
    const store = memStore(watchedCursor(), new Set([USDC]));
    for (let i = 0; i < BACKOFF_AFTER + 1; i++) await runOnce(c, store, { rpc: throttled, nowMs: NOW + i * 1000 });
    check("repeated throttles never back the wallet off for a day", (stateOf(store).backoff?.count ?? 0) === 0, JSON.stringify(stateOf(store).backoff));
  }

  console.log("review: backoff, ordering, sync limit, checkpoint size, price marker");
  {
    const c = new Chain();
    const ata = "AtaT22888888888888888888888888888888888888888";
    c.tx("2026-10-03", 9, [OWNER, ata], c.create(ata, PYUSD, { program: TOKEN_2022_PROGRAM_ID }));
    const base = fixtureRpc(c);
    const unreadable: SolRpcCall = async (method, params) => (method === "getAccountInfo" ? { value: null } : base(method, params));
    const store = memStore(watchedCursor(), new Set([PYUSD]));
    for (let i = 0; i <= BACKOFF_AFTER; i++) await runOnce(c, store, { rpc: unreadable, nowMs: NOW + i * 1000 });
    const st = stateOf(store);
    const cpNow = JSON.parse(store.cursor()!) as SolBackfillCheckpoint;
    check("unproductive runs back off: no worker run for a day", (st.backoff?.count ?? 0) >= BACKOFF_AFTER && splWorkOwed(st, cpNow, NOW + 5000) === false && splWorkOwed(st, cpNow, NOW + BACKOFF_MS + 5000) === true);
    const importing = { ...cpNow, reachedBeginning: false, completedAtISO: null, tokens: undefined };
    const rows = [
      { accountId: "tokenOnly", connectionId: "c1", cursor: null, address: OWNER, checkpoint: { ...cpNow, tokens: { ...st, backoff: { count: 0, lastAtISO: null } } } },
      { accountId: "nativeWork", connectionId: "c2", cursor: null, address: OWNER, checkpoint: importing },
    ];
    const ordered = orderCandidates(rows, NOW, true);
    check("token-only work is ordered AFTER native imports", ordered.map((r) => r.accountId).join() === "nativeWork,tokenOnly", ordered.map((r) => r.accountId).join());
    check("a backed-off token-only wallet is not a candidate", orderCandidates([{ ...rows[0], checkpoint: { ...cpNow, tokens: st } }], NOW + 5000, true).length === 0);
    check("a sync's token step has a small explicit request limit", splSyncRequestLimit({}) === 25 && splSyncRequestLimit({ SPL_HISTORY_SYNC_REQUEST_LIMIT: "5" }) === 5 && splSyncRequestLimit({ SPL_HISTORY_SYNC_REQUEST_LIMIT: "x" }) === 25);

    // Checkpoint size: an account with more active days than the bound keeps its NEWEST days and is proven from the first kept (never refused).
    const big = new Chain();
    const hot = "AtaHot99999999999999999999999999999999999999";
    big.tx("2023-01-01", 9, [OWNER, hot], big.create(hot, USDC));
    for (let i = 0; i < MAX_DAYS_PER_ACCOUNT + 5; i++) big.tx(new Date(Date.parse("2023-01-02T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10), 9, [OTHER, hot], mv(hot, 1));
    const bs = memStore(watchedCursor(), new Set([USDC]));
    await runOnce(big, bs, {});
    const bst = stateOf(bs);
    const bcov = bs.coverage.get(USDC);
    const bm = rowsMatchTruth(big, bs, USDC, 6);
    check("more active days than one account may stage ⇒ NOT refused: PARTIAL from the first kept day (PAGE_BUDGET_EXHAUSTED), rows equal truth, staging bounded",
      bst.accounts[0]?.failure === null && bst.accounts[0]?.capped === true && stagedDays(bst) <= MAX_DAYS_PER_ACCOUNT
        && bcov?.kind === "PARTIAL" && bcov.coveredFromISO === "2023-01-07" && bcov.caveats.includes("PAGE_BUDGET_EXHAUSTED") && bm.ok, `${JSON.stringify(bcov)} ${bm.detail}`);

    // Price marker: records what was RETURNED, re-reads before writing.
    let meta: Record<string, unknown> = { quote: { attemptedAt: "2026-10-28T00:00:00Z", outcome: "PRICED", pricedAt: "2026-10-28T00:00:00Z" } };
    let reads = 0;
    const fake = {
      instrumentAlias: {
        findUnique: async () => { reads++; if (reads === 2) meta = { ...meta, quote: { ...(meta.quote as object), attemptedAt: "2026-10-28T09:00:00Z" } }; return { metadata: meta }; },
        update: async (a: { data: { metadata: Record<string, unknown> } }) => { meta = a.data.metadata; return {}; },
      },
      priceObservation: { createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }) },
    };
    const out = await acquireTokenHistoricalCloses({
      client: fake as never, instrumentId: "i", assetKey: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${USDC}`, fromISO: "2026-10-01", toISO: TODAY,
      budget: { remaining: async () => 10, record: async () => {}, pace: async () => {} },
      fetchCloses: async () => ({ configured: true, unlisted: false, closes: [{ dateISO: "2026-10-01", price: 1 }, { dateISO: "2026-10-10", price: 1 }] }),
      now: new Date(NOW), historyDays: 365,
    });
    const ph = meta.priceHistory as { toISO: string };
    check("price marker records the last day actually RETURNED, not the day asked", out.inserted === 2 && ph.toISO === "2026-10-10", JSON.stringify(ph));
    check("…and the quote marker written concurrently is preserved (re-read before write)", (meta.quote as { attemptedAt: string }).attemptedAt === "2026-10-28T09:00:00Z");
  }

  // ══ FIRST-TIME QUOTE PROBE (parity with ERC-20): a SOLD mint reaches the price path ══
  console.log("first-time quote probe: sold mints");
  {
    const c = new Chain();
    const ata = "AtaBonkSold11111111111111111111111111111111";
    c.tx("2026-10-02", 9, [OWNER, ata], c.create(ata, BONK, { decimals: 5 }));
    c.tx("2026-10-03", 9, [OTHER, ata], mv(ata, 10_000_000));
    c.tx("2026-10-09", 9, [OWNER, ata, OTHER], mv(ata, -10_000_000)); // sold everything: no balance now, no marker from capture
    const sold = (probe: string, status = "THIN_OR_UNPRICED") => {
      const st = memStore(watchedCursor(), new Set()); // BONK is NOT in pricedMints
      st.acquirePrices = async (m) => { st.priceCalls.push({ mint: m.mint, fromISO: m.fromISO, toISO: m.toISO }); return { inserted: 0, earliestISO: null, status, probe }; };
      return st;
    };
    const s1 = sold("PROBED");
    const { o: o1 } = await runOnce(c, s1, { freshSource: "NATIVE" });
    check("probe: an UNPRICED licensed (sold) mint is still handed to the price path (the store's probe decides)",
      s1.priceCalls.length === 1 && s1.priceCalls[0].mint === BONK && o1.prices.status === "COMPLETE" && o1.prices.mintsSkipped === 0, JSON.stringify({ c: s1.priceCalls, p: o1.prices }));
    const s2 = sold("REFUSED");
    const { o: o2 } = await runOnce(c, s2, { freshSource: "NATIVE" });
    check("probe: a REFUSED probe ⇒ prices ALLOWANCE_EXHAUSTED with a reason and the mint counted (never silent)",
      o2.prices.status === "ALLOWANCE_EXHAUSTED" && /allowance/.test(o2.prices.reason ?? "") && o2.prices.mintsSkipped === 1, JSON.stringify(o2.prices));
    check("probe: …and it never marks balance history incomplete (the mint commits COMPLETE, rows = truth)",
      o2.mintsCommitted.some((x) => x.mint === BONK && x.status === "COMPLETE") && s2.coverage.get(BONK)?.kind === "COMPLETE" && rowsMatchTruth(c, s2, BONK, 5).ok && o2.stoppedBecause === "DONE",
      JSON.stringify({ m: o2.mintsCommitted, cov: s2.coverage.get(BONK) }));
    const s3 = sold("REFUSED", "BUDGET");
    const { o: o3 } = await runOnce(c, s3, { freshSource: "NATIVE" });
    check("probe: a refused probe AND a budget stop ⇒ BUDGET_STOPPED (worst wins), the mint counted once",
      o3.prices.status === "BUDGET_STOPPED" && o3.prices.mintsSkipped === 1, JSON.stringify(o3.prices));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
