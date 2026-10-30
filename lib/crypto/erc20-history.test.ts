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
  erc20HistoryConfig, ERC20_HISTORY_SOURCE, REASON_CAVEAT, emptySection,
  type Erc20HistorySection, type Erc20ContractHistory,
} from "./erc20-history.core";
import { runErc20HistoryStep, type Erc20HistoryStore, type Erc20TokenWrite, type KnownToken } from "./erc20-history";
import { planErc20History, runErc20HistoryPass, type Erc20HistoryPassDeps } from "./erc20-history-pass";
import { queuedCheckpoint, serializeCheckpoint, parseCheckpoint } from "./eth-history-backfill.core";
import { walletHistoryComplete, facetFromCoverage, TOKEN_HISTORY_CHAINS } from "./wallet-instrument-history";
import { tokensValueOnDay, tokenValueOnDay } from "./token-valuation.core";
import type { ChainCoverage } from "./chain-movement";
import { tokenHistoryText } from "@/lib/connections/connection-detail.core";
import { deriveValuationCoverage, valuationCoverageNote } from "@/lib/connections/valuation-coverage.core";
import { acquireTokenHistoricalCloses, TOKEN_HISTORY_PRICE_SOURCE } from "@/lib/prices/token-history-prices";
import { fetchCoinGeckoTokenDailyClosesUsd, TOKEN_HISTORICAL_PRICE_SEAM } from "@/lib/prices/providers/coingecko";
import { coinGeckoUsageToday, TOKEN_HISTORY_METRIC_PREFIX, COINGECKO_USAGE_NETWORK } from "@/lib/prices/coingecko-budget";
import { acquireErc20HistoricalPrices } from "./erc20-history-prices";

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
      let page = all.slice(off, off + size).map(transferJson);
      if (c.messy && page.length > 0) page = [...page].reverse().concat([page[0]]);
      return { jsonrpc: "2.0", id: call.id, result: { transfers: page, ...(off + size < all.length ? { pageKey: String(off + size) } : {}) } };
    }
    if (call.method === "eth_call") {
      const [{ to }, tag] = call.params as [{ to: string; data: string }, string];
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

async function step(chain: Chain, m: Mem, opts: { budget?: number; today?: string; cfg?: Partial<typeof CFG>; meter?: Record<string, number> } = {}) {
  const meter = opts.meter ?? {};
  return runErc20HistoryStep({ accountId: ACC, store: memStore(m), todayISO: opts.today ?? "2026-10-28" },
    { config: { ...CFG, ...opts.cfg }, requestBudget: opts.budget ?? 500, eth: { transport: transport(chain), meter, throttleRetries: 0, sleepImpl: async () => {} } });
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
    check("revert ⇒ BALANCE_CALL_FAILED", reasons[BAD] === "BALANCE_CALL_FAILED");
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
    const cfg = { ...erc20HistoryConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true" }) };
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
    let threw = false;
    try { parseAssetTransfers({ transfers: [{ blockNum: "0x1", uniqueId: "x", from: OTHER, to: WALLET, rawContract: { address: USDC, value: null } }] }); } catch { threw = true; }
    check("an unreadable transfer refuses the page (never skipped)", threw);
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
    check("chart note: verified token history valued from its first price", /Verified token history is valued from/.test(valuationCoverageNote(cov, "2024-01-01") ?? ""));
    check("chart note: silent when the chart starts after", valuationCoverageNote(cov, "2026-01-01") === null);
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
    };
    const run = await acquireErc20HistoricalPrices({ client: adapterClient as never, accountId: "acc", instrumentIds: ["i1", "i2", "i3"], maxTokens: 5,
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
