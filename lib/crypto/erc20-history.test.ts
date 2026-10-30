/**
 * lib/crypto/erc20-history.test.ts
 *
 * ERC-20 HISTORICAL token balances — deterministic fixtures only (documented
 * alchemy_getAssetTransfers / eth_call / eth_getBlockByNumber shapes, an
 * in-memory chain and store; no network, no database).
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/erc20-history.test.ts
 *
 * Pinned: multi-token reconstruction, mint/burn, out-of-order + duplicate
 * transfers, anchor mismatch ⇒ UNSUPPORTED with no fabricated rows (rebasing,
 * fee-on-transfer, eth_call revert), resumption across steps, budget
 * exhaustion, native checkpoint/coverage untouched, wallet completeness needs
 * every token, priced-first ordering, regeneration flagged and run by the pass,
 * daily extension (and a refuted extension), historical token prices, copy.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  readErc20Section, withErc20Section, carriedTokens, summarizeSection, erc20HistoryComplete, anchorPlan, judgeAnchors,
  derivedRows, spreadIndices, parseAssetTransfers, unsupportedReasonOf, unsupportedCoverage, unsupportedReasonText,
  erc20HistoryConfig, ERC20_HISTORY_SOURCE, REASON_CAVEAT, emptySection, closeSegment, erc20WorkOwed, erc20BackedOff, resetErc20Section,
  ERC20_BACKOFF_AFTER, ERC20_BACKOFF_MS, ERC20_CALL_FAILURE_LIMIT, ERC20_CALL_RETRY_MS, ERC20_SEGMENT_RESTART_AFTER, ERC20_SEGMENT_RESTART_LIMIT, ERC20_SCAN_STUCK_AFTER,
  type Erc20HistorySection, type Erc20ContractHistory,
} from "./erc20-history.core";
import { isExecutionRevert } from "./erc20-history-rpc";
import { licensedInterval, coverageFromRow } from "./position-coverage";
import { runErc20HistoryStep, type Erc20HistoryStore, type Erc20TokenWrite, type KnownToken } from "./erc20-history";
import { planErc20History, runErc20HistoryPass, type Erc20HistoryPassDeps } from "./erc20-history-pass";
import { queuedCheckpoint, serializeCheckpoint, parseCheckpoint } from "./eth-history-backfill.core";
import { walletHistoryComplete, facetFromCoverage, TOKEN_HISTORY_CHAINS } from "./wallet-instrument-history";
import { tokensValueOnDay, tokenValueOnDay, reconstructedTokenValuation, tokenValuationLimits, tokenDayMissingRequiredPrice, tokenHasNoMarket, tokenValuationExclusion, cryptoDayHeldUnvalued, cryptoTokenDayDecision, tokenCloseGaps } from "./token-valuation.core";
import { planDayPersistence } from "@/lib/snapshots/regeneration-candidates.core";
import { regenerateDay } from "@/lib/snapshots/regenerate-history.core";
import { valueCryptoDay } from "./historical-crypto-valuation.core";
import { heldSpanFrom } from "./token-held-spans";
import { resolveEvidenceFloor } from "@/lib/snapshots/historical-work-window";
import { loadWalletInstrumentHistory } from "./wallet-instrument-history";
import { loadValuationCoverage } from "@/lib/connections/valuation-coverage";
import { IS_TOKEN_INSTRUMENT } from "./token-asset";
import type { ChainCoverage } from "./chain-movement";
import { tokenHistoryText, connectionHealth, connectionHistory, tokenValuationText } from "@/lib/connections/connection-detail.core";
import { deriveValuationCoverage, valuationCoverageNote, laterHoldingsUnpricedText, tokenPriceGapsText } from "@/lib/connections/valuation-coverage.core";
import { acquireTokenHistoricalCloses, TOKEN_HISTORY_PRICE_SOURCE } from "@/lib/prices/token-history-prices";
import { fetchCoinGeckoTokenDailyClosesUsd, TOKEN_HISTORICAL_PRICE_SEAM } from "@/lib/prices/providers/coingecko";
import { coinGeckoUsageToday, TOKEN_HISTORY_METRIC_PREFIX, COINGECKO_USAGE_NETWORK, COINGECKO_USAGE_PROVIDER } from "@/lib/prices/coingecko-budget";
import { acquireErc20HistoricalPrices, needsQuoteProbe, probeAllowance, defaultProbeGate, ERC20_PROBE_RETRY_MS, ERC20_PROBE_USAGE_PROVIDER, ERC20_PROBE_USAGE_UNIT } from "./erc20-history-prices";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER  = "0x2222222222222222222222222222222222222222";
const ZERO_A = "0x0000000000000000000000000000000000000000";
const USDC   = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI    = "0x6b175474e89094c44da98b954eedeac495271d0f";
const STETH  = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const FEE    = "0x3333333333333333333333333333333333333333";
const BAD    = "0x4444444444444444444444444444444444444444";
const SPAM   = "0x5555555555555555555555555555555555555555";

// ── An in-memory chain: block b is at 2026-01-01 + b hours ─────────────────
const T0 = Date.UTC(2026, 0, 1);
const tsOf = (b: number) => T0 + b * 3_600_000;
const dayOf = (b: number) => new Date(tsOf(b)).toISOString().slice(0, 10);

interface Tx { contract: string; block: number; log: number; from: string; to: string; raw: bigint; decimals?: number | null }
interface Chain {
  head: number;
  txs: Tx[];
  /** Extra on-chain balance (beyond the transfers) from a block: rebasing / fee. */
  drift?: Record<string, { fromBlock: number; delta: bigint }>;
  revert?: Set<string>;
  pageSize?: number;
  /** Shuffle + duplicate transfers in every page. */
  messy?: boolean;
  /** A per-call eth_call error (transient or real), by contract and block. */
  callError?: (contract: string, block: number) => { code: number; message: string } | null;
  /** Every request answers 429 (capacity). */
  throttle?: boolean;
  /** Fail the transfer page at this pageKey (an expired pageKey). */
  failPageKey?: string;
  /** Corrupt the rawContract.value of transfers of this contract. */
  unreadable?: string;
  calls: string[];
}

function chainBalance(c: Chain, contract: string, block: number): bigint {
  let b = BigInt(0);
  for (const t of c.txs) {
    if (t.contract !== contract || t.block > block) continue;
    if (t.to === WALLET) b += t.raw;
    if (t.from === WALLET) b -= t.raw;
  }
  const d = c.drift?.[contract];
  if (d && block >= d.fromBlock) b += d.delta;
  return b;
}

function transferJson(t: Tx) {
  const hash = "0x" + (t.block * 1000 + t.log).toString(16).padStart(64, "0");
  return {
    blockNum: "0x" + t.block.toString(16), uniqueId: `${hash}:log:${t.log}`, hash, from: t.from, to: t.to,
    value: Number(t.raw) / 1e6, asset: "TKN", category: "erc20",
    rawContract: { value: "0x" + t.raw.toString(16).padStart(64, "0"), address: t.contract, decimal: t.decimals === null ? null : "0x" + (t.decimals ?? 6).toString(16) },
    metadata: { blockTimestamp: new Date(tsOf(t.block)).toISOString() },
  };
}

function transport(c: Chain) {
  const one = (call: { id: number; method: string; params: unknown[] }) => {
    c.calls.push(call.method);
    if (c.throttle) return { jsonrpc: "2.0", id: call.id, error: { code: 429, message: "capacity" } };
    if (call.method === "eth_getBlockByNumber") {
      return { jsonrpc: "2.0", id: call.id, result: { number: "0x" + c.head.toString(16), timestamp: "0x" + Math.floor(tsOf(c.head) / 1000).toString(16) } };
    }
    if (call.method === "alchemy_getAssetTransfers") {
      const p = call.params[0] as { fromBlock: string; toBlock: string; fromAddress?: string; toAddress?: string; pageKey?: string };
      const lo = Number(BigInt(p.fromBlock)), hi = Number(BigInt(p.toBlock));
      const all = c.txs.filter((t) => t.block >= lo && t.block <= hi && (p.fromAddress ? t.from === p.fromAddress.toLowerCase() : t.to === p.toAddress!.toLowerCase()))
        .sort((a, b) => a.block - b.block || a.log - b.log);
      const size = c.pageSize ?? 1000;
      const off = p.pageKey ? Number(p.pageKey) : 0;
      if (c.failPageKey && p.pageKey === c.failPageKey) return { jsonrpc: "2.0", id: call.id, error: { code: -32602, message: "invalid pageKey" } };
      let page = all.slice(off, off + size).map(transferJson)
        .map((t) => (c.unreadable && t.rawContract.address === c.unreadable ? { ...t, rawContract: { ...t.rawContract, value: null as unknown as string } } : t));
      if (c.messy && page.length > 0) page = [...page].reverse().concat([page[0]]);
      return { jsonrpc: "2.0", id: call.id, result: { transfers: page, ...(off + size < all.length ? { pageKey: String(off + size) } : {}) } };
    }
    if (call.method === "eth_call") {
      const [{ to }, tag] = call.params as [{ to: string; data: string }, string];
      const err = c.callError?.(to, Number(BigInt(tag)));
      if (err) return { jsonrpc: "2.0", id: call.id, error: err };
      if (c.revert?.has(to)) return { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted" } };
      const block = Number(BigInt(tag));
      if (!c.txs.some((t) => t.contract === to && t.block <= block + 1) && block < Math.min(...c.txs.filter((t) => t.contract === to).map((t) => t.block))) {
        return { jsonrpc: "2.0", id: call.id, result: "0x" }; // not deployed yet
      }
      return { jsonrpc: "2.0", id: call.id, result: "0x" + chainBalance(c, to, block).toString(16).padStart(64, "0") };
    }
    return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "method not found" } };
  };
  return async (body: unknown) => JSON.stringify(Array.isArray(body) ? body.map(one) : one(body as never));
}

// ── An in-memory store ─────────────────────────────────────────────────────
interface Mem {
  cursor: string | null;
  rows: Map<string, Map<string, number>>; // instrumentId → date → qty
  coverage: Map<string, ChainCoverage>;
  known: Map<string, KnownToken>;
  commits: number;
}
function memStore(m: Mem): Erc20HistoryStore {
  return {
    walletAddress: WALLET,
    readCursor: async () => m.cursor,
    casCursor: async (exp, next) => { if (m.cursor !== exp) return false; m.cursor = next; return true; },
    knownTokens: async () => m.known,
    resolveInstrument: async (contract) => `inst:${contract}`,
    async commit({ expectedCursor, nextCursor, writes }) {
      if (m.cursor !== expectedCursor) { const { Erc20CheckpointConflictError } = await import("./erc20-history"); throw new Erc20CheckpointConflictError(); }
      for (const w of writes as Erc20TokenWrite[]) {
        const r = m.rows.get(w.instrumentId) ?? new Map<string, number>();
        if (w.kind === "VERIFIED") {
          for (const d of [...r.keys()]) if (d >= w.replaceFromISO) r.delete(d);
          for (const row of w.rows) r.set(row.dateISO, row.quantity);
          m.rows.set(w.instrumentId, r);
        } else m.rows.delete(w.instrumentId);
        m.coverage.set(w.instrumentId, w.coverage);
      }
      m.cursor = nextCursor; m.commits++;
    },
  };
}
const newMem = (cursor: string | null = null): Mem => ({ cursor, rows: new Map(), coverage: new Map(), known: new Map(), commits: 0 });
const CFG = { maxPagesPerStep: 20, maxTokensPerStep: 8, maxMonthAnchors: 6, maxContracts: 300 };
const ACC = "acc-eth-1";

async function step(chain: Chain, m: Mem, opts: { budget?: number; today?: string; cfg?: Partial<typeof CFG>; meter?: Record<string, number>; now?: number; retries?: number } = {}) {
  const meter = opts.meter ?? {};
  return runErc20HistoryStep({ accountId: ACC, store: memStore(m), todayISO: opts.today ?? "2026-10-28" },
    { config: { ...CFG, ...opts.cfg }, requestBudget: opts.budget ?? 500, ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
      eth: { transport: transport(chain), meter, throttleRetries: opts.retries ?? 0, sleepImpl: async () => {} } });
}
const sectionOf = (m: Mem) => readErc20Section(m.cursor, ACC).section!;
const tx = (contract: string, block: number, from: string, to: string, raw: number, log = 0, decimals?: number | null): Tx =>
  ({ contract, block, log, from, to, raw: BigInt(raw), decimals });

async function main(): Promise<void> {
  // ── 1. Normal multi-token reconstruction ─────────────────────────────────
  {
    const chain: Chain = { head: 6000, calls: [], txs: [
      tx(USDC, 100, OTHER, WALLET, 5_000_000),          // +5 USDC  (Jan 5)
      tx(USDC, 900, WALLET, OTHER, 2_000_000),          // −2       (Feb 7)
      tx(USDC, 905, OTHER, WALLET, 500_000, 1),         // +0.5 same day
      tx(USDC, 3000, WALLET, OTHER, 3_500_000),         // −3.5 → 0 (May 6)
      tx(DAI, 200, OTHER, WALLET, 1_000_000_000_000_000_000, 0, 18),
      tx(DAI, 4000, OTHER, WALLET, 1_000_000_000_000_000_000, 0, 18),
    ] };
    const m = newMem();
    const meter: Record<string, number> = {};
    const o = await step(chain, m, { meter });
    check("multi: both tokens verified", o.verified.sort().join() === [DAI, USDC].sort().join(), JSON.stringify(o));
    check("multi: no unsupported", o.unsupported.length === 0);
    const usdc = m.rows.get(`inst:${USDC}`)!;
    check("multi: USDC first row is the first transfer day", [...usdc.keys()].sort()[0] === dayOf(100));
    check("multi: USDC end-of-day sums (+5, then −2 +0.5 same day)", usdc.get(dayOf(100)) === 5 && usdc.get(dayOf(900)) === 3.5);
    check("multi: dense while held", usdc.get(dayOf(2000)) === 3.5);
    check("multi: one zero row closes the run, none after", usdc.get(dayOf(3000)) === 0 && !usdc.has(dayOf(3100)) && !usdc.has(dayOf(6000)));
    check("multi: DAI 18 decimals exact", m.rows.get(`inst:${DAI}`)!.get(dayOf(200)) === 1 && m.rows.get(`inst:${DAI}`)!.get(dayOf(6000)) === 2);
    const cov = m.coverage.get(`inst:${USDC}`)!;
    check("multi: COMPLETE coverage first day → head day", cov.kind === "COMPLETE" && cov.fromISO === dayOf(100) && cov.toISO === dayOf(6000) && cov.source === ERC20_HISTORY_SOURCE);
    const s = sectionOf(m);
    check("multi: evidence counts kept", s.contracts[USDC].transfers === 4 && s.contracts[DAI].transfers === 2);
    check("multi: regeneration marker = earliest first day", s.snapshotPendingFromISO === dayOf(100) && o.impactedFromISO === dayOf(100));
    check("multi: every call metered", Object.values(meter).reduce((a, b) => a + b, 0) === o.requests && o.requests === chain.calls.length);
    check("multi: scan = head + from + to", chain.calls.filter((c) => c === "alchemy_getAssetTransfers").length === 2 && chain.calls.filter((c) => c === "eth_getBlockByNumber").length === 1);
    check("multi: usage recorded on the section", s.usage?.requests === o.requests);
    const again = await step(chain, m);
    check("multi: same day again owes nothing", again.stoppedBecause === "NOTHING_OWED" && again.requests === 0);
  }

  // ── 2. Mint and burn ─────────────────────────────────────────────────────
  {
    const chain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 50, ZERO_A, WALLET, 10_000_000), tx(USDC, 500, WALLET, ZERO_A, 4_000_000)] };
    const m = newMem();
    const o = await step(chain, m);
    check("mint/burn: verified", o.verified[0] === USDC, JSON.stringify(o));
    check("mint/burn: mint +10, burn −4", m.rows.get(`inst:${USDC}`)!.get(dayOf(50)) === 10 && m.rows.get(`inst:${USDC}`)!.get(dayOf(3000)) === 6);
  }

  // ── 3. Out-of-order and duplicate transfers ──────────────────────────────
  {
    const txs = [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(USDC, 100, OTHER, WALLET, 2_000_000, 1), tx(USDC, 700, WALLET, OTHER, 500_000), tx(USDC, 701, WALLET, WALLET, 9_000_000)];
    const clean = newMem(); await step({ head: 2000, calls: [], txs }, clean);
    const messy = newMem(); const o = await step({ head: 2000, calls: [], txs, messy: true }, messy);
    check("messy: verified despite reversed pages + a duplicate", o.verified[0] === USDC, JSON.stringify(o));
    check("messy: identical rows to the clean run", JSON.stringify([...messy.rows.get(`inst:${USDC}`)!]) === JSON.stringify([...clean.rows.get(`inst:${USDC}`)!]));
    check("messy: self-transfer nets zero", messy.rows.get(`inst:${USDC}`)!.get(dayOf(2000)) === 2.5);
    check("messy: duplicate not counted as evidence", sectionOf(messy).contracts[USDC].transfers === 4);
  }

  // ── 4–6. Anchor mismatch ⇒ UNSUPPORTED, no rows ──────────────────────────
  {
    const chain: Chain = { head: 5000, calls: [], revert: new Set([BAD]),
      drift: { [STETH]: { fromBlock: 2000, delta: BigInt(37) }, [FEE]: { fromBlock: 300, delta: BigInt(-10_000) } },
      txs: [
        tx(USDC, 100, OTHER, WALLET, 1_000_000),
        tx(STETH, 150, OTHER, WALLET, 1_000_000_000_000_000_000, 0, 18),
        tx(FEE, 300, OTHER, WALLET, 1_000_000),
        tx(BAD, 400, OTHER, WALLET, 1_000_000),
      ] };
    const m = newMem();
    m.rows.set(`inst:${STETH}`, new Map([["2026-01-01", 99]])); // a stale row from nowhere must not survive
    const o = await step(chain, m);
    const reasons = Object.fromEntries(o.unsupported.map((u) => [u.contract, u.reason]));
    check("rebasing ⇒ REBASING_OR_NONSTANDARD", reasons[STETH] === "REBASING_OR_NONSTANDARD", JSON.stringify(reasons));
    check("fee-on-transfer ⇒ FEE_ON_TRANSFER_OR_NONSTANDARD", reasons[FEE] === "FEE_ON_TRANSFER_OR_NONSTANDARD");
    // S5 — one revert is INCONCLUSIVE (retried later), not a verdict; three spaced ones refuse (section 18).
    check("revert ⇒ inconclusive on the first read, not refused", reasons[BAD] === undefined && o.inconclusive.includes(BAD) && !m.coverage.has(`inst:${BAD}`), JSON.stringify(o.inconclusive));
    check("unsupported: no rows for any of them", !m.rows.has(`inst:${STETH}`) && !m.rows.has(`inst:${FEE}`) && !m.rows.has(`inst:${BAD}`));
    const cs = m.coverage.get(`inst:${STETH}`)!;
    check("unsupported: UNKNOWN coverage with the reason caveat", cs.kind === "UNKNOWN" && cs.caveats.includes(REASON_CAVEAT.REBASING_OR_NONSTANDARD) && unsupportedReasonOf(cs) === "REBASING_OR_NONSTANDARD");
    check("unsupported: facet is UNLICENSED", facetFromCoverage(cs).state === "UNLICENSED");
    check("unsupported: evidence count kept", sectionOf(m).contracts[STETH].transfers === 1 && sectionOf(m).contracts[STETH].state === "UNSUPPORTED");
    check("the normal token beside them still verified", o.verified.includes(USDC));
    check("unsupported never verified ⇒ no regeneration from it", o.impactedFromISO === dayOf(100));
    const again = await step({ ...chain, head: 5100, calls: [] }, m, { today: "2026-10-29" });
    check("unsupported is terminal: no anchors re-spent next day", !again.verified.includes(STETH) && !again.unsupported.some((u) => u.contract === STETH));
  }
  {
    // Opening balance: credited at genesis without an event (balance before the first transfer).
    const chain: Chain = { head: 2000, calls: [], drift: { [USDC]: { fromBlock: 0, delta: BigInt(5) } }, txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(DAI, 1, OTHER, WALLET, 1)] };
    const m = newMem();
    const o = await step(chain, m);
    check("opening ≠ 0 ⇒ OPENING_BALANCE_UNEXPLAINED", o.unsupported.find((u) => u.contract === USDC)?.reason === "OPENING_BALANCE_UNEXPLAINED", JSON.stringify(o.unsupported));
    // A replay that goes negative is refused before any call.
    const neg = newMem();
    const o2 = await step({ head: 2000, calls: [], txs: [tx(USDC, 100, WALLET, OTHER, 1_000_000)] }, neg);
    check("negative replay ⇒ OPENING_BALANCE_UNEXPLAINED", o2.unsupported[0]?.reason === "OPENING_BALANCE_UNEXPLAINED");
    // Unknown decimals: refused, no instrument created, no rows.
    const dec = newMem();
    const o3 = await step({ head: 2000, calls: [], txs: [tx(SPAM, 100, OTHER, WALLET, 7, 0, null)] }, dec);
    check("no decimals ⇒ DECIMALS_UNKNOWN, nothing written", o3.unsupported[0]?.reason === "DECIMALS_UNKNOWN" && dec.coverage.size === 0 && dec.rows.size === 0);
    // A token capture observed that no transfer records.
    const obs = newMem();
    obs.known.set(SPAM, { instrumentId: "inst:obs", decimals: 6, priced: false, firstObservedISO: "2026-01-02", held: true });
    const o4 = await step({ head: 2000, calls: [], txs: [] }, obs);
    check("observed without transfers ⇒ NO_TRANSFER_RECORDS", o4.unsupported[0]?.reason === "NO_TRANSFER_RECORDS" && obs.coverage.get("inst:obs")?.kind === "UNKNOWN");
  }

  // ── 7. Resumption across steps ───────────────────────────────────────────
  {
    const txs = [1, 2, 3, 4, 5].map((i) => tx(USDC, i * 100, OTHER, WALLET, 1_000_000 * i, 0)).concat([tx(USDC, 650, WALLET, OTHER, 2_000_000), tx(USDC, 660, WALLET, OTHER, 1_000_000)]);
    const one = newMem(); await step({ head: 3000, calls: [], txs }, one);
    const m = newMem();
    const chain: Chain = { head: 3000, calls: [], txs, pageSize: 1 };
    const outcomes: string[] = [];
    for (let i = 0; i < 10 && outcomes.at(-1) !== "DONE"; i++) outcomes.push((await step(chain, m, { cfg: { maxPagesPerStep: 2 } })).stoppedBecause);
    check("resume: several bounded steps, then done", outcomes.length > 2 && outcomes.slice(0, -1).every((x) => x === "BUDGET") && outcomes.at(-1) === "DONE", outcomes.join(","));
    check("resume: identical to a one-shot run (no double count)", JSON.stringify([...m.rows.get(`inst:${USDC}`)!]) === JSON.stringify([...one.rows.get(`inst:${USDC}`)!]));
    check("resume: head read once (segment pinned)", chain.calls.filter((c) => c === "eth_getBlockByNumber").length === 1);
  }

  // ── 8. Budget exhaustion ─────────────────────────────────────────────────
  {
    const chain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(DAI, 120, OTHER, WALLET, 1, 0, 18)] };
    const m = newMem();
    const o = await step(chain, m, { budget: 4 });
    check("budget: never exceeds the allowance", o.requests <= 4 && chain.calls.length <= 4, String(o.requests));
    check("budget: stops honestly, nothing verified yet", o.stoppedBecause === "BUDGET" && o.verified.length + o.unsupported.length <= 1);
    const o0 = await step({ ...chain, calls: [] }, newMem(), { budget: 0 });
    check("budget 0: no call at all", o0.requests === 0 && o0.stoppedBecause === "BUDGET");
    const o2 = await step(chain, m, { budget: 100 });
    check("budget: resumes and finishes", sectionOf(m).contracts[USDC].state === "VERIFIED" && sectionOf(m).contracts[DAI].state === "VERIFIED", JSON.stringify(o2));
  }

  // ── 9. Native independence ───────────────────────────────────────────────
  {
    const native = { ...queuedCheckpoint(ACC, "NO_STORED_ROWS", "2026-10-27T00:00:00.000Z"), anchorBlock: 123, anchorBalanceWei: "42", completedAtISO: "2026-10-27T01:00:00.000Z", licensedFromISO: "2020-01-01", licensedToISO: "2026-10-26" };
    const m = newMem(serializeCheckpoint(native));
    await step({ head: 2000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)] }, m);
    const after = JSON.parse(m.cursor!) as Record<string, unknown>;
    const { tokens, ...rest } = after;
    check("native host: token section embedded", readErc20Section(m.cursor, ACC).host === "NATIVE" && !!tokens);
    check("native host: every native field byte-identical", JSON.stringify(rest) === JSON.stringify(native));
    check("native host: still parses as the native checkpoint", parseCheckpoint(m.cursor, ACC)?.completedAtISO === native.completedAtISO);
    check("token writes never name the native instrument", [...m.coverage.keys()].every((k) => k.startsWith("inst:0x")));
    // A standalone doc is not a native checkpoint, and enqueue carries the section.
    const standalone = withErc20Section(null, ACC, emptySection())!;
    check("standalone: not a native checkpoint", parseCheckpoint(standalone, ACC) === null && readErc20Section(standalone, ACC).host === "STANDALONE");
    check("enqueue carries tokens (native or standalone)", !!carriedTokens(m.cursor, ACC).tokens && !!carriedTokens(standalone, ACC).tokens);
    check("foreign value never overwritten", withErc20Section(JSON.stringify({ kind: "btc-history" }), ACC, emptySection()) === null);
    const enqueueSrc = read("lib", "crypto", "eth-history-backfill.store.ts");
    check("enqueue: standalone token doc does not block the native queue", /tokenOnly/.test(enqueueSrc) && /carriedTokens\(raw, accountId\)/.test(enqueueSrc));
  }

  // ── 10. Wallet completeness requires tokens ──────────────────────────────
  {
    const native = { instrumentId: "n", assetKey: "k", label: "ETH", state: "RECONSTRUCTED" as const, licensedFromISO: "2020-01-01", licensedToISO: "2026-10-27" };
    check("ETH is a token-history chain now (beside SOL)", TOKEN_HISTORY_CHAINS.has("ETH") && TOKEN_HISTORY_CHAINS.has("SOL"));
    check("native complete + no token evidence ⇒ NOT complete", !walletHistoryComplete({ chain: "ETH", native, tokens: [] }));
    const s0 = emptySection();
    check("never scanned ⇒ token evidence incomplete", !erc20HistoryComplete(summarizeSection(s0)));
    const verified = { ...s0, scannedToBlock: 10, contracts: { [USDC]: { state: "VERIFIED" } as unknown as Erc20ContractHistory } };
    const withUnsupported = { ...verified, contracts: { ...verified.contracts, [STETH]: { state: "UNSUPPORTED" } as unknown as Erc20ContractHistory } };
    check("all verified ⇒ evidence complete", erc20HistoryComplete(summarizeSection(verified as Erc20HistorySection)));
    check("one unsupported ⇒ evidence incomplete", !erc20HistoryComplete(summarizeSection(withUnsupported as Erc20HistorySection)));
    check("overflow ⇒ evidence incomplete", !erc20HistoryComplete(summarizeSection({ ...verified, overflow: 1 } as Erc20HistorySection)));
    check("native + evidence complete ⇒ complete", walletHistoryComplete({ chain: "ETH", native, tokens: [], tokenInventoryComplete: true }));
    check("native NOT complete ⇒ never complete, whatever the tokens", !walletHistoryComplete({ chain: "ETH", native: { ...native, state: "NOT_RECONSTRUCTED" }, tokens: [], tokenInventoryComplete: true }));
    check("ETH inventory reader registered (the SPL shape, one rule)", /ETH: async \(\) => \(await import\("\.\/erc20-history-inventory"\)\)\.loadErc20InventoryComplete/.test(read("lib", "crypto", "wallet-instrument-history.ts")));
  }

  // ── 11. Priced first ─────────────────────────────────────────────────────
  {
    // SPAM's first transfer is EARLIER and its address sorts later; USDC is priced.
    const chain: Chain = { head: 3000, calls: [], txs: [tx(SPAM, 10, OTHER, WALLET, 1), tx(DAI, 20, OTHER, WALLET, 1, 0, 18), tx(USDC, 500, OTHER, WALLET, 1_000_000)] };
    const m = newMem();
    m.known.set(USDC, { instrumentId: "inst:usdc", decimals: 6, priced: true, firstObservedISO: "2026-03-01", held: true });
    m.known.set(DAI, { instrumentId: "inst:dai", decimals: 18, priced: false, firstObservedISO: "2026-03-01", held: true });
    const o1 = await step(chain, m, { cfg: { maxTokensPerStep: 1 } });
    check("priced token first", o1.verified.join() === USDC && o1.verifiedInstrumentIds.join() === "inst:usdc", JSON.stringify(o1));
    const o2 = await step(chain, m, { cfg: { maxTokensPerStep: 1 } });
    check("then observed unpriced", o2.verified.join() === DAI);
    const o3 = await step(chain, m, { cfg: { maxTokensPerStep: 1 } });
    check("transfer-only spam last", o3.verified.join() === SPAM && o3.pending === 0);
  }

  // ── 12. Daily extension, and a refuted extension ─────────────────────────
  {
    const chain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)] };
    const m = newMem();
    await step(chain, m);
    chain.txs.push(tx(USDC, 3005, OTHER, WALLET, 2_000_000)); // same day as the old head, after it
    chain.head = 3030; chain.calls = [];
    const o = await step(chain, m, { today: "2026-10-29" });
    const r = m.rows.get(`inst:${USDC}`)!;
    check("extension: verified again at the new head", o.verified.join() === USDC, JSON.stringify(o));
    check("extension: the old head day is rewritten to its end-of-day balance", r.get(dayOf(3000)) === 3 && r.get(dayOf(3030)) === 3);
    check("extension: earlier rows untouched", r.get(dayOf(100)) === 1);
    check("extension: coverage reaches the new head", (m.coverage.get(`inst:${USDC}`) as { toISO: string }).toISO === dayOf(3030));
    check("extension: no opening anchor re-spent", chain.calls.filter((c) => c === "eth_call").length <= 2);
    check("extension: regeneration from the rewritten day", o.impactedFromISO === dayOf(3000));
    chain.drift = { [USDC]: { fromBlock: 3040, delta: BigInt(1) } };
    chain.head = 3100; chain.calls = [];
    const bad = await step(chain, m, { today: "2026-10-30" });
    check("refuted extension ⇒ UNSUPPORTED, every row deleted", bad.unsupported[0]?.reason === "REBASING_OR_NONSTANDARD" && !m.rows.has(`inst:${USDC}`));
    check("refuted extension ⇒ regeneration from its first day", bad.impactedFromISO === dayOf(100));
  }

  // ── 13. The pass: regeneration flagged, run, cleared / kept ──────────────
  {
    const chain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)] };
    const m = newMem();
    const regen: string[] = [];
    let outcome: "DONE" | "DEFERRED" = "DONE";
    const deps: Erc20HistoryPassDeps = {
      wallets: async () => [{ accountId: ACC, connectionId: "c1", cursor: m.cursor }],
      step: ({ todayISO, deps: d }) => runErc20HistoryStep({ accountId: ACC, store: memStore(m), todayISO },
        { ...d, eth: { ...d.eth, transport: transport(chain), throttleRetries: 0 } }),
      setPending: async (_a, mutate) => { const s = readErc20Section(m.cursor, ACC).section!; m.cursor = withErc20Section(m.cursor, ACC, mutate(s)); return true; },
      acquirePrices: async () => ({ calls: 1, inserted: 3, tokensFetched: 1, earliestInsertedISO: "2025-12-01" }),
    };
    const cfg = { ...erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ERC20_HISTORY_ENABLED: "true" }) };
    const ctx = (ledgerUsed: number | null) => ({
      jobDeadline: Date.now() + 600_000, day: "2026-10-28", dailyRequestCap: 1_000, now: Date.now,
      claimLock: async () => true, releaseLock: async () => {},
      providerUsageToday: async () => (ledgerUsed === null ? null : { solana: ledgerUsed, other: 0 }),
      regenerateUnderLock: async (_w: unknown, fromISO: string, stamp: number) => { regen.push(fromISO); return { outcome, stamp }; },
    });
    outcome = "DEFERRED";
    const p1 = await planErc20History(deps, cfg, "2026-10-28");
    const s1 = await runErc20HistoryPass(p1, deps, cfg, ctx(0));
    check("pass: wallet stepped, token verified", s1.walletsRun === 1 && s1.tokensVerified === 1, JSON.stringify(s1));
    check("pass: regeneration from the earliest of rows and new prices", regen[0] === "2025-12-01");
    check("pass: deferred regeneration keeps the marker (earliest of rows and prices)", sectionOf(m).snapshotPendingFromISO === "2025-12-01" && s1.regenerationsDeferred === 1, String(sectionOf(m).snapshotPendingFromISO));
    outcome = "DONE";
    const p2 = await planErc20History(deps, cfg, "2026-10-28");
    check("pass: owed regeneration planned first", p2.work[0]?.kind === "PENDING");
    await runErc20HistoryPass(p2, deps, cfg, ctx(0));
    check("pass: done regeneration clears the marker", sectionOf(m).snapshotPendingFromISO === null && regen[1] === "2025-12-01", JSON.stringify(regen));
    const p3 = await planErc20History(deps, cfg, "2026-10-29");
    const s3 = await runErc20HistoryPass(p3, deps, cfg, ctx(1_000));
    check("pass: shared cap reached ⇒ nothing sent", s3.stoppedBecause === "DAILY_CAP" && s3.requests.total === 0);
    const s4 = await runErc20HistoryPass(await planErc20History(deps, cfg, "2026-10-29"), deps, cfg, ctx(null));
    check("pass: unreadable ledger ⇒ nothing sent", s4.stoppedBecause === "BUDGET_UNKNOWN" && s4.requests.total === 0);
    const off = await planErc20History(deps, erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true" }), "2026-10-29");
    check("gate: off unless the Ethereum worker is on", off.work.length === 0 && off.summary.stoppedBecause === "DISABLED");
    check("gate: ERC20_HISTORY_ENABLED=false is a kill switch", !erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ERC20_HISTORY_ENABLED: "false" }).enabled);
    // B2 — default OFF: the ETH worker being on is not an opt-in to token history.
    check("gate (B2): OFF by default even with the ETH worker on", !erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true" }).enabled);
    check("gate (B2): any value but \"true\" is OFF", ["1", "TRUE", "yes", "", " true"].every((v) => !erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ERC20_HISTORY_ENABLED: v }).enabled));
    check("gate (B2): explicit opt-in turns it on", erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ERC20_HISTORY_ENABLED: "true" }).enabled);
  }

  // ── 14. Pure pieces ──────────────────────────────────────────────────────
  {
    check("spread: first and last included", JSON.stringify(spreadIndices(10, 3)) === "[0,5,9]" && spreadIndices(2, 6).length === 2);
    const c: Erc20ContractHistory = { decimals: 6, firstBlock: 100, firstDayISO: dayOf(100), transfers: 2, baseRaw: "0",
      days: [{ d: "2026-01-05", delta: "5", lastBlock: 100 }, { d: "2026-02-07", delta: "-2", lastBlock: 905 }], state: "PENDING", reason: null,
      verifiedToBlock: null, persistedThroughISO: null, instrumentId: null };
    const plan = anchorPlan(c, 6000, 6);
    check("anchors: opening, one per active month, head", plan.map((a) => a.kind).join() === "OPENING,MONTH,MONTH,HEAD" && plan[0].block === 99 && plan[3].expected === BigInt(3));
    check("judge: exact match verifies", judgeAnchors(plan, plan.map((a) => ({ kind: "VALUE", raw: a.expected }))).verified);
    check("judge: opening may read no-code", judgeAnchors(plan, [{ kind: "NO_CODE" }, ...plan.slice(1).map((a) => ({ kind: "VALUE" as const, raw: a.expected }))]).verified);
    check("judge: off by one base unit refuses", !judgeAnchors(plan, plan.map((a) => ({ kind: "VALUE", raw: a.expected + BigInt(a.kind === "HEAD" ? 1 : 0) }))).verified);
    check("rows: no float value read (raw hex only)", (() => {
      const p = parseAssetTransfers({ transfers: [{ ...transferJson(tx(USDC, 1, OTHER, WALLET, 123)), value: 999999 }] });
      return p.transfers[0].raw === BigInt(123);
    })());
    // S1 — an unreadable transfer of a READABLE contract refuses that contract (never skipped silently)…
    const pr = parseAssetTransfers({ transfers: [
      { blockNum: "0x1", uniqueId: "x", from: OTHER, to: WALLET, rawContract: { address: USDC, value: null } },
      { blockNum: "0x2", uniqueId: "y:log:0", from: OTHER, to: WALLET, rawContract: { address: USDC, value: "0x01", decimal: "0x6" }, metadata: { blockTimestamp: "2026-01-01T00:00:00Z" } },
      { blockNum: "0x2", uniqueId: "z:log:1", from: OTHER, to: WALLET, rawContract: { address: DAI, value: "0x01", decimal: "0x12" }, metadata: { blockTimestamp: "2026-01-01T00:00:00Z" } },
    ] });
    check("an unreadable transfer refuses its contract, and none of its transfers are kept", pr.refused.join() === USDC && pr.transfers.every((t) => t.contract === DAI) && pr.transfers.length === 1);
    // …and one whose CONTRACT is unreadable still refuses the page (it can't be attributed).
    let threw = false;
    try { parseAssetTransfers({ transfers: [{ blockNum: "0x1", uniqueId: "x", from: OTHER, to: WALLET, rawContract: { address: "nope", value: "0x1" } }] }); } catch { threw = true; }
    check("an unattributable transfer refuses the page", threw);
    check("rows: zero runs collapse to one row", derivedRows({ ...c, days: [{ d: "2026-01-05", delta: "5", lastBlock: 1 }, { d: "2026-01-07", delta: "-5", lastBlock: 2 }] }, 0, "2026-01-05", "2026-01-12").length === 3);
    check("reason copy is plain", unsupportedReasonText("REBASING_OR_NONSTANDARD").includes("rebasing") && unsupportedCoverage("BALANCE_CALL_FAILED").kind === "UNKNOWN");
    // tokensValueOnDay grouping keeps the one rule's answer.
    const obs = [{ instrumentId: "a", dateISO: "2026-01-01", quantity: 2 }, { instrumentId: "b", dateISO: "2026-01-02", quantity: 3 }, { instrumentId: "a", dateISO: "2026-01-03", quantity: 4 }];
    const prices = [{ instrumentId: "a", dateISO: "2026-01-03", basis: "RAW_CLOSE" as const, priceUsd: 10 }, { instrumentId: "b", dateISO: "2026-01-03", basis: "RAW_CLOSE" as const, priceUsd: 1 }];
    const t = tokensValueOnDay(obs, prices, "2026-01-03");
    check("day rule: grouping is the same answer", t.totalUsd === 43 && t.tokens[0].valueUsd === tokenValueOnDay("a", obs, prices, "2026-01-03").valueUsd);
  }

  // ── 15. Customer copy (PCS-2: no quantities) ─────────────────────────────
  {
    const base = { label: "USDC", standard: "ERC20" as const, priceStatus: "MARKET_PRICE" as const, firstObservedISO: "2026-10-01", lastObservedISO: "2026-10-27" };
    const v = tokenHistoryText({ ...base, historyState: "RECONSTRUCTED", licensedFromISO: "2024-03-05", coverageKind: "COMPLETE" });
    const u = tokenHistoryText({ ...base, historyState: "UNLICENSED", historyReason: "FEE_ON_TRANSFER_OR_NONSTANDARD" });
    const n = tokenHistoryText({ ...base, historyState: "NOT_RECONSTRUCTED" });
    check("copy: verified since <date>", /^History verified since .*2024/.test(v), v);
    check("copy: couldn't be verified — reason; current balance only", /^Couldn’t be verified — .*fee-on-transfer.*; current balance only$/.test(u), u);
    check("copy: not reconstructed yet", n === "Not reconstructed yet");
    check("copy: no digits beyond the date", !/\d/.test(u) && !/\d/.test(n));
    const cov = deriveValuationCoverage([], new Map(), null, "2025-10-28");
    check("chart note: token valuation available from its first price", /Token valuation available from/.test(valuationCoverageNote(cov, "2024-01-01") ?? ""));
    check("chart note: silent when the chart starts after", valuationCoverageNote(cov, "2026-01-01") === null);
  }

  // ── 18. Review fixes: S1 backoff/recovery, S3 retry budget, S5 transient reverts, N1/N2/N4 ──
  {
    // S5 — a verified token, then a TRANSIENT node error at HEAD whose message says "out of gas".
    const chain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)] };
    const m = newMem();
    await step(chain, m);
    const before = JSON.stringify([...m.rows.get(`inst:${USDC}`)!]);
    chain.head = 3100; chain.calls = [];
    chain.callError = (_c, b) => (b === 3100 ? { code: -32000, message: "out of gas: gas required exceeds allowance" } : null);
    const t1 = await step(chain, m, { today: "2026-10-29" });
    check("S5: 'out of gas' from the node is a provider failure, never a verdict",
      t1.failure?.code === "PROVIDER_FAILED" && t1.unsupported.length === 0 && sectionOf(m).contracts[USDC].state === "VERIFIED", JSON.stringify(t1));
    check("S5: …and the verified rows and licence stay", JSON.stringify([...m.rows.get(`inst:${USDC}`)!]) === before && m.coverage.get(`inst:${USDC}`)?.kind === "COMPLETE");

    // S5 — a real execution revert at HEAD on a verified token: inconclusive, spaced, refused only at the limit.
    chain.callError = (_c, b) => (b === 3100 ? { code: 3, message: "execution reverted" } : null);
    const T = Date.parse("2026-10-29T12:00:00Z");
    const r1 = await step(chain, m, { today: "2026-10-29", now: T });
    check("S5: first revert of a VERIFIED token ⇒ inconclusive, rows kept", r1.inconclusive.includes(USDC) && r1.unsupported.length === 0 && m.rows.has(`inst:${USDC}`), JSON.stringify(r1));
    const early = await step(chain, m, { today: "2026-10-29", now: T + 60_000 });
    check("S5: not re-asked before the retry spacing", !early.inconclusive.includes(USDC) && early.requests === 0, JSON.stringify(early));
    const r2 = await step(chain, m, { today: "2026-10-29", now: T + ERC20_CALL_RETRY_MS + 1 });
    check("S5: second spaced revert still inconclusive", r2.inconclusive.includes(USDC) && m.rows.has(`inst:${USDC}`));
    const r3 = await step(chain, m, { today: "2026-10-29", now: T + 2 * ERC20_CALL_RETRY_MS + 2 });
    check(`S5: the ${ERC20_CALL_FAILURE_LIMIT}rd spaced revert refuses (BALANCE_CALL_FAILED), rows deleted`,
      r3.unsupported[0]?.reason === "BALANCE_CALL_FAILED" && !m.rows.has(`inst:${USDC}`), JSON.stringify(r3));
    // A recovered call clears the count.
    const m2 = newMem();
    const c2: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)], callError: (_c, b) => (b === 3000 ? { code: 3, message: "execution reverted" } : null) };
    await step(c2, m2, { now: T });
    c2.callError = undefined;
    const ok = await step(c2, m2, { now: T + ERC20_CALL_RETRY_MS + 1 });
    check("S5: a later clean read verifies and clears the count", ok.verified.includes(USDC) && (sectionOf(m2).contracts[USDC].callFailures ?? 0) === 0);
    check("S5: an exact mismatch still refutes on the FIRST read, even beside a revert",
      judgeAnchors([{ kind: "MONTH", block: 1, expected: BigInt(5) }, { kind: "HEAD", block: 2, expected: BigInt(5) }], [{ kind: "REVERTED" }, { kind: "VALUE", raw: BigInt(6) }]).verified === false
      && (judgeAnchors([{ kind: "MONTH", block: 1, expected: BigInt(5) }, { kind: "HEAD", block: 2, expected: BigInt(5) }], [{ kind: "REVERTED" }, { kind: "VALUE", raw: BigInt(6) }]) as { reason: string }).reason === "REBASING_OR_NONSTANDARD");
    check("S5: only an EVM execution failure is a revert", isExecutionRevert({ code: 3 }) && isExecutionRevert({ message: "execution reverted: nope" })
      && !isExecutionRevert({ code: -32000, message: "out of gas" }) && !isExecutionRevert({ code: -32000, message: "upstream said: request reverted to cache" }));
    check("S5: operator reset re-derives every token, keeps the owed regeneration",
      (() => { const r = resetErc20Section({ ...sectionOf(m), snapshotPendingFromISO: "2026-01-02" }); return Object.keys(r.contracts).length === 0 && r.scannedToBlock === null && r.snapshotPendingFromISO === "2026-01-02"; })());

    // S1 — a persistent failure backs off (once a day), and the counter is read.
    const fm = newMem();
    const dead: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)], callError: () => null };
    const deadTransport = async () => JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: "internal error" } });
    const stepDead = (now: number) => runErc20HistoryStep({ accountId: ACC, store: memStore(fm), todayISO: "2026-10-28" },
      { config: CFG, requestBudget: 50, now: () => now, eth: { transport: deadTransport, meter: {}, throttleRetries: 0, sleepImpl: async () => {} } });
    for (let i = 0; i < ERC20_BACKOFF_AFTER; i++) await stepDead(T + i);
    const fs = sectionOf(fm);
    check("S1: consecutive failures are counted", fs.failures === ERC20_BACKOFF_AFTER, String(fs.failures));
    check("S1: backed off — no work owed within the day", !erc20WorkOwed(fs, "2026-10-28", T + 3_600_000) && erc20BackedOff(fs, T + 3_600_000));
    check("S1: …owed again after the backoff", erc20WorkOwed(fs, "2026-10-28", T + ERC20_BACKOFF_MS + 10));
    void dead;
    // A throttle is not this wallet's failure.
    const th = newMem();
    await step({ head: 3000, calls: [], txs: [], throttle: true }, th);
    check("S1: a throttle never counts toward the backoff", (readErc20Section(th.cursor, ACC).section?.failures ?? 0) === 0);
    // A scan stuck on one page restarts its segment from fromBlock.
    const sm = newMem();
    const stuck: Chain = { head: 3000, calls: [], pageSize: 1, txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(USDC, 200, OTHER, WALLET, 1_000_000), tx(USDC, 300, OTHER, WALLET, 1_000_000)] };
    await step(stuck, sm, { cfg: { maxPagesPerStep: 1 } }); // page 1, pageKey "1" committed
    for (let i = 0; i < 4 && sectionOf(sm).segment?.pageKey !== "1"; i++) await step(stuck, sm, { cfg: { maxPagesPerStep: 1 } });
    stuck.failPageKey = "1";
    for (let i = 0; i < ERC20_SEGMENT_RESTART_AFTER; i++) await step(stuck, sm, { cfg: { maxPagesPerStep: 1 } });
    check("S1: repeated scan failures on one page are counted", sectionOf(sm).failures >= ERC20_SEGMENT_RESTART_AFTER && sectionOf(sm).segment?.pageKey === "1");
    const restarted = await step(stuck, sm, { cfg: { maxPagesPerStep: 1 } });
    check("S1: …then the segment restarts from fromBlock (buffer dropped with its pageKey)",
      // F3 — the re-read is not progress: the failure count is kept until the scan passes the old frontier.
      restarted.failure === null && sectionOf(sm).segment?.pageKey !== "1" && sectionOf(sm).failures >= ERC20_SEGMENT_RESTART_AFTER && sectionOf(sm).segmentRestarts === 1,
      JSON.stringify({ o: restarted, seg: sectionOf(sm).segment }));
    stuck.failPageKey = undefined;
    for (let i = 0; i < 10 && sectionOf(sm).segment; i++) await step(stuck, sm, { cfg: { maxPagesPerStep: 1 } });
    await step(stuck, sm);
    check("S1: the restarted scan finishes exactly (no double count)", m.rows !== sm.rows && sm.rows.get(`inst:${USDC}`)?.get(dayOf(300)) === 3, JSON.stringify([...(sm.rows.get(`inst:${USDC}`) ?? [])]));
    // An unreadable transfer refuses that ONE contract — a verified one included, rows deleted; the rest verifies.
    const um = newMem();
    const uc: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(DAI, 120, OTHER, WALLET, 1, 0, 18)] };
    await step(uc, um);
    check("S1 (setup): both verified", um.rows.has(`inst:${DAI}`) && um.rows.has(`inst:${USDC}`));
    uc.txs.push(tx(DAI, 3050, OTHER, WALLET, 1, 0, 18), tx(USDC, 3060, OTHER, WALLET, 1_000_000));
    uc.head = 3100; uc.calls = []; uc.unreadable = DAI;
    const uo = await step(uc, um, { today: "2026-10-29" });
    check("S1: unreadable transfer ⇒ that contract alone is refused (TRANSFER_UNREADABLE)",
      uo.verified.join() === USDC && uo.unsupported.find((u) => u.contract === DAI)?.reason === "TRANSFER_UNREADABLE", JSON.stringify(uo));
    check("S1: …and nothing of it is summed or kept", !um.rows.has(`inst:${DAI}`) && unsupportedReasonOf(um.coverage.get(`inst:${DAI}`)) === "TRANSFER_UNREADABLE");

    // S3 — throttle retries never push a step past its request budget.
    const meter: Record<string, number> = {};
    const tb = await step({ head: 3000, calls: [], txs: [], throttle: true }, newMem(), { budget: 3, retries: 6, meter });
    check("S3: retries are bounded by the step budget", tb.requests <= 3 && Object.values(meter).reduce((a, b) => a + b, 0) <= 3, String(tb.requests));
    const am: Record<string, number> = {};
    const ac: Chain = { head: 5000, calls: [], txs: [1, 2, 3].map((i) => tx(USDC, i * 800, OTHER, WALLET, 1_000_000)) };
    const pre = newMem(); await step({ ...ac, calls: [] }, pre, { budget: 3 }); // scan only (head + from + to)
    ac.throttle = true;
    const ab = await step(ac, pre, { budget: 6, retries: 6, meter: am });
    check("S3: anchor retries never exceed what is left", ab.requests <= 6, String(ab.requests));

    // N1 — sampled anchors are in the data.
    const nm = newMem();
    const months = Array.from({ length: 9 }, (_, i) => tx(USDC, 100 + i * 24 * 31, OTHER, WALLET, 1_000_000));
    await step({ head: 9000, calls: [], txs: months }, nm, { cfg: { maxMonthAnchors: 3 } });
    const nc = nm.coverage.get(`inst:${USDC}`)!;
    check("N1: a sampled licence carries TOKEN_ANCHORS_SAMPLED on COMPLETE coverage", nc.kind === "COMPLETE" && (nc.caveats ?? []).includes("TOKEN_ANCHORS_SAMPLED"), JSON.stringify(nc));
    check("N1: …and it still licenses (informational, never blocking)", licensedInterval(nc) !== null);
    const nm2 = newMem();
    await step({ head: 9000, calls: [], txs: months.slice(0, 2) }, nm2, { cfg: { maxMonthAnchors: 3 } });
    check("N1: every month anchored ⇒ no caveat", ((nm2.coverage.get(`inst:${USDC}`) as { caveats?: string[] }).caveats ?? []).length === 0);
    const row = coverageFromRow({ kind: "COMPLETE", coveredFromDate: new Date("2026-01-01T00:00:00Z"), coveredToDate: new Date("2026-02-01T00:00:00Z"), caveats: ["TOKEN_ANCHORS_SAMPLED"], source: ERC20_HISTORY_SOURCE });
    check("N1: the caveat survives the database round trip", row.kind === "COMPLETE" && (row.caveats ?? []).includes("TOKEN_ANCHORS_SAMPLED"));

    // N2 — with contracts left untracked, an observed token without transfers is not called NO_TRANSFER_RECORDS.
    const om = newMem();
    om.known.set(SPAM, { instrumentId: "inst:obs", decimals: 6, priced: false, firstObservedISO: "2026-01-02", held: true });
    const oo = await step({ head: 2000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1), tx(DAI, 101, OTHER, WALLET, 1, 0, 18)] }, om, { cfg: { maxContracts: 1 } });
    check("N2: overflow ⇒ no NO_TRANSFER_RECORDS verdict for an observed token", !oo.unsupported.some((u) => u.reason === "NO_TRANSFER_RECORDS") && !om.coverage.has("inst:obs"), JSON.stringify(oo.unsupported));

    // N4 — the same untracked contract seen again does not inflate the counter.
    let ns = { ...emptySection(), contracts: { [USDC]: { state: "VERIFIED", days: [], transfers: 1 } as unknown as Erc20ContractHistory } } as Erc20HistorySection;
    for (let i = 0; i < 3; i++) {
      ns = closeSegment({ ...ns, segment: { fromBlock: i, toBlock: i, toISO: "2026-01-01", direction: "to", pageKey: null, pages: 1,
        buffer: { [SPAM]: { decimals: 6, firstBlock: i, firstDayISO: "2026-01-01", transfers: 1, days: [] } } } }, 1);
    }
    check("N4: overflow is not inflated by re-seeing the same contract", ns.overflow === 1, String(ns.overflow));
  }

  // ── 19. Pass review fixes: S2 durable marker before regeneration, S3 incremental flush ──
  {
    const cfg = { ...erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ERC20_HISTORY_ENABLED: "true" }) };
    const baseCtx = {
      jobDeadline: Date.now() + 600_000, day: "2026-10-28", dailyRequestCap: 10_000, now: Date.now,
      claimLock: async () => true, releaseLock: async () => {}, providerUsageToday: async () => ({ solana: 0, other: 0 }),
    };
    // S2 — the worker is killed between the price insert and the regeneration.
    const chain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)] };
    const m = newMem();
    const deps: Erc20HistoryPassDeps = {
      wallets: async () => [{ accountId: ACC, connectionId: "c1", cursor: m.cursor }],
      step: ({ todayISO, deps: d }) => runErc20HistoryStep({ accountId: ACC, store: memStore(m), todayISO }, { ...d, eth: { ...d.eth, transport: transport(chain), throttleRetries: 0 } }),
      setPending: async (_a, mutate) => { const s0 = readErc20Section(m.cursor, ACC).section!; m.cursor = withErc20Section(m.cursor, ACC, mutate(s0)); return true; },
      acquirePrices: async () => ({ calls: 1, inserted: 3, tokensFetched: 1, earliestInsertedISO: "2025-12-01" }),
    };
    let killed = false;
    try {
      await runErc20HistoryPass(await planErc20History(deps, cfg, "2026-10-28"), deps, cfg,
        { ...baseCtx, regenerateUnderLock: async () => { throw new Error("killed (maxDuration)"); } });
    } catch { killed = true; }
    check("S2: a kill between price insert and regeneration keeps the price days owed (durable first)",
      killed && sectionOf(m).snapshotPendingFromISO === "2025-12-01", String(sectionOf(m).snapshotPendingFromISO));
    const p2 = await planErc20History(deps, cfg, "2026-10-28");
    check("S2: …so the next run plans that regeneration first", p2.work[0]?.kind === "PENDING");

    // Delta F4 — the pass/job surfaces a stopped price run as a NON-SUCCESS outcome, never "done".
    for (const [status, ok] of [["BUDGET_STOPPED", false], ["COMPLETE", true]] as const) {
      const pm4 = newMem();
      const pchain: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000)] };
      const d4: Erc20HistoryPassDeps = {
        wallets: async () => [{ accountId: ACC, connectionId: "c1", cursor: pm4.cursor }],
        step: ({ todayISO, deps: d }) => runErc20HistoryStep({ accountId: ACC, store: memStore(pm4), todayISO }, { ...d, eth: { ...d.eth, transport: transport(pchain), throttleRetries: 0 } }),
        setPending: async (_a, mutate) => { const s0 = readErc20Section(pm4.cursor, ACC).section!; pm4.cursor = withErc20Section(pm4.cursor, ACC, mutate(s0)); return true; },
        acquirePrices: async () => ({ calls: 0, inserted: 0, tokensFetched: 0, earliestInsertedISO: null, status, reason: ok ? null : "CoinGecko token budget reached; 1 token(s) not priced this run", tokensSkipped: ok ? 0 : 1 }),
      };
      const s4 = await runErc20HistoryPass(await planErc20History(d4, cfg, "2026-10-28"), d4, cfg,
        { ...baseCtx, regenerateUnderLock: async (_w: unknown, _f: string, stamp: number) => ({ outcome: "DONE" as const, stamp }) });
      check(ok ? "F4: a COMPLETE price run leaves the pass ALL_RUN" : "F4: a budget-stopped price run makes the pass PRICES_INCOMPLETE with status + reason (not done)",
        ok ? s4.prices.status === "COMPLETE" && s4.stoppedBecause === "ALL_RUN"
          : s4.prices.status === "BUDGET_STOPPED" && s4.stoppedBecause === "PRICES_INCOMPLETE" && /budget/.test(s4.prices.reason ?? "") && s4.prices.tokensSkipped === 1,
        JSON.stringify({ p: s4.prices, b: s4.stoppedBecause }));
    }

    // S3 — the pass meter reaches the ledger WHILE a step sends (every 100 calls), not only after it.
    const ledger: Record<string, number> = {};
    let recordedWhileSending = 0;
    const flushDeps: Erc20HistoryPassDeps = {
      wallets: async () => [{ accountId: ACC, connectionId: "c1", cursor: null }],
      step: async ({ deps: d }) => {
        for (let i = 0; i < 250; i++) { d.eth!.meter!.eth_call = (d.eth!.meter!.eth_call ?? 0) + 1; await new Promise((r) => setImmediate(r)); }
        recordedWhileSending = Object.values(ledger).reduce((x, y) => x + y, 0);
        return { stoppedBecause: "BUDGET", requests: 250, pagesRead: 0, verified: [], unsupported: [], inconclusive: [], pending: 1, impactedFromISO: null, verifiedInstrumentIds: [], pricingCandidates: [], failure: null };
      },
      setPending: async () => true,
      recordUsage: async (meter, flushed) => { for (const [k, v] of Object.entries(meter)) { const dd = v - (flushed[k] ?? 0); if (dd > 0) { ledger[k] = (ledger[k] ?? 0) + dd; flushed[k] = v; } } },
    };
    const fs = await runErc20HistoryPass(await planErc20History(flushDeps, cfg, "2026-10-28"), flushDeps, { ...cfg, stepRequestBudget: 2_000 },
      { ...baseCtx, regenerateUnderLock: async (_w: unknown, _f: string, stamp: number) => ({ outcome: "DONE" as const, stamp }) });
    check("S3: ≥ 200 of 250 calls were on the ledger before the step returned (flushed every 100)", recordedWhileSending >= 200, String(recordedWhileSending));
    check("S3: and every call is recorded exactly once by the end", (ledger.eth_call ?? 0) === 250 && fs.requests.total === 250, JSON.stringify(ledger));
  }

  // ── 20. B1 + re-review F1–F6: exited tokens priced or honestly disclosed; never-held ignored; coverage-aware ──
  {
    const EXITED_KEY = `eip155:1/erc20:${USDC}`;
    const LIC = { fromISO: "2025-01-10", toISO: "2026-10-27" };
    const HELD = { fromISO: "2025-01-10", toISO: "2025-06-30" }; // sold mid-2025
    // (a) The pure rule.
    const V = (held: { fromISO: string; toISO: string | null } | null, closesFromISO: string | null, m: unknown = {}) => reconstructedTokenValuation({ licence: LIC, held, closesFromISO }, m);
    check("B1 rule: closes covering its held period ⇒ VALUED", V(HELD, "2025-01-01") === "VALUED");
    check("B1 rule: never quoted (sold before capture) ⇒ NOT_VALUED_YET", V(HELD, null, null) === "NOT_VALUED_YET");
    check("B1 rule: quoted PRICED but no closes yet ⇒ NOT_VALUED_YET", V(HELD, null, { quote: { outcome: "PRICED", pricedAt: "x" } }) === "NOT_VALUED_YET");
    check("B1 rule: thin / unlisted ⇒ NO_MARKET (the held-token rule)", V(HELD, null, { quote: { outcome: "THIN" } }) === "NO_MARKET"
      && V(HELD, null, { quote: { outcome: "UNLISTED" } }) === "NO_MARKET" && V(HELD, null, { priceHistory: { outcome: "UNLISTED" } }) === "NO_MARKET");
    check("B1 rule: an EMPTY history answer is not 'no market' ⇒ NOT_VALUED_YET", V(HELD, null, { quote: { outcome: "PRICED", pricedAt: "x" }, priceHistory: { outcome: "EMPTY" } }) === "NOT_VALUED_YET");
    check("F2 rule: never held (no positive balance) ⇒ NEVER_HELD, whatever its prices", V(null, null) === "NEVER_HELD" && V(null, "2025-01-01") === "NEVER_HELD");
    check("F4 rule: held ONLY before the price window ⇒ NOT_VALUED_YET (any close is not enough)", V(HELD, "2025-10-28") === "NOT_VALUED_YET");
    check("F4 rule: closes begin inside its held period ⇒ VALUED_FROM_LATER (limiting, as native)", V({ fromISO: "2025-01-10", toISO: null }, "2025-10-28") === "VALUED_FROM_LATER"
      && tokenValuationLimits("VALUED_FROM_LATER") && tokenValuationLimits("NOT_VALUED_YET") && !tokenValuationLimits("VALUED") && tokenValuationLimits("NO_MARKET") && !tokenValuationLimits("EXCLUDED"));
    check("F2/F4 held span: exit = the day before the first zero after the last positive row; still held ⇒ open",
      JSON.stringify(heldSpanFrom("2025-01-10", "2025-03-01", "2025-07-01")) === JSON.stringify({ fromISO: "2025-01-10", toISO: "2025-06-30" })
      && heldSpanFrom("2025-01-10", "2025-03-01", "2025-02-01")?.toISO === null && heldSpanFrom(null, null, "2025-01-01") === null);

    // (b) Price acquisition: an exited token (no quote marker) is probed through the current-quote path, then priced.
    const meta: Record<string, unknown> = {};
    const inserted: Array<{ instrumentId: string; date: Date }> = [];
    const probes: string[] = [];
    let heldRows = true;
    const client = {
      instrumentAlias: {
        findMany: async () => [{ instrumentId: "usdc", externalId: EXITED_KEY, metadata: { ...meta } }],
        findUnique: async () => ({ metadata: { ...meta } }),
        update: async ({ data }: { data: { metadata: Record<string, unknown> } }) => { Object.assign(meta, data.metadata); return {}; },
      },
      positionCoverage: { findMany: async () => [{ instrumentId: "usdc", coveredFromDate: new Date("2025-01-10T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z") }] },
      positionObservation: { groupBy: async ({ where }: { where: { quantity?: unknown } }) =>
        !heldRows ? [] : JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 })
          ? [{ financialAccountId: "acc", instrumentId: "usdc", _min: { date: new Date("2025-01-10T00:00:00Z") }, _max: { date: new Date("2025-06-30T00:00:00Z") } }]
          : [{ financialAccountId: "acc", instrumentId: "usdc", _max: { date: new Date("2025-07-01T00:00:00Z") } }] },
      priceObservation: { createMany: async ({ data }: { data: Array<{ instrumentId: string; date: Date }> }) => { inserted.push(...data); return { count: data.length }; } },
    };
    const NOW = Date.parse("2026-10-28T12:00:00Z");
    const acquire: typeof acquireTokenHistoricalCloses = (a) => acquireTokenHistoricalCloses({ ...a, now: new Date(NOW), historyDays: 365,
      budget: { remaining: async () => 50, record: async () => {}, pace: async () => {} },
      fetchCloses: async () => ({ configured: true, unlisted: false, closes: [{ dateISO: "2025-11-01", price: 1 }, { dateISO: "2025-11-02", price: 1 }] }) });
    const listed = (outcome: "PRICED" | "THIN") => async (t: { assetKey: string }) => {
      probes.push(t.assetKey);
      meta.quote = { attemptedAt: new Date(NOW).toISOString(), outcome, ...(outcome === "PRICED" ? { pricedAt: new Date(NOW).toISOString() } : {}) };
      return 1;
    };
    // A durable ledger shared by every "run" (F1).
    let ledgerProbes = 0;
    const gate = (o: { cap?: number; tokenRemaining?: number | null; shareCap?: number } = {}) => ({
      allowance: async () => probeAllowance({ probesToday: ledgerProbes, tokenRemaining: o.tokenRemaining === undefined ? 100 : o.tokenRemaining, tokenShareCap: o.shareCap ?? 150, dailyCap: o.cap ?? 20, heldReserve: 0.5 }),
      record: async (n: number) => { ledgerProbes += n; },
    });
    const run = (o: Parameters<typeof acquireErc20HistoricalPrices>[0] extends infer A ? Partial<A> : never = {}) =>
      acquireErc20HistoricalPrices({ client: client as never, accountId: "acc", instrumentIds: ["usdc"], maxTokens: 5, acquire, probe: listed("PRICED"), probeGate: gate(), now: () => NOW, ...o });
    const r1 = await run();
    check("B1: an exited, never-quoted token is quote-probed (the current-quote path)", probes.join() === EXITED_KEY && r1.probed === 1);
    check("B1: …and then its historical closes are acquired (it no longer vanishes)", inserted.length === 2 && r1.inserted === 2 && r1.earliestInsertedISO === "2025-11-01", JSON.stringify(r1));
    const r2 = await run({ now: () => NOW + 1 });
    check("B1: a priced token is never re-probed", probes.length === 1 && r2.probed === 0);
    for (const k of Object.keys(meta)) delete meta[k];
    inserted.length = 0; probes.length = 0;
    const r3 = await run({ probe: listed("THIN") });
    check("B1: a probed THIN token is never priced historically (thin-market rule respected)", r3.probed === 1 && inserted.length === 0);
    const r4 = await run({ probe: listed("THIN"), now: () => NOW + 3_600_000 });
    check("B1: …and not re-probed within the probe window", r4.probed === 0 && probes.length === 1 && needsQuoteProbe(meta, NOW + ERC20_PROBE_RETRY_MS + 1));

    // F1 — the probe cap is DURABLE across runs (the job self-continues every 15 min), and held quotes keep a reserve.
    for (const k of Object.keys(meta)) delete meta[k];
    probes.length = 0; ledgerProbes = 0;
    const noop = async () => 0;
    let sent = 0;
    for (let runNo = 0; runNo < 96; runNo++) { // a day of 15-minute wakes, a fresh pass each time
      for (const k of Object.keys(meta)) delete meta[k]; // still never priced
      const r = await run({ probe: async () => { sent++; return 1; }, probeGate: gate({ cap: 20 }), now: () => NOW + runNo * 900_000 });
      void r; void noop;
    }
    check("F1: probes per day never exceed the durable cap, however many runs", sent === 20 && ledgerProbes === 20, `${sent} / ${ledgerProbes}`);
    sent = 0; ledgerProbes = 0;
    await run({ probe: async () => { sent++; return 1; }, probeGate: gate({ tokenRemaining: 75, shareCap: 150 }) });
    const rAllow = await run({ probe: async () => { sent++; return 1; }, probeGate: gate({ tokenRemaining: 75, shareCap: 150 }) });
    check("F1: no probe once the TOKEN share is down to the held-quote reserve", sent === 0);
    // Delta F4 — a refused probe is REPORTED, never a silent "done".
    check("F4: probe allowance 0 ⇒ status ALLOWANCE_EXHAUSTED with a reason and the skipped token counted",
      rAllow.status === "ALLOWANCE_EXHAUSTED" && /allowance/.test(rAllow.reason ?? "") && rAllow.tokensSkipped === 1 && rAllow.probed === 0, JSON.stringify(rAllow));
    for (const k of Object.keys(meta)) delete meta[k];
    ledgerProbes = 0;
    const rOk = await run();
    check("F4: a run that asked every token reports COMPLETE (reason null, nothing skipped)", rOk.status === "COMPLETE" && rOk.reason === null && rOk.tokensSkipped === 0, JSON.stringify(rOk));
    const budgetAcquire: typeof acquireTokenHistoricalCloses = async () => ({ status: "BUDGET", inserted: 0, earliestISO: null, calls: 0 });
    const rBudget = await run({ acquire: budgetAcquire, probeGate: gate({ cap: 0 }) });
    check("F4: the token budget stopping the run ⇒ BUDGET_STOPPED (worst wins over ALLOWANCE_EXHAUSTED), reason given",
      rBudget.status === "BUDGET_STOPPED" && /budget/.test(rBudget.reason ?? "") && rBudget.tokensSkipped >= 1, JSON.stringify(rBudget));
    const rLimit = await run({ maxTokens: 0 });
    check("F4: no price-token allowance ⇒ TOKEN_LIMIT, never silently empty", rLimit.status === "TOKEN_LIMIT" && rLimit.tokensSkipped === 1);
    check("F1: allowance is the tighter of the cap and the reserve; unknown ⇒ 0",
      probeAllowance({ probesToday: 0, tokenRemaining: 80, tokenShareCap: 150, dailyCap: 20, heldReserve: 0.5 }) === 5
      && probeAllowance({ probesToday: null, tokenRemaining: 80, tokenShareCap: 150, dailyCap: 20, heldReserve: 0.5 }) === 0
      && probeAllowance({ probesToday: 0, tokenRemaining: null, tokenShareCap: 150, dailyCap: 20, heldReserve: 0.5 }) === 0);
    check("F1: the probe count lives on the durable ledger, apart from COINGECKO's own rows", (ERC20_PROBE_USAGE_PROVIDER as string) !== COINGECKO_USAGE_PROVIDER
      && /apiUsageCounter\.findMany/.test(read("lib", "crypto", "erc20-history-prices.ts")));

    // F2 — a never-held token (zero-value transfers only) is neither probed nor priced.
    for (const k of Object.keys(meta)) delete meta[k];
    probes.length = 0; inserted.length = 0; heldRows = false;
    const nh = await run();
    check("F2: a never-held token is never probed or priced", nh.probed === 0 && probes.length === 0 && inserted.length === 0 && nh.calls === 0);
    heldRows = true;

    // The pass hands EVERY verified token to the price path, not only this step's.
    const pm = newMem();
    const pc: Chain = { head: 3000, calls: [], txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(USDC, 200, WALLET, OTHER, 1_000_000)] };
    await step(pc, pm);
    const quiet = await step(pc, pm); // same day: nothing owed, nothing re-verified
    check("B1: price candidates include tokens verified on earlier steps (held or exited)",
      quiet.verifiedInstrumentIds.length === 0 && quiet.pricingCandidates.join() === `inst:${USDC}`, JSON.stringify(quiet));

    // (c) Disclosure: the Net Worth chart note reads LICENSED tokens, not only observed ones.
    const spanRows = (held: Record<string, [string, string, string | null]>) => async ({ where }: { where: { quantity?: unknown; source?: unknown } }) => {
      if (where.source) return [{ instrumentId: "dai", _min: { date: new Date("2026-10-01T00:00:00Z") } }]; // capture's firsts: DAI only
      const pos = JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 });
      return Object.entries(held).flatMap(([id, [f, t, z]]) => pos
        ? [{ financialAccountId: "acc", instrumentId: id, _min: { date: new Date(`${f}T00:00:00Z`) }, _max: { date: new Date(`${t}T00:00:00Z`) } }]
        : z ? [{ financialAccountId: "acc", instrumentId: id, _max: { date: new Date(`${z}T00:00:00Z`) } }] : []);
    };
    // Delta F3 — closes are read as RAW_CLOSE rows (first, last and every date); `drop` punches interior gaps.
    const denseCloses = (id: string, from: string, to: string, drop: readonly string[] = []) => {
      const out: { instrumentId: string; date: Date }[] = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
        const iso = new Date(t).toISOString().slice(0, 10);
        if (!drop.includes(iso)) out.push({ instrumentId: id, date: new Date(t) });
      }
      return out;
    };
    const gapDrop = Array.from({ length: 10 }, (_, k) => `2025-04-${String(k + 1).padStart(2, "0")}`);
    const covClient = (o: { closes?: string | null; closesTo?: string; intradayTo?: string; drop?: string[]; usdcMeta?: unknown; usdcHeld?: [string, string, string | null] | null; extra?: Record<string, [string, string, string | null]> }) => ({
      spaceAccountLink: { findMany: async () => [{ visibilityLevel: "FULL", financialAccountId: "acc" }] },
      positionCoverage: { findMany: async ({ where }: { where: { instrument?: unknown } }) =>
        JSON.stringify(where.instrument) === JSON.stringify(IS_TOKEN_INSTRUMENT)
          ? ["usdc", "dai", "spam"].map((id) => ({ instrumentId: id, financialAccountId: "acc", kind: "COMPLETE", coveredFromDate: new Date(id === "dai" ? "2026-09-01T00:00:00Z" : "2025-01-10T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z"), caveats: [], source: ERC20_HISTORY_SOURCE }))
          : [] },
      // Capture only ever saw DAI (held now, priced); USDC was sold before capture began; SPAM was never held (zero-value transfers).
      positionObservation: { groupBy: spanRows({ ...(o.usdcHeld === null ? {} : { usdc: o.usdcHeld ?? ["2025-01-10", "2025-06-30", "2025-07-01"] }), dai: ["2026-09-01", "2026-10-27", null], ...(o.extra ?? {}) }) },
      priceObservation: { groupBy: async ({ where }: { where: { instrumentId: { in: string[] }; basis?: unknown } }) => {
        const max = typeof where.basis === "object"; // the S1 "where do closes END" read
        const d = (iso: string) => (max ? { _max: { date: new Date(`${iso}T00:00:00Z`) } } : { _min: { date: new Date(`${iso}T00:00:00Z`) } });
        return where.instrumentId.in.flatMap((id) => id === "dai" ? [{ instrumentId: "dai", ...d(max ? "2026-10-27" : "2025-10-28") }]
          : id === "usdc" && o.closes ? [{ instrumentId: "usdc", ...d(max ? (o.intradayTo ?? o.closesTo ?? "2026-10-27") : o.closes) }] : []);
      }, findMany: async ({ where }: { where: { instrumentId: { in: string[] }; basis?: unknown } }) => where.basis !== "RAW_CLOSE" ? []
        : where.instrumentId.in.flatMap((id) => id === "dai" ? denseCloses("dai", "2025-10-28", "2026-10-27")
          : id === "usdc" && o.closes ? denseCloses("usdc", o.closes, o.closesTo ?? "2026-10-27", o.drop) : []) },
      instrumentAlias: { findMany: async () => [{ instrumentId: "usdc", metadata: o.usdcMeta ?? {} }, { instrumentId: "spam", metadata: {} }, { instrumentId: "dai", metadata: { quote: { outcome: "PRICED", pricedAt: "x" } } }] },
    });
    const c1 = await loadValuationCoverage(covClient({}) as never, "space");
    const n1 = valuationCoverageNote(c1, "2025-06-01") ?? "";
    check("B1: an exited, unpriced verified token is DISCLOSED on the chart (it was silently dropped before)",
      c1?.tokensNotValuedYet === 1 && /Older token holdings exist but lack historical prices \(1 token\)/.test(n1) && /never counted as zero/.test(n1), n1);
    check("F2: a never-held token (zero-value transfers) is counted NOWHERE", c1?.tokensNotValuedYet === 1 && !c1?.tokensWithoutMarket);
    const n1late = valuationCoverageNote(c1, "2026-10-01") ?? "";
    check("B1: …whatever window the chart shows", /lack historical prices/.test(n1late), n1late);
    const c2 = await loadValuationCoverage(covClient({ usdcMeta: { quote: { outcome: "THIN", attemptedAt: "x" } } }) as never, "space");
    const n2 = valuationCoverageNote(c2, "2025-06-01") ?? "";
    check("B1/F6: a thin/unlisted exited token is disclosed — as of when it was last checked", c2?.tokensWithoutMarket === 1 && !c2.tokensNotValuedYet
      && /without a reliable market price when last checked/.test(n2), n2);
    const c3 = await loadValuationCoverage(covClient({ closes: "2025-10-28" }) as never, "space");
    check("F4: closes only AFTER it was sold ⇒ still NOT valued (any close is not enough)", c3?.tokensNotValuedYet === 1, JSON.stringify(c3));
    const c4 = await loadValuationCoverage(covClient({ closes: "2025-03-01" }) as never, "space");
    check("F4: closes from inside its held period ⇒ valued from there, said on the chart", !c4?.tokensNotValuedYet && c4?.tokenPricesFromISO === "2025-03-01"
      && /Token valuation available from/.test(valuationCoverageNote(c4, "2025-01-01") ?? ""));
    const c5 = await loadValuationCoverage(covClient({ closes: "2025-01-01" }) as never, "space");
    check("F4: closes covering its whole held period ⇒ VALUED, nothing to disclose for it", !c5?.tokensNotValuedYet && c5?.tokenPricesFromISO !== "2025-01-01");

    // (d) The wallet never reads complete while one exists — loader, health headline and History copy.
    const nativeCov = { instrumentId: "eth", financialAccountId: "acc", kind: "COMPLETE", coveredFromDate: new Date("2020-01-01T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z"), caveats: [], source: "eth" };
    const tokenCov = (id: string) => ({ instrumentId: id, financialAccountId: "acc", kind: "COMPLETE", coveredFromDate: new Date("2025-01-10T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z"), caveats: [], source: ERC20_HISTORY_SOURCE });
    const doneSection = { ...emptySection(), scannedToBlock: 10, scannedToISO: "2026-10-27", contracts: { [USDC]: {
      decimals: 6, firstBlock: 5, firstDayISO: "2025-01-10", transfers: 2, baseRaw: "0", days: [], state: "VERIFIED", reason: null,
      verifiedToBlock: 10, persistedThroughISO: "2026-10-27", instrumentId: "usdc" } } } as Erc20HistorySection;
    const whClient = (closesFrom: string | null, o: { spam?: boolean; closesTo?: string; drop?: string[] } = {}) => ({
      positionCoverage: { findMany: async () => [nativeCov, tokenCov("usdc"), ...(o.spam ? [tokenCov("spam")] : [])] },
      positionObservation: { groupBy: async ({ where }: { where: { quantity?: unknown; source?: unknown } }) => (where.source ? []
        : JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 })
          ? [{ financialAccountId: "acc", instrumentId: "usdc", _min: { date: new Date("2025-01-10T00:00:00Z") }, _max: { date: new Date("2025-06-30T00:00:00Z") } }]
          : [{ financialAccountId: "acc", instrumentId: "usdc", _max: { date: new Date("2025-07-01T00:00:00Z") } }]), findMany: async () => [] },
      instrumentAlias: { findMany: async () => [{ instrumentId: "usdc", externalId: EXITED_KEY, metadata: {} }, { instrumentId: "spam", externalId: `eip155:1/erc20:${SPAM}`, metadata: {} }] },
      priceObservation: { groupBy: async ({ where }: { where: { basis?: unknown } }) => (!closesFrom ? []
        : where.basis === "RAW_CLOSE" ? [{ instrumentId: "usdc", _min: { date: new Date(`${closesFrom}T00:00:00Z`) } }]
        : typeof where.basis === "object" ? [{ instrumentId: "usdc", _max: { date: new Date(`${o.closesTo ?? "2026-10-27"}T00:00:00Z`) } }] : []),
        findMany: async ({ where }: { where: { basis?: unknown } }) => (!closesFrom || where.basis !== "RAW_CLOSE" ? [] : denseCloses("usdc", closesFrom, o.closesTo ?? "2026-10-27", o.drop)) },
      accountConnection: { findFirst: async () => ({ connectionId: "c1", connection: { credential: null, cursor: null } }) },
      $queryRaw: async () => [{ historyCheckpoint: withErc20Section(null, "acc", doneSection) }],
    });
    const wh = async (closesFrom: string | null, o: { spam?: boolean; closesTo?: string; drop?: string[] } = {}) => (await loadWalletInstrumentHistory(whClient(closesFrom, o) as never, [{ id: "acc", walletChain: "ETH" }])).get("acc")!;
    const h0 = await wh(null);
    // Owner ruling 2026-10-30 — balance completeness is independent of prices; the valuation gap is a separate, disclosed fact.
    check("RULING: every balance verified, an exited token unvalued ⇒ BALANCE complete, valuation gap counted separately",
      h0.native.state === "RECONSTRUCTED" && h0.tokenInventoryComplete && h0.tokensNotValuedYet === 1 && h0.complete === true, JSON.stringify({ c: h0.complete, n: h0.tokensNotValuedYet, inv: h0.tokenInventoryComplete }));
    const h1 = await wh("2025-01-01");
    check("B1: …and complete once its held period is priced", h1.tokensNotValuedYet === 0 && h1.tokensValuedFromLater === 0 && h1.complete === true);
    const h2 = await wh("2025-10-28");
    check("F4: held only before the 365-day price window ⇒ counted NOT valued (a close elsewhere is not coverage); balance still complete", h2.tokensNotValuedYet === 1 && h2.complete === true);
    const h3 = await wh("2025-03-01");
    check("F4: priced only from inside its held period ⇒ counted partly valued; balance still complete", h3.tokensValuedFromLater === 1 && h3.complete === true);
    const h3g = await wh("2025-01-01", { drop: gapDrop });
    check("F3: interior price gaps over held days ⇒ counted as GAPS on the wallet (History copy); balance still complete",
      h3g.tokensValuedWithGaps === 1 && h3g.tokensValuedFromLater === 0 && h3g.tokensNotValuedYet === 0 && h3g.complete === true, JSON.stringify({ g: h3g.tokensValuedWithGaps, l: h3g.tokensValuedFromLater }));
    const h4 = await wh("2025-01-01", { spam: true });
    check("F2: a never-held spam token beside it never makes the wallet limited", h4.tokensNotValuedYet === 0 && h4.tokensWithoutMarket === 0 && h4.complete === true, JSON.stringify(h4));
    const conn = { id: "c", provider: "WALLET", state: "active" } as never;
    const intel = (n: number, later = 0) => ({ positionObservedAt: "2026-10-28T10:00:00Z", valuationIsReadTime: true,
      walletHistory: { supported: true, licensed: true, licensedFromISO: "2020-01-01", licensedToISO: "2026-10-27", activityFromISO: "2020-01-01",
        priceFromISO: "2020-01-01", chart: { fromISO: "2020-01-01", toISO: "2026-10-27", days: 2492, continuous: true }, chain: "ETH", tokens: [], walletComplete: n === 0 && later === 0, tokensNotValuedYet: n, tokensValuedFromLater: later } }) as never;
    check("RULING: missing token prices never make the balance import 'limited' (ERC-20)", connectionHealth(conn, intel(1), new Date("2026-10-28T12:00:00Z")).headline === "Current holdings ready"
      && connectionHealth(conn, intel(0, 1), new Date("2026-10-28T12:00:00Z")).headline === "Current holdings ready");
    check("B1: …and ready once it is", connectionHealth(conn, intel(0), new Date("2026-10-28T12:00:00Z")).headline === "Current holdings ready");
    const lim = connectionHistory(conn, intel(2, 1), [{ id: "a", name: "w", type: "crypto", chain: "ETH" } as never]).limitations.join(" ");
    check("RULING: History tab says it concisely — balance verified through, older holdings lack prices — never a value",
      /Balance history verified through Oct 27, 2026\. Older holdings exist but lack historical prices \(3 tokens\)/.test(lim) && !/\$/.test(lim), lim);

    // Delta S1 — closes must also REACH the held span: a shared archive can end before this wallet held it.
    check("S1 rule: closes ending inside the held span ⇒ VALUED_UNTIL_EARLIER (limiting)",
      reconstructedTokenValuation({ licence: LIC, held: { fromISO: "2025-01-10", toISO: "2025-06-30" }, closesFromISO: "2025-01-01", closesToISO: "2025-03-31" }, {}) === "VALUED_UNTIL_EARLIER"
      && tokenValuationLimits("VALUED_UNTIL_EARLIER"));
    check("S1 rule: the reviewer's case — closes Jan–Mar 2025, held Oct 1 → Dec 15 ⇒ NOT valued at all",
      reconstructedTokenValuation({ licence: LIC, held: { fromISO: "2025-10-01", toISO: "2025-12-15" }, closesFromISO: "2025-01-01", closesToISO: "2025-03-31" }, {}) === "NOT_VALUED_YET");
    check("S1 rule: a tail within the tolerance is still VALUED; interior gaps are not inspected (as native)",
      reconstructedTokenValuation({ licence: LIC, held: { fromISO: "2025-01-10", toISO: null }, closesFromISO: "2025-01-01", closesToISO: "2026-10-25" }, {}) === "VALUED");
    const c6 = await loadValuationCoverage(covClient({ closes: "2025-01-01", closesTo: "2025-03-31" }) as never, "space");
    const n6s1 = valuationCoverageNote(c6, "2025-01-01") ?? "";
    check("S1 / re-review F3: the chart discloses a token whose prices end before it was sold — as LATER holdings, with the valued span, never 'older'",
      c6?.tokensValuedUntilEarlier === 1 && /Token valuation available Jan 1, 2025 – Mar 31, 2025; later token holdings lack historical prices \(1 token\) — those days aren’t valued, never counted as zero\./.test(n6s1)
      && !/Older token holdings/.test(n6s1), n6s1);

    // Delta F3 — ONE row kind (RAW_CLOSE) for first/last/gaps: a recent INTRADAY quote never extends close coverage.
    const c7 = await loadValuationCoverage(covClient({ closes: "2025-01-01", closesTo: "2025-03-31", intradayTo: "2026-10-27" }) as never, "space");
    check("F3: closes ending 2025-03 + one recent INTRADAY row ⇒ still VALUED_UNTIL_EARLIER (never VALUED)",
      c7?.tokensValuedUntilEarlier === 1 && !c7?.tokensValuedWithGaps, JSON.stringify(c7));
    check("F3 rule: closesToISO is RAW_CLOSE-only — the reviewer's case classifies limiting",
      reconstructedTokenValuation({ licence: LIC, held: { fromISO: "2025-01-10", toISO: null }, closesFromISO: "2025-01-01", closesToISO: "2025-03-31" }, {}) === "VALUED_UNTIL_EARLIER");
    // Delta F3 — interior gaps over held dates.
    check("F3 rule: tokenCloseGaps finds unserved interior days (d / d−1 rule), clamped to the held window",
      JSON.stringify(tokenCloseGaps(["2025-03-31", "2025-04-11"], "2025-01-10", "2025-06-30")) === JSON.stringify([{ fromISO: "2025-04-02", toISO: "2025-04-10" }])
      && tokenCloseGaps(["2025-03-31", "2025-04-02"], "2025-01-10", "2025-06-30").length === 0
      && tokenCloseGaps(["2025-03-31", "2025-04-11"], "2025-05-01", "2025-06-30").length === 0);
    check("F3 rule: closes spanning the held period with an interior hole ⇒ VALUED_WITH_GAPS (limiting); one missing day ⇒ VALUED",
      reconstructedTokenValuation({ licence: LIC, held: { fromISO: "2025-01-10", toISO: "2025-06-30" }, closesFromISO: "2025-01-01", closesToISO: "2026-10-27", closeDatesISO: denseCloses("x", "2025-01-01", "2026-10-27", gapDrop).map((r) => r.date.toISOString().slice(0, 10)) }, {}) === "VALUED_WITH_GAPS"
      && tokenValuationLimits("VALUED_WITH_GAPS")
      && reconstructedTokenValuation({ licence: LIC, held: { fromISO: "2025-01-10", toISO: "2025-06-30" }, closesFromISO: "2025-01-01", closesToISO: "2026-10-27", closeDatesISO: denseCloses("x", "2025-01-01", "2026-10-27", ["2025-04-01"]).map((r) => r.date.toISOString().slice(0, 10)) }, {}) === "VALUED");
    const c8 = await loadValuationCoverage(covClient({ closes: "2025-01-01", drop: gapDrop }) as never, "space");
    const n8 = valuationCoverageNote(c8, "2025-01-01") ?? "";
    check("F3: the chart discloses interior price gaps over held days as partial, never zero",
      c8?.tokensValuedWithGaps === 1 && c8?.tokenPriceGapsToISO === "2025-04-10" && /1 token has gaps in its historical prices/.test(n8) && /never counted as zero/.test(n8) && !/\$/.test(n8), n8);
    check("F3: …only when the displayed window reaches back over the gap",
      !/gaps in its historical prices/.test(valuationCoverageNote(c8, "2025-06-01") ?? ""));
    const c9 = await loadValuationCoverage(covClient({ closes: "2025-01-01", drop: ["2026-01-05", "2026-01-06", "2026-01-07"] }) as never, "space");
    check("F3: a gap AFTER it was sold is not a held-day gap (nothing disclosed)", !c9?.tokensValuedWithGaps, JSON.stringify(c9));
    const h5 = await wh("2025-01-01", { closesTo: "2025-03-31" });
    check("S1: closes ending before the sale ⇒ counted as valued-until-earlier (disclosed), balance unaffected",
      h5.tokensValuedUntilEarlier === 1 && h5.tokensValuedFromLater === 0 && h5.tokenValuedUntilRange?.toISO === "2025-03-31" && h5.complete === true, JSON.stringify(h5));
    // Re-review F3 — the History-tab copy for each case: older / later / gaps, never confused.
    const vt = (o: Parameters<typeof tokenValuationText>[5], older = 0) => tokenValuationText(0, older, null, 0, 0, o) ?? "";
    const later = vt({ valuedUntilEarlier: 1, valuedUntilRange: { fromISO: "2025-01-01", toISO: "2025-03-31" } });
    check("F3 copy: prices stopping early ⇒ 'Token valuation available Jan 1, 2025 – Mar 31, 2025; later token holdings lack historical prices' (never 'Older')",
      /^Token valuation available Jan 1, 2025 – Mar 31, 2025; later token holdings lack historical prices \(1 token\) — those days aren’t valued, never counted as zero\.$/.test(later) && !/Older/.test(later), later);
    const older = vt({}, 2);
    check("F3 copy: prices starting late keep the owner's 'Older holdings exist but lack historical prices'", /^Older holdings exist but lack historical prices \(2 tokens\)/.test(older), older);
    const gaps = vt({ withGaps: 2 });
    check("F3 copy: interior gaps say gaps", /^2 tokens have gaps in their historical prices — held days without a price aren’t valued, never counted as zero\.$/.test(gaps), gaps);
    const mixed = tokenValuationText(1, 0, "2026-10-27", 0, 1, { valuedUntilEarlier: 1, valuedUntilRange: { fromISO: null, toISO: "2025-03-31" }, withGaps: 1 }) ?? "";
    check("F3 copy: mixed — balance verified, older, later, gaps and excluded each said once, no $",
      /^Balance history verified through Oct 27, 2026\. Older holdings exist .*\(1 token\).* Token valuation available through Mar 31, 2025; later token holdings .* 1 token has gaps in its historical prices .* 1 token excluded as spam or non-economic\.$/.test(mixed) && !/\$/.test(mixed), mixed);
    check("F3 copy (chart): the shared sentence helpers", laterHoldingsUnpricedText(0, null, (x) => x) === null && tokenPriceGapsText(1) === "1 token has gaps in its historical prices — held days without a price aren’t valued, never counted as zero.");

    // F3 — a page that fails persistently: restarts are bounded, re-reads are not progress, the backoff engages.
    const fm3 = newMem();
    const stuck3: Chain = { head: 3000, calls: [], pageSize: 1, txs: [tx(USDC, 100, OTHER, WALLET, 1_000_000), tx(USDC, 200, OTHER, WALLET, 1_000_000), tx(USDC, 300, OTHER, WALLET, 1_000_000)] };
    for (let i = 0; i < 4 && sectionOf(fm3)?.segment?.pageKey !== "1"; i++) await step(stuck3, fm3, { cfg: { maxPagesPerStep: 2 } });
    stuck3.failPageKey = "1";
    const T3 = Date.parse("2026-10-28T13:00:00Z");
    let steps = 0;
    for (; steps < 30 && !erc20BackedOff(sectionOf(fm3), T3 + steps * 900_000); steps++) {
      if (!erc20WorkOwed(sectionOf(fm3), "2026-10-28", T3 + steps * 900_000)) break;
      await step(stuck3, fm3, { cfg: { maxPagesPerStep: 2 }, now: T3 + steps * 900_000 });
    }
    const s3 = sectionOf(fm3);
    check("F3: a persistently failing page reaches the backoff (it no longer loops below it)", erc20BackedOff(s3, T3 + steps * 900_000) && steps < 30, JSON.stringify({ steps, f: s3.failures, r: s3.segmentRestarts }));
    check("F3: restarts are counted and bounded", (s3.segmentRestarts ?? 0) >= 1 && (s3.segmentRestarts ?? 0) <= ERC20_SEGMENT_RESTART_LIMIT, String(s3.segmentRestarts));

    // Delta L1 — a budget-stopped replay never fires a second restart; an unservable page becomes terminal + visible.
    const rm = newMem();
    const long: Chain = { head: 3000, calls: [], pageSize: 1, txs: Array.from({ length: 8 }, (_, i) => tx(USDC, 100 + i * 10, OTHER, WALLET, 1_000_000)) };
    for (let i = 0; i < 12 && sectionOf(rm)?.segment?.pageKey !== "6"; i++) await step(long, rm, { cfg: { maxPagesPerStep: 1 } });
    long.failPageKey = "6";
    for (let i = 0; i < ERC20_SEGMENT_RESTART_AFTER; i++) await step(long, rm, { cfg: { maxPagesPerStep: 2 } });
    await step(long, rm, { cfg: { maxPagesPerStep: 2 } }); // restart #1; replays 2 of its 7 pages, stops on its page budget
    check("L1 (setup): one restart, replay under way", sectionOf(rm).segmentRestarts === 1 && (sectionOf(rm).segment?.pages ?? 0) < 6);
    await step(long, rm, { cfg: { maxPagesPerStep: 2 } }); // still replaying: must NOT restart again
    check("L1: a budget-stopped replay step does not fire a second restart", sectionOf(rm).segmentRestarts === 1 && sectionOf(rm).lastFailure?.code === "SCAN_REPLAYING",
      JSON.stringify({ r: sectionOf(rm).segmentRestarts, f: sectionOf(rm).lastFailure?.code, p: sectionOf(rm).segment?.pages }));
    const stuckM = newMem();
    const dead6: Chain = { head: 3000, calls: [], pageSize: 1, txs: long.txs };
    for (let i = 0; i < 12 && sectionOf(stuckM)?.segment?.pageKey !== "6"; i++) await step(dead6, stuckM, { cfg: { maxPagesPerStep: 7 } });
    dead6.failPageKey = "6";
    let n6 = 0;
    for (; n6 < 40 && !sectionOf(stuckM).scanStuck; n6++) await step(dead6, stuckM, { cfg: { maxPagesPerStep: 7 } }); // no clock ⇒ no backoff gate here
    const ss = sectionOf(stuckM);
    check("L1: a permanently unservable page becomes TERMINAL (scanStuck), after every restart is spent",
      !!ss.scanStuck && ss.segmentRestarts === ERC20_SEGMENT_RESTART_LIMIT && ss.failures >= ERC20_SCAN_STUCK_AFTER, JSON.stringify({ n6, f: ss.failures, r: ss.segmentRestarts }));
    check("L1: …stops spending calls, reads incomplete, and says so (operator-visible)", !erc20WorkOwed(ss, "2026-10-29", Date.now() + ERC20_BACKOFF_MS + 60_000) /* past any backoff: terminal, not merely backed off */
      && summarizeSection(ss).stuck && !erc20HistoryComplete(summarizeSection(ss)) && !!ss.scanStuck?.detail);
    const before6 = dead6.calls.length;
    await step(dead6, stuckM, { cfg: { maxPagesPerStep: 7 }, today: "2026-10-30" });
    check("L1: …and no further provider call is spent on it", dead6.calls.length === before6);
    check("L1: the operator reset re-arms it", !resetErc20Section(ss).scanStuck && erc20WorkOwed(resetErc20Section(ss), "2026-10-30"));

    // Delta L2 — probe attempts are an ATTEMPT count, never "calls" (not an external provider in Platform Ops).
    const units: string[] = [];
    let readUnit: unknown = null;
    const g = defaultProbeGate({ apiUsageCounter: { findMany: async (a: { where: { provider: string; unit: unknown } }) => { if (a.where.provider === ERC20_PROBE_USAGE_PROVIDER) readUnit = a.where.unit; return []; } },
      apiUsage: undefined } as never, { COINGECKO_DAILY_CALL_CAP: "250" }, async (_p, _m, unit) => { units.push(unit); });
    await g.allowance().catch(() => 0); await g.record(1);
    check("L2: the probe count is written AND read with unit 'attempts' (like PRICE_GAP)", units.join() === "attempts" && readUnit === "attempts" && ERC20_PROBE_USAGE_UNIT === "attempts");

    // Delta NIT — the allowance is re-read before every probe.
    for (const k of Object.keys(meta)) delete meta[k];
    let reads = 0;
    const twoTokens = { ...client, instrumentAlias: { ...client.instrumentAlias, findMany: async () => [
      { instrumentId: "usdc", externalId: EXITED_KEY, metadata: {} }, { instrumentId: "dai2", externalId: `eip155:1/erc20:${DAI}`, metadata: {} }] },
      positionCoverage: { findMany: async () => ["usdc", "dai2"].map((id) => ({ instrumentId: id, coveredFromDate: new Date("2025-01-10T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z") })) },
      positionObservation: { groupBy: async ({ where }: { where: { quantity?: unknown } }) => (JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 })
        ? ["usdc", "dai2"].map((id) => ({ financialAccountId: "acc", instrumentId: id, _min: { date: new Date("2025-01-10T00:00:00Z") }, _max: { date: new Date("2025-06-30T00:00:00Z") } })) : []) } };
    await acquireErc20HistoricalPrices({ client: twoTokens as never, accountId: "acc", instrumentIds: ["usdc", "dai2"], maxTokens: 5, acquire: async () => ({ status: "THIN_OR_UNPRICED", inserted: 0, earliestISO: null, calls: 0 }),
      probe: async () => 1, probeGate: { allowance: async () => { reads++; return 5; }, record: async () => {} }, now: () => NOW });
    check("NIT: the probe allowance is re-checked before each probe", reads === 2, String(reads));

    // F5 — the regeneration window only WIDENS: token rows count, and a licensed token start widens it (SPL and ERC-20 alike).
    const floorClient = (o: { positionMin: string | null; tokenLicenceMin: string | null }) => {
      const seen: unknown[] = [];
      const agg = (v: Record<string, unknown>) => async () => ({ _min: v });
      return { seen, c: {
        transaction: { aggregate: agg({ date: null }) }, investmentEvent: { aggregate: agg({ date: null }) },
        investmentEventCoverage: { aggregate: agg({ earliestReturnedDate: null }) },
        positionObservation: { aggregate: async (a: { where: unknown }) => { seen.push(a.where); return { _min: { date: o.positionMin ? new Date(`${o.positionMin}T00:00:00Z`) : null } }; } },
        positionCoverage: { aggregate: async () => ({ _min: { coveredFromDate: o.tokenLicenceMin ? new Date(`${o.tokenLicenceMin}T00:00:00Z`) : null } }) },
      } };
    };
    const spl = floorClient({ positionMin: "2026-01-01", tokenLicenceMin: "2023-05-02" }); // an SPL licence reaching back further than any row
    check("F5: an SPL licensed token start widens the evidence floor", (await resolveEvidenceFloor(spl.c as never, ["acc"])) === "2023-05-02");
    const erc = floorClient({ positionMin: "2024-03-05", tokenLicenceMin: "2024-03-05" }); // ERC-20 rows from the licence start
    check("F5: ERC-20 token rows count toward the floor (never narrowed)", (await resolveEvidenceFloor(erc.c as never, ["acc"])) === "2024-03-05"
      && !JSON.stringify(erc.seen[0]).includes("NOT"), JSON.stringify(erc.seen[0]));
    const nat = floorClient({ positionMin: "2022-01-01", tokenLicenceMin: "2024-01-01" });
    check("F5: a later token licence never narrows it", (await resolveEvidenceFloor(nat.c as never, ["acc"])) === "2022-01-01");
  }

  // ── 21. OWNER RULING 2026-10-30 — one coverage model: balance ≠ price ≠ valuation (SPL + ERC-20 + native) ──
  {
    const SPL_KEY = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const ERC_KEY = `eip155:1/erc20:${USDC}`;
    const nativeDone = { instrumentId: "n", assetKey: "k", label: "X", state: "RECONSTRUCTED" as const, licensedFromISO: "2020-01-01", licensedToISO: "2026-10-27" };
    const fullTok = { state: "RECONSTRUCTED", coverageKind: "COMPLETE" } as never;

    // (1) Balance completeness is independent of prices — SOL/SPL and ETH/ERC-20 through the SAME rule.
    for (const chain of ["SOL", "ETH"]) {
      check(`RULING 1 (${chain}): unpriced / partly priced tokens never make BALANCE history incomplete`,
        walletHistoryComplete({ chain, native: nativeDone, tokens: [fullTok], tokenInventoryComplete: true, tokensNotValuedYet: 3, tokensValuedFromLater: 2 }) === true);
      check(`RULING 1 (${chain}): …while an unverified balance still does`, walletHistoryComplete({ chain, native: nativeDone, tokens: [fullTok], tokenInventoryComplete: false }) === false);
    }
    const solConn = { id: "c", provider: "WALLET", state: "active" } as never;
    const solIntel = { positionObservedAt: "2026-10-28T10:00:00Z", valuationIsReadTime: true,
      walletHistory: { supported: true, licensed: true, licensedFromISO: "2022-01-01", licensedToISO: "2026-10-27", activityFromISO: "2022-01-01",
        priceFromISO: "2022-01-01", chart: { fromISO: "2022-01-01", toISO: "2026-10-27", days: 1761, continuous: true }, chain: "SOL",
        tokens: [{ label: "USDC", standard: "SPL", priceStatus: "MARKET_PRICE", historyState: "RECONSTRUCTED", coverageKind: "COMPLETE", licensedFromISO: "2022-01-01", firstObservedISO: "2026-10-01", lastObservedISO: "2026-10-27" }],
        walletComplete: true, tokensNotValuedYet: 1, tokensValuedFromLater: 1 } } as never;
    check("RULING 1 (SPL): Connections never reads 'limited' for missing token prices", connectionHealth(solConn, solIntel, new Date("2026-10-28T12:00:00Z")).headline === "Current holdings ready");

    // (2)+(3) Per-day valuation: a held token with a market but no price SERVING the day makes the day incomplete —
    // one EARLIER price never covers later held days (single-earlier-price rule). Same rule for SPL and ERC-20 instruments.
    for (const [label, id] of [["SPL", "spl-usdc"], ["ERC-20", "erc-usdc"]] as const) {
      const obs = [{ instrumentId: id, dateISO: "2025-10-01", quantity: 100 }, { instrumentId: id, dateISO: "2025-10-20", quantity: 100 }];
      const early = [{ instrumentId: id, dateISO: "2025-03-31", basis: "RAW_CLOSE" as const, priceUsd: 1 }];
      const t = tokensValueOnDay(obs, early, "2025-10-20");
      check(`RULING 3 (${label}): an earlier price never values a later held day (UNPRICED, value null — never $0)`,
        t.tokens[0].state === "UNPRICED" && t.tokens[0].valueUsd === null && t.totalUsd === 0);
      check(`RULING 2 (${label}): that day's valuation is INCOMPLETE (the crypto component is refused, as native)`,
        tokenDayMissingRequiredPrice(t.tokens, () => false) === true);
      check(`RULING 2 (${label}): only an EXPLICITLY excluded token never blocks`, tokenDayMissingRequiredPrice(t.tokens, () => true) === false);
      const priced = tokensValueOnDay(obs, [...early, { instrumentId: id, dateISO: "2025-10-19", basis: "RAW_CLOSE" as const, priceUsd: 1 }], "2025-10-20");
      check(`RULING 2 (${label}): a price serving the day ⇒ complete, valued`, !tokenDayMissingRequiredPrice(priced.tokens, () => false) && priced.totalUsd === 100);
      const closed = tokensValueOnDay([...obs, { instrumentId: id, dateISO: "2025-10-25", quantity: 0 }], early, "2025-10-26");
      check(`RULING 2 (${label}): a closed (0) token never blocks`, !tokenDayMissingRequiredPrice(closed.tokens, () => false));
    }
    check("RULING 2 (native non-regression): a wallet with no tokens is unaffected", tokenDayMissingRequiredPrice([], () => false) === false);
    // Delta review F1/F2 — BEHAVIOURAL: the binding's day gate (cryptoDayHeldUnvalued) feeding the
    // pure day decision (regenerateDay), with the wallet EMPTIED TODAY (flat base ≈ 0) — the case a
    // current-balance guard could not see. Never $0; preserved as "unavailable".
    {
      const STORED_ROW = { stocks: 0, crypto: 640, total: 640, cash: 100, savings: 0, debt: 0, netWorth: 740, totalAssets: 740, netLiquid: 100, cashOnHand: 100 };
      const day = (gate: { heldUnvalued: boolean; tokenPriceMissing: boolean }, nativeLicensed: boolean, valuedUsd: number, existing: typeof STORED_ROW | null = STORED_ROW) => regenerateDay({
        date: "2025-06-01", existingIsEstimated: existing ? true : null, existing,
        base: { totalInvestments: 0, totalDigitalAssets: 0 /* emptied today */, totalChecking: 100, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
        investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
        digitalAssetValue: valuedUsd, digitalAssetTier: "estimated",
        hasDigitalAssetEvidence: nativeLicensed && !gate.tokenPriceMissing, // the binding's rule
        digitalAssetHeldUnvalued: gate.heldUnvalued,
        cashCardTier: "derived", membershipChangedSince: false,
      });
      const cryptoOf = (r: ReturnType<typeof regenerateDay>) => r.components?.find((c) => c.component === "crypto");
      const usdtObs = [{ instrumentId: "usdt", dateISO: "2025-05-30", quantity: 640 }];
      const nativeOk = { licensed: true, positionCount: 0 }; // ETH drained to 0 on this day: no native position
      // (a) unpriced held token, wallet emptied today ⇒ refused / unavailable, never 0.
      const unpriced = tokensValueOnDay(usdtObs, [], "2025-06-01").tokens;
      const ga = cryptoDayHeldUnvalued({ native: nativeOk, tokens: unpriced, excluded: () => false });
      const ra = day(ga, true, 0);
      check("F1 (a): emptied-today wallet + unpriced held USDT ⇒ crypto PRESERVED, verdict unavailable — never $0",
        ga.heldUnvalued && ra.cryptoValuationStatus === "unavailable" && cryptoOf(ra)?.action === "preserved" && cryptoOf(ra)?.authorized === false
        && cryptoOf(ra)?.value === 640 && ra.fieldPatch?.crypto === undefined, JSON.stringify({ ga, v: ra.cryptoValuationStatus, c: cryptoOf(ra) }));
      const raNoRow = day(ga, true, 0, null);
      check("F1 (a): …and with no stored row the day is skipped (unsupported), never written as 0",
        raNoRow.action === "skip-unsupported" && raNoRow.fields === null && raNoRow.cryptoValuationStatus === "unavailable");
      // (b) priced held day ⇒ valued.
      const priced = tokensValueOnDay(usdtObs, [{ instrumentId: "usdt", dateISO: "2025-06-01", basis: "RAW_CLOSE", priceUsd: 1 }], "2025-06-01");
      const gb = cryptoDayHeldUnvalued({ native: nativeOk, tokens: priced.tokens, excluded: () => false });
      const rb = day(gb, true, priced.totalUsd);
      check("F1 (b): a priced held day is VALUED (recomputed, supported, 640)",
        !gb.heldUnvalued && rb.cryptoValuationStatus === "supported" && cryptoOf(rb)?.action === "recomputed" && cryptoOf(rb)?.value === 640, JSON.stringify(cryptoOf(rb)));
      // (c) NO_MARKET held token ⇒ refused (no-market is not spam).
      const gc = cryptoDayHeldUnvalued({ native: nativeOk, tokens: unpriced, excluded: (id) => tokenValuationExclusion(id === "usdt" ? { quote: { outcome: "THIN" } } : {}) !== null });
      const rc = day(gc, true, 0);
      check("F1 (c): a NO_MARKET (thin) held token still refuses the day — never excluded by itself",
        gc.heldUnvalued && rc.cryptoValuationStatus === "unavailable" && cryptoOf(rc)?.action === "preserved");
      // (d) explicitly excluded ⇒ not blocking, and shown distinct (EXCLUDED, never VALUED / NO_MARKET).
      const spamMeta = { exclusion: { kind: "SPAM", source: "operator", atISO: "2026-10-30" } };
      const gd = cryptoDayHeldUnvalued({ native: nativeOk, tokens: unpriced, excluded: (id) => id === "usdt" && tokenValuationExclusion(spamMeta) !== null });
      const rd = day(gd, true, 0);
      check("F1 (d): an EXPLICITLY excluded held token does not block the day",
        !gd.heldUnvalued && !gd.tokenPriceMissing && cryptoOf(rd)?.action === "recomputed");
      check("F1 (d): …and is classified apart (EXCLUDED, counted separately)",
        reconstructedTokenValuation({ licence: { fromISO: "2025-01-10", toISO: "2026-10-27" }, held: { fromISO: "2025-01-10", toISO: null }, closesFromISO: null }, spamMeta) === "EXCLUDED"
        && /excluded as spam/.test(valuationCoverageNote(deriveValuationCoverage([], new Map(), null, null, { notValuedYet: 0, withoutMarket: 0, excluded: 1 }), "2025-01-01") ?? ""));
      // (e) never-held token ⇒ not blocking.
      const never = tokensValueOnDay([{ instrumentId: "spam", dateISO: "2025-05-30", quantity: 0 }], [], "2025-06-01").tokens;
      const ge = cryptoDayHeldUnvalued({ native: nativeOk, tokens: never, excluded: () => false });
      check("F1 (e): a never-held (0-balance) token never blocks the day", !ge.heldUnvalued && cryptoOf(day(ge, true, 0))?.action === "recomputed");
      // Native: the SAME code path — an unpriced native position on a drained-today wallet refuses too.
      const nat = valueCryptoDay({ accounts: [{ financialAccountId: "w", name: "w", nativeBalance: 0.5, assetKey: "eth", symbol: "ETH", applicable: true }], unitPriceByAssetKey: { eth: null }, quantityLicensed: true });
      const gn = cryptoDayHeldUnvalued({ native: { licensed: nat.licensed, positionCount: nat.positionCount }, tokens: [], excluded: () => false });
      const rn = day(gn, nat.licensed, 0);
      check("F1 native: an unpriced held ETH position on a drained-today wallet ⇒ unavailable, never $0",
        nat.refusal === "NO_PRICE" && gn.heldUnvalued && rn.cryptoValuationStatus === "unavailable" && cryptoOf(rn)?.action === "preserved");
      const natZero = valueCryptoDay({ accounts: [{ financialAccountId: "w", name: "w", nativeBalance: 0, assetKey: "eth", symbol: "ETH", applicable: true }], unitPriceByAssetKey: { eth: 3000 }, quantityLicensed: true });
      const gz = cryptoDayHeldUnvalued({ native: { licensed: natZero.licensed, positionCount: natZero.positionCount }, tokens: [], excluded: () => false });
      check("F1 native non-regression: a priced, genuinely empty wallet still values to 0 (supported zero is allowed)",
        !gz.heldUnvalued && cryptoOf(day(gz, true, 0))?.action === "recomputed");
      const natDeclared = valueCryptoDay({ accounts: [{ financialAccountId: "w", name: "w", nativeBalance: 0, assetKey: "eth", symbol: "ETH", applicable: true }], unitPriceByAssetKey: { eth: null }, quantityLicensed: true });
      check("F1 native non-regression: an empty wallet on a day with no price is NOT flagged held (W-M0 declared-asset rule unchanged)",
        !cryptoDayHeldUnvalued({ native: { licensed: natDeclared.licensed, positionCount: natDeclared.positionCount }, tokens: [], excluded: () => false }).heldUnvalued);
    }
    // Wiring pin (complements the behavioural checks above): the binding feeds the gate into the day input.
    const regenSrc = read("lib", "snapshots", "regenerate-history.ts");
    check("F1 wiring: regeneration runs the ONE token day decision and passes digitalAssetHeldUnvalued into regenerateDay",
      /cryptoTokenDayDecision\(/.test(regenSrc) && /digitalAssetHeldUnvalued = tokenDay\.heldUnvalued;/.test(regenSrc) && /\n\s+digitalAssetHeldUnvalued,\n/.test(regenSrc)
      && /const plan = planDayPersistence\(res, prior \?\? null\);/.test(regenSrc) && /if \(applyWrites && plan\.stamp !== null\) metadataOnlyStamps\.push/.test(regenSrc));

    // Re-review F2 — BEHAVIOURAL: the binding's token-input construction (rows → tokens → gate → join),
    // run exactly as the binding runs it. Kills M10 (the gate handed no tokens).
    {
      const rows = (prices: { instrumentId: string; dateISO: string; basis: "RAW_CLOSE" | "INTRADAY"; priceUsd: number }[], excl: string[] = []) => ({
        observationsByAccount: new Map([["w1", [{ instrumentId: "usdt", dateISO: "2025-05-30", quantity: 640 }]], ["w2", [{ instrumentId: "spam", dateISO: "2025-05-30", quantity: 0 }]]]),
        prices, identity: new Map([["usdt", { excluded: excl.includes("usdt") }], ["spam", {}]]),
      });
      const ok = { licensed: true, positionCount: 0 };
      const d1 = cryptoTokenDayDecision(ok, rows([]), "2025-06-01");
      check("F2: rows with an unpriced held token ⇒ heldUnvalued, tokens do not join", d1.heldUnvalued && d1.tokenPriceMissing && !d1.tokensJoin && d1.valuedTokenUsd.length === 0, JSON.stringify(d1));
      const d2 = cryptoTokenDayDecision(ok, rows([{ instrumentId: "usdt", dateISO: "2025-06-01", basis: "RAW_CLOSE", priceUsd: 1 }]), "2025-06-01");
      check("F2: priced ⇒ joins with its USD value", !d2.heldUnvalued && d2.tokensJoin && d2.valuedTokenUsd.join() === "640");
      const d3 = cryptoTokenDayDecision(ok, rows([], ["usdt"]), "2025-06-01");
      check("F2: explicitly excluded ⇒ not blocking, not valued", !d3.heldUnvalued && d3.tokensJoin && d3.valuedTokenUsd.length === 0);
      const d4 = cryptoTokenDayDecision({ licensed: false, positionCount: 0 }, rows([{ instrumentId: "usdt", dateISO: "2025-06-01", basis: "RAW_CLOSE", priceUsd: 1 }]), "2025-06-01");
      check("F2: native refused + held token ⇒ heldUnvalued, nothing joins", d4.heldUnvalued && !d4.tokensJoin);
      check("F2: no token rows ⇒ nothing blocks (native unaffected)", !cryptoTokenDayDecision(ok, null, "2025-06-01").heldUnvalued);
      // …and through the day core: emptied-today wallet ⇒ never $0.
      const r = regenerateDay({ date: "2025-06-01", existingIsEstimated: true,
        existing: { stocks: 0, crypto: 640, total: 640, cash: 100, savings: 0, debt: 0, netWorth: 740, totalAssets: 740, netLiquid: 100, cashOnHand: 100 },
        base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 100, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
        investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false, digitalAssetValue: 0, digitalAssetTier: "estimated",
        hasDigitalAssetEvidence: d1.tokensJoin, digitalAssetHeldUnvalued: d1.heldUnvalued, cashCardTier: "derived", membershipChangedSince: false });
      check("F2: rows → decision → regenerateDay ⇒ crypto preserved, unavailable", r.cryptoValuationStatus === "unavailable" && r.components?.find((c) => c.component === "crypto")?.action === "preserved");
    }

    // Re-review F1 — BINDING PERSISTENCE DECISION (planDayPersistence, what the binding executes):
    // a changed verdict is recorded on an owned row even when the partial patch is EMPTY.
    {
      const row = (crypto: number, status: string | null, isEstimated = true) => ({ stocks: 0, crypto, total: crypto, cash: 100, savings: 0, debt: 0, netWorth: 100 + crypto, totalAssets: 100 + crypto, netLiquid: 100, cashOnHand: 100, isEstimated, cryptoValuationStatus: status });
      const dayFor = (prior: ReturnType<typeof row> | null, o: { heldUnvalued: boolean; evidence: boolean; value: number }) => regenerateDay({
        date: "2025-06-01", existingIsEstimated: prior ? prior.isEstimated : null, existing: prior,
        base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 100, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
        investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false, digitalAssetValue: o.value, digitalAssetTier: "estimated",
        hasDigitalAssetEvidence: o.evidence, digitalAssetHeldUnvalued: o.heldUnvalued, cashCardTier: "derived", membershipChangedSince: false });
      // Scenario A — an earlier run wrote crypto = 0 under a null status (read as an asserted $0).
      const priorA = row(0, null);
      const resA = dayFor(priorA, { heldUnvalued: true, evidence: false, value: 0 });
      const planA = planDayPersistence(resA, priorA);
      check("F1 (A): emptied-today wallet, stored crypto 0 / status null ⇒ write-partial, EMPTY patch, yet the verdict is STAMPED 'unavailable'",
        resA.action === "write-partial" && Object.keys(resA.fieldPatch ?? {}).length === 0 && planA.patch === null && !planA.write && planA.stamp === "unavailable", JSON.stringify({ a: resA.action, p: resA.fieldPatch, planA }));
      // Scenario B — a native-only row stamped "supported"; a held unpriced token now appears.
      const priorB = row(500, "supported");
      const resB = dayFor(priorB, { heldUnvalued: true, evidence: false, value: 0 });
      const planB = planDayPersistence(resB, priorB);
      check("F1 (B): a 'supported' row whose day now holds an unpriced token ⇒ stamped 'unavailable' (no financial field touched)",
        resB.action === "write-partial" && planB.patch === null && planB.stamp === "unavailable" && !planB.write, JSON.stringify(planB));
      // Reverse — prices arrive later: the row re-earns "supported".
      const priorR = row(500, "unavailable");
      const resR = dayFor(priorR, { heldUnvalued: false, evidence: true, value: 500 });
      const planR = planDayPersistence(resR, priorR);
      check("F1 (reverse): prices arrive, value unchanged ⇒ UNCHANGED, stamped back to 'supported'",
        planR.disposition === "UNCHANGED" && !planR.write && planR.stamp === "supported", JSON.stringify(planR));
      const resR2 = dayFor(priorR, { heldUnvalued: false, evidence: true, value: 640 });
      const planR2 = planDayPersistence(resR2, priorR);
      check("F1 (reverse): prices arrive with a new value ⇒ a full WRITE carrying 'supported' (no separate stamp)",
        planR2.write && planR2.disposition === "UPDATED" && planR2.stamp === null && resR2.cryptoValuationStatus === "supported");
      // Never a row class regeneration does not own.
      const frozen = row(0, null, false);
      check("F1: a frozen (observed) row is never stamped", planDayPersistence(dayFor(frozen, { heldUnvalued: true, evidence: false, value: 0 }), frozen).stamp === null);
      // …even when an amendment reaches it (the core then decides a verdict): the stamp still never touches a row class regeneration does not own.
      const amendRes = regenerateDay({ ...{ date: "2025-06-01", existingIsEstimated: false, existing: frozen,
        base: { totalInvestments: 0, totalDigitalAssets: 0, totalChecking: 100, totalSavings: 0, totalLiabilities: 0, totalRealAssets: 0 },
        investmentValue: 0, investmentTier: "derived" as const, hasInvestmentEvidence: false, digitalAssetValue: 0, digitalAssetTier: "estimated" as const,
        hasDigitalAssetEvidence: false, digitalAssetHeldUnvalued: true, cashCardTier: "derived" as const, membershipChangedSince: false }, isAmendment: true });
      check("F1: an amendment's verdict on a frozen row is never written as a status-only stamp",
        amendRes.cryptoValuationStatus === "unavailable" && planDayPersistence(amendRes, frozen).stamp === null, JSON.stringify({ a: amendRes.action, v: amendRes.cryptoValuationStatus }));
      check("F1: no stored row ⇒ nothing stamped (never creates a row)", planDayPersistence(dayFor(null, { heldUnvalued: true, evidence: false, value: 0 }), null).stamp === null);
      const same = row(0, "unavailable");
      check("F1: an already-correct verdict is not re-stamped (idempotent)", planDayPersistence(dayFor(same, { heldUnvalued: true, evidence: false, value: 0 }), same).stamp === null);
    }
    check("RULING 2: the exclusion rule is ONE function for SPL and ERC-20 (alias metadata, no chain branch)",
      /excluded: tokenValuationExclusion\(a\.metadata\) !== null/.test(read("lib", "crypto", "token-valuation.ts")) && tokenHasNoMarket({ quote: { outcome: "THIN" } }));

    // (4) Disclosure: concise, the three statements, for both chains (the loader is chain-agnostic; keys of both kinds).
    for (const key of [SPL_KEY, ERC_KEY]) {
      const cv = deriveValuationCoverage([], new Map(), null, "2025-10-28", { notValuedYet: 1, withoutMarket: 0 });
      const note = valuationCoverageNote(cv, "2024-01-01") ?? "";
      check(`RULING 4 (${key.startsWith("solana") ? "SPL" : "ERC-20"}): chart says "Token valuation available from" + "Older token holdings exist but lack historical prices"`,
        /Token valuation available from Oct 28, 2025\./.test(note) && /Older token holdings exist but lack historical prices/.test(note) && !/\$|\b0\.00\b/.test(note), note);
    }
    const hist = connectionHistory(solConn, solIntel, [{ id: "a", name: "w", type: "crypto", chain: "SOL" } as never]).limitations.join(" ");
    check("RULING 4 (SPL): History tab: 'Balance history verified through <date>. Older holdings exist but lack historical prices'",
      /Balance history verified through Oct 27, 2026\. Older holdings exist but lack historical prices \(2 tokens\)/.test(hist), hist);

    // (5) Verified balances and checkpoints are preserved: valuation code never writes rows, licences or checkpoints.
    const valuationSrc = ["lib/connections/valuation-coverage.ts", "lib/crypto/token-valuation.ts", "lib/crypto/token-valuation.core.ts", "lib/crypto/token-held-spans.ts", "lib/crypto/wallet-instrument-history.ts"]
      .map((f) => read(...f.split("/"))).join("\n");
    check("RULING 5: valuation never deletes or rewrites balances, licences or checkpoints",
      !/positionObservation\.(delete|update|create)|positionCoverage\.(delete|update|upsert|create)|casHistoryCheckpoint|historyCheckpoint\s*:/.test(valuationSrc));

    // (6) Native non-regression.
    const nativeOnly = deriveValuationCoverage([{ symbol: "ETH", instrumentId: "eth", balanceFromISO: "2017-01-01" }], new Map([["eth", "2018-01-01"]]));
    const nn = valuationCoverageNote(nativeOnly, "2018-01-01") ?? "";
    check("RULING 6 (native): the native price-floor note is unchanged and carries no token sentence",
      /ETH balances are known from Jan 1, 2017, but its historical prices start Jan 1, 2018/.test(nn) && !/[Tt]oken/.test(nn), nn);
    check("RULING 6 (native): a native-only wallet's completeness is unchanged",
      walletHistoryComplete({ chain: "BTC", native: nativeDone, tokens: [] }) === true && walletHistoryComplete({ chain: "BTC", native: { ...nativeDone, state: "NOT_RECONSTRUCTED" }, tokens: [] }) === false);
  }

  // ── 22. OWNER CLARIFICATION 2026-10-30 — "no market price" ≠ spam: only an EXPLICIT classification excludes ──
  {
    const LIC2 = { fromISO: "2025-01-10", toISO: "2026-10-27" };
    const held = { fromISO: "2025-01-10", toISO: null };
    const SPAM_META = { exclusion: { kind: "SPAM", source: "operator:test", atISO: "2026-10-30T00:00:00Z" } };
    for (const [label, key] of [["SPL", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], ["ERC-20", `eip155:1/erc20:${SPAM}`]] as const) {
      // (a) a legitimate unpriced held token ⇒ the affected dates are incomplete.
      const id = `${label}-tok`;
      const obs = [{ instrumentId: id, dateISO: "2025-10-01", quantity: 5 }];
      const day = tokensValueOnDay(obs, [], "2025-10-02");
      const meta = new Map<string, unknown>([[id, {}]]);
      const excl = (m: Map<string, unknown>) => (iid: string) => tokenValuationExclusion(m.get(iid)) !== null;
      check(`CLARIFY (${label} ${key.slice(0, 6)}): a legitimate unpriced held token ⇒ that date's valuation is incomplete`, tokenDayMissingRequiredPrice(day.tokens, excl(meta)));
      // (b) NO_MARKET / thin / unlisted are NOT excluded.
      for (const q of ["UNLISTED", "THIN", "INVALID"]) {
        const m = new Map<string, unknown>([[id, { quote: { outcome: q, attemptedAt: "x" } }]]);
        check(`CLARIFY (${label}): a ${q} held token is NOT excluded — its dates stay incomplete, and it is limiting`,
          tokenDayMissingRequiredPrice(day.tokens, excl(m)) && reconstructedTokenValuation({ licence: LIC2, held, closesFromISO: null }, m.get(id)) === "NO_MARKET" && tokenValuationLimits("NO_MARKET"));
      }
      // (c) an EXPLICITLY classified spam token is excluded, still visible, counted apart.
      const ms = new Map<string, unknown>([[id, SPAM_META]]);
      check(`CLARIFY (${label}): an explicitly classified spam token is EXCLUDED (never blocks, never limiting)`,
        !tokenDayMissingRequiredPrice(day.tokens, excl(ms)) && reconstructedTokenValuation({ licence: LIC2, held, closesFromISO: null }, SPAM_META) === "EXCLUDED" && !tokenValuationLimits("EXCLUDED"));
      check(`CLARIFY (${label}): …but it is still a visible token row (UNPRICED, value null — never $0, never dropped)`, day.tokens.length === 1 && day.tokens[0].state === "UNPRICED" && day.tokens[0].valueUsd === null);
      // (d) NEVER_HELD is excluded.
      check(`CLARIFY (${label}): NEVER_HELD (zero throughout) is excluded`, reconstructedTokenValuation({ licence: LIC2, held: null, closesFromISO: null }, {}) === "NEVER_HELD"
        && !tokenDayMissingRequiredPrice(tokensValueOnDay([{ instrumentId: id, dateISO: "2025-10-01", quantity: 0 }], [], "2025-10-02").tokens, () => false));
    }
    check("CLARIFY: an UNATTRIBUTED or unknown-kind 'exclusion' is not a classification (no heuristic, no guess)",
      tokenValuationExclusion({ exclusion: { kind: "SPAM" } }) === null && tokenValuationExclusion({ exclusion: { kind: "LOOKS_SPAMMY", source: "x" } }) === null && tokenValuationExclusion(null) === null);
    check("CLARIFY: nothing in the runtime WRITES an exclusion today (only NEVER_HELD is excluded in practice)",
      !/exclusion\s*:\s*\{/.test(["lib/crypto/wallet-token-capture.ts", "lib/prices/current-quotes.ts", "lib/crypto/erc20-history.store.ts", "lib/crypto/spl-history.store.ts", "lib/crypto/token-instrument.ts"].map((f) => read(...f.split("/"))).join("\n")));
    // Copy: excluded tokens are counted APART from legitimate unpriced holdings.
    const cv = deriveValuationCoverage([], new Map(), null, null, { notValuedYet: 1, withoutMarket: 1, excluded: 2 });
    const note = valuationCoverageNote(cv, "2025-01-01") ?? "";
    check("CLARIFY: chart copy keeps them distinct — 'lack historical prices' vs 'N tokens excluded as spam'",
      /Older token holdings exist but lack historical prices \(1 token\)/.test(note) && /without a reliable market price/.test(note) && /2 tokens excluded as spam or non-economic\./.test(note), note);
    const t = tokenValuationText(1, 0, "2026-10-27", 1, 2) ?? "";
    check("CLARIFY: History copy counts NO_MARKET with the unpriced holdings and the excluded apart",
      /lack historical prices \(2 tokens\)/.test(t) && /2 tokens excluded as spam or non-economic\./.test(t), t);
    // Native non-regression.
    check("CLARIFY (native): native-only days and notes are unaffected", tokenDayMissingRequiredPrice([], () => false) === false
      && valuationCoverageNote(deriveValuationCoverage([{ symbol: "BTC", instrumentId: "b", balanceFromISO: "2015-01-01" }], new Map([["b", "2015-01-01"]])), "2015-01-01") === null);
  }

  // ── 16. Historical token prices (THE one token price path, #120's) ────────
  {
    // The adapter: each verified token asks for its OWN licence on this account; nothing else is asked.
    const asked: Array<{ instrumentId: string; assetKey: string; fromISO: string; toISO: string }> = [];
    const adapterClient = {
      instrumentAlias: { findMany: async () => [
        { instrumentId: "i1", externalId: `eip155:1/erc20:${USDC}` },
        { instrumentId: "i2", externalId: `eip155:1/erc20:${DAI}` },
        { instrumentId: "i3", externalId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      ] },
      positionCoverage: { findMany: async () => [
        { instrumentId: "i1", coveredFromDate: new Date("2024-03-05T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z") },
        { instrumentId: "i3", coveredFromDate: new Date("2024-03-05T00:00:00Z"), coveredToDate: new Date("2026-10-27T00:00:00Z") },
      ] },
      positionObservation: { groupBy: async ({ where }: { where: { quantity?: unknown } }) => (JSON.stringify(where.quantity) === JSON.stringify({ gt: 0 })
        ? ["i1", "i2", "i3"].map((id) => ({ financialAccountId: "acc", instrumentId: id, _min: { date: new Date("2024-03-05T00:00:00Z") }, _max: { date: new Date("2026-10-27T00:00:00Z") } })) : []) },
    };
    const run = await acquireErc20HistoricalPrices({ client: adapterClient as never, accountId: "acc", instrumentIds: ["i1", "i2", "i3"], maxTokens: 5,
      probe: async () => 0, probeGate: { allowance: async () => 0, record: async () => {} },
      acquire: async (a) => { asked.push({ instrumentId: a.instrumentId, assetKey: a.assetKey, fromISO: a.fromISO, toISO: a.toISO }); return { status: "INSERTED", inserted: 4, earliestISO: "2025-10-29", calls: 1 }; } });
    check("prices: only the licensed ERC-20 token is asked, for its own licence",
      asked.length === 1 && asked[0].instrumentId === "i1" && asked[0].fromISO === "2024-03-05" && asked[0].toISO === "2026-10-27", JSON.stringify(asked));
    check("prices: the run reports what the shared path did", run.tokensFetched === 1 && run.inserted === 4 && run.earliestInsertedISO === "2025-10-29");

    // Through the shared path itself, with an ERC-20 key: TOKEN share, token-history metric prefix, one source.
    const kinds: string[] = [];
    const meters: Array<Record<string, number>> = [];
    const created: Array<{ source: string; date: Date }> = [];
    let url = "";
    const sharedClient = {
      instrumentAlias: {
        findUnique: async () => ({ metadata: { quote: { attemptedAt: "2026-10-28T00:00:00Z", outcome: "PRICED", pricedAt: "2026-10-28T00:00:00Z" } } }),
        update: async () => ({}),
      },
      priceObservation: { createMany: async ({ data }: { data: Array<{ source: string; date: Date }> }) => { created.push(...data); return { count: data.length }; } },
    };
    const budget = { remaining: async (k?: "native" | "token") => { kinds.push(k ?? "native"); return 10; }, record: async (m: Readonly<Record<string, number>>) => { meters.push({ ...m }); }, pace: async () => {} };
    const r = await acquireTokenHistoricalCloses({
      client: sharedClient as never, instrumentId: "i1", assetKey: `eip155:1/erc20:${USDC}`, fromISO: "2026-10-20", toISO: "2026-10-27",
      budget, now: new Date("2026-10-28T12:00:00Z"), historyDays: 365,
      fetchCloses: (platform, contract, from, to, opts) => fetchCoinGeckoTokenDailyClosesUsd(platform, contract, from, to, { ...opts, apiKey: "k",
        fetchImpl: async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ prices: [[Date.parse("2026-10-21T12:00:00Z"), 1.0], [Date.parse("2026-10-22T12:00:00Z"), 0.999]] }) }; } }),
    });
    check("prices (ERC-20): spends the CoinGecko TOKEN share, never the total", kinds.length === 1 && kinds[0] === "token", kinds.join());
    const metric = Object.keys(meters[0] ?? {})[0] ?? "";
    check("prices (ERC-20): metered under the token-history prefix", `${COINGECKO_USAGE_NETWORK}:${metric}`.startsWith(TOKEN_HISTORY_METRIC_PREFIX) && metric.endsWith(":ethereum"), metric);
    const usage = await coinGeckoUsageToday({ apiUsageCounter: { findMany: async () => [{ metric: `${COINGECKO_USAGE_NETWORK}:${metric}`, count: 7 }, { metric: "coingecko:simple/price", count: 3 }] } } as never, "2026-10-28");
    check("prices (ERC-20): the ledger counts that metric in the TOKEN share", usage?.tokens === 7 && usage.total === 10, JSON.stringify(usage));
    check("prices (ERC-20): contract-addressed endpoint, EVM address lowercase", url.includes(`/coins/ethereum/contract/${USDC}/market_chart/range`), url);
    check("prices (ERC-20): one source constant (#120's)", created.length === 2 && created.every((c) => c.source === TOKEN_HISTORY_PRICE_SOURCE) && r.status === "INSERTED");
    let mixed = "";
    await fetchCoinGeckoTokenDailyClosesUsd("ethereum", "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606eB48", "2026-01-01", "2026-01-02", {
      apiKey: "k", fetchImpl: async (u) => { mixed = u; return { ok: true, status: 200, json: async () => ({ prices: [] }) }; } });
    let mint = "";
    await fetchCoinGeckoTokenDailyClosesUsd("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "2026-01-01", "2026-01-02", {
      apiKey: "k", fetchImpl: async (u) => { mint = u; return { ok: true, status: 200, json: async () => ({ prices: [] }) }; } });
    check("prices: lowercasing applies to EVM contracts ONLY — a Solana mint is sent exactly", mixed.includes(`/contract/${USDC}/`) && mint.includes("/contract/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/"), `${mixed} ${mint}`);
    check("seam constant says wired", /fetchCoinGeckoTokenDailyClosesUsd/.test(TOKEN_HISTORICAL_PRICE_SEAM));
    check("one price module: no second acquisition path in the ERC-20 code",
      !/market_chart|createMany\(\{\s*data: rows\.map\(\(r\) => \(\{ instrumentId, date/.test(read("lib", "crypto", "erc20-history-prices.ts")) && !/token-market-chart/.test(read("lib", "prices", "token-history-prices.ts")));
  }

  // ── 17. Boundaries (source pins) ─────────────────────────────────────────
  {
    const job = read("jobs", "sol-history-backfill.ts");
    check("job: one isolated call into the pass", (job.match(/runErc20HistoryPass\(/g) ?? []).length === 1);
    const src = read("lib", "crypto", "erc20-history.ts") + read("lib", "crypto", "erc20-history.store.ts") + read("lib", "crypto", "erc20-history-pass.ts");
    check("no global db import in the new runtime", !/from "@\/lib\/db"/.test(src));
    check("never reads the float `value`", !/\.value\b(?!\s*[:=])/.test(read("lib", "crypto", "erc20-history.core.ts").replace(/rc\.value|rawContract.*value/g, "")));
    const tv = read("lib", "crypto", "token-valuation.ts");
    check("day rule reads reconstructed rows only inside their licence, observed first", /licensedInterval\(cov\)/.test(tv) && /observedDay/.test(tv));
    const vc = read("lib", "connections", "valuation-coverage.ts");
    check("valuation note: token licences are not native limits", /instrument: NOT_TOKEN_INSTRUMENT/.test(vc));
    check("price gaps: token licences excluded", /AssetClass\.CRYPTO, \.\.\.NOT_TOKEN_INSTRUMENT/.test(read("lib", "prices", "price-gap.ts")));
  }

  console.log(`\nerc20-history: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
