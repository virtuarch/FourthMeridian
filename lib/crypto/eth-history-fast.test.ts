/**
 * lib/crypto/eth-history-fast.test.ts
 *
 * The ETH history FAST PATH (2026-10-31): indexed transfer candidates, proven
 * by the walk's own predicate, with the walk as the per-interval fallback.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/eth-history-fast.test.ts
 *
 * Offline. A SIMULATED CHAIN serves state, headers and receipts; a simulated
 * `alchemy_getAssetTransfers` (lib/test-support/eth-asset-transfers-sim.ts)
 * serves an index with the vendor's real blind spots — withdrawals, reverted
 * transactions, and anything marked `indexed: false` are NOT listed, and every
 * listed `value` is deliberately wrong. The reference for every comparison is
 * the SAME acquisition with the fast path off (the walk).
 *
 * Pinned:
 *   - a typical wallet completes in an exact, small number of calls, with a
 *     result identical to the walk;
 *   - a credit the index misses (withdrawal, SELFDESTRUCT) fails its gap's
 *     predicate, the walk bisects THAT interval only, and the result is exact;
 *   - multi-page indexes, a deadline mid-paging (resume from the proven
 *     boundary, directly and through the worker's CAS'd steps);
 *   - the flag off is the walk, call for call;
 *   - a receive-only wallet (no key proof) completes with gaps never longer
 *     than a walk chunk;
 *   - reverted transactions' fees are counted, listed or not;
 *   - phantom listings, an unavailable index, a throttled index, a contract
 *     account, and the shared-cap arithmetic (≤ 4 calls per budget unit);
 *   - LIVENESS: a fresh, very active signed wallet under a tight deadline
 *     advances every step (the key proof stops at the first signed receipt);
 *   - the CANCELLING PAIR (an unlisted send + an unlisted receive netting 0
 *     inside one long index-empty gap) is caught by the nonce;
 *   - index pages are charged at their compute cost and capped per run;
 *   - internal-call credits are asked for (category "internal").
 */

import {
  acquireEthHistory, ethFastPathEnabled, fastProbePoints, parseAssetTransfersPage, EARLIEST_PROVABLE_BLOCK,
  WEI_PER_GWEI, ASSET_TRANSFERS_METHOD, DEFAULT_CHUNK_BLOCKS, INDEX_PAGE_UNITS, INDEX_PAGE_BUDGET_SHARE, FAST_UNITS_PER_PROBE,
  type EthAccountState, type EthHistoryAcquisition, type EthHistoryCursor, type EthHistoryDeps, type EthRpcTransport,
} from "./eth-history";
import { reconcileMovementsAgainstBalance, type ChainCoverage, type ChainMovement } from "./chain-movement";
import { queuedCheckpoint, serializeCheckpoint, parseCheckpoint, type EthBackfillCheckpoint } from "./eth-history-backfill.core";
import { runEthHistoryBackfill, EthCheckpointConflictError, type EthBackfillStore } from "./eth-history-backfill";
import type { EthHistoryResult } from "./eth-history-sync";
import { serveAssetTransfers, type IndexedSimEvent, type AssetTransfersSimOpts } from "@/lib/test-support/eth-asset-transfers-sim";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}`); if (detail) console.log(`        ${detail}`); }
}
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const ETH = (n: number) => BigInt(Math.round(n * 1e9)) * BigInt(1e9);
const GAS = (gwei: number) => BigInt(21000) * BigInt(gwei) * WEI_PER_GWEI;
const OWNER = "0x000000000000000000000000000000000000abcd";
const OTHER = "0x0000000000000000000000000000000000001234";
const HEAD = 26_000_000;
const T_HEAD = Date.UTC(2026, 9, 27, 12, 0, 0) / 1000;

// ── A simulated chain + index ────────────────────────────────────────────────
interface SimOpts {
  events: IndexedSimEvent[];
  head?: number;
  codeAt?: (block: number) => string;
  index?: Omit<AssetTransfersSimOpts, "owner">;
  /** "missing": the method is refused (−32601); "throttle": always 429. */
  indexFault?: "missing" | "throttle";
  /** Called once per HTTP request (a clock can advance here). */
  onRequest?: () => void;
}
function simulate(opts: SimOpts) {
  const head = opts.head ?? HEAD;
  const events = [...opts.events].sort((a, b) => a.block - b.block);
  const stats = { requests: 0, calls: 0, probesAt: new Set<number>() };
  const stateAt = (block: number): EthAccountState => {
    let balance = BigInt(0); let nonce = BigInt(0);
    for (const e of events) { if (e.block > block) break; balance += e.delta; if (e.originated) nonce += BigInt(1); }
    return { balance, nonce, code: opts.codeAt ? opts.codeAt(block) : "0x" };
  };
  const tsOf = (b: number) => BigInt(T_HEAD + (b - head) * 12);
  interface Row { id: number; method: string; params: unknown[] }
  const transport: EthRpcTransport = async (body) => {
    stats.requests++;
    opts.onRequest?.();
    const rows: Row[] = Array.isArray(body) ? body as Row[] : [body as Row];
    const out = rows.map((r) => {
      stats.calls++;
      if (r.method === ASSET_TRANSFERS_METHOD) {
        if (opts.indexFault === "missing") return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "method not found" } };
        if (opts.indexFault === "throttle") return { jsonrpc: "2.0", id: r.id, error: { code: 429, message: "capacity" } };
        return serveAssetTransfers(r, events, { owner: OWNER, ...(opts.index ?? {}) });
      }
      const isState = r.method === "eth_getBalance" || r.method === "eth_getTransactionCount" || r.method === "eth_getCode";
      const b = isState ? Number(BigInt(r.params[1] as string))
        : r.params[0] === "finalized" ? head : Number(BigInt(r.params[0] as string));
      if (r.method === "eth_getBalance") { stats.probesAt.add(b); return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(b).balance) }; }
      if (r.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(b).nonce) };
      if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: stateAt(b).code };
      const ev = events.find((e) => e.block === b);
      if (r.method === "eth_getBlockByNumber") {
        return { jsonrpc: "2.0", id: r.id, result: { number: hex(b), hash: `0xblock${b}`, timestamp: hex(tsOf(b)),
          withdrawals: ev?.withdrawalWei ? [{ address: OWNER, amount: hex(ev.withdrawalWei / WEI_PER_GWEI) }] : [] } };
      }
      if (r.method === "eth_getBlockReceipts") {
        return { jsonrpc: "2.0", id: r.id, result: ev?.originated
          ? [{ from: OWNER, to: OTHER, status: ev.reverted ? "0x0" : "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex((ev.feeWei ?? BigInt(0)) / BigInt(21000)) }]
          : [] };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    });
    return JSON.stringify(Array.isArray(body) ? out : out[0]);
  };
  return { transport, stats, stateAt };
}

/** Everything a consumer reads off an acquisition, except its cost. */
function result(a: EthHistoryAcquisition): string {
  return JSON.stringify({
    movements: a.movements, coverage: a.coverage, changeBlocks: a.changeBlocks,
    cursor: { p: a.cursor.provenFromBlock, a: a.cursor.anchorBlock, r: a.cursor.reachedWindowStart, s: a.cursor.stoppedBecause ?? null },
    anchor: a.anchorBalanceWei, opening: a.openingBalanceWei,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
const total = (m: Record<string, number>) => Object.values(m).reduce((x, y) => x + y, 0);

async function acquire(opts: SimOpts, deps: EthHistoryDeps = {}, args: { fromBlock?: number; toBlock?: number; cursor?: EthHistoryCursor; ownerSigned?: boolean } = {}) {
  const sim = simulate(opts);
  const meter: Record<string, number> = {};
  const acq = await acquireEthHistory({
    ownerAddress: OWNER, fromBlock: args.fromBlock ?? EARLIEST_PROVABLE_BLOCK, toBlock: args.toBlock ?? opts.head ?? HEAD,
    cursor: args.cursor, ownerSigned: args.ownerSigned,
  }, { transport: sim.transport, meter, ...deps });
  return { acq, meter, sim, calls: total(meter) };
}
async function both(opts: SimOpts, deps: EthHistoryDeps = {}) {
  return { fast: await acquire(opts, { ...deps, fastPath: true }), walk: await acquire(opts, { ...deps, fastPath: false }) };
}
/** The largest distance between consecutive probed blocks inside [lo, hi]. */
function maxProbeGap(probes: Set<number>, lo: number, hi: number): number {
  const p = [...probes].filter((b) => b >= lo && b <= hi).sort((x, y) => x - y);
  let g = 0;
  for (let i = 1; i < p.length; i++) g = Math.max(g, p[i] - p[i - 1]);
  return g;
}

// ── Wallets ──────────────────────────────────────────────────────────────────
const TYPICAL: IndexedSimEvent[] = [
  { block: 21_000_000, delta: ETH(3) },
  { block: 21_500_000, delta: -ETH(1) - GAS(20), originated: true, feeWei: GAS(20) },
  { block: 23_000_000, delta: ETH(0.5) },
  { block: 24_000_000, delta: -ETH(0.2) - GAS(15), originated: true, feeWei: GAS(15) },
  { block: 25_500_000, delta: ETH(0.1) },
];
const SENDS = 2;

/** The in-memory history link (as eth-history-backfill.test.ts). */
class MemoryStore implements EthBackfillStore {
  walletAddress = OWNER;
  cursor: string | null;
  writes: Array<{ movements: ChainMovement[]; coverage: ChainCoverage; anchorBalanceWei: bigint }> = [];
  constructor(cursor: string | null) { this.cursor = cursor; }
  async readCursor() { return this.cursor; }
  async casCursor(expected: string | null, next: string) { if (this.cursor !== expected) return false; this.cursor = next; return true; }
  async complete(c: Parameters<EthBackfillStore["complete"]>[0]): Promise<EthHistoryResult> {
    const recon = reconcileMovementsAgainstBalance(c.movements, c.anchorBalanceWei);
    if (!recon.reconciles) return { accountId: "a1", ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE", reason: recon.reason };
    if (this.cursor !== c.expectedCursor) throw new EthCheckpointConflictError();
    this.cursor = c.nextCursor;
    this.writes.push({ movements: c.movements, coverage: c.coverage, anchorBalanceWei: c.anchorBalanceWei });
    return { accountId: "a1", ok: true, mode: "FULL", derivedRowsWritten: 1, impactedFromISO: null };
  }
  cp(): EthBackfillCheckpoint | null { return parseCheckpoint(this.cursor, "a1"); }
}
const NOW_ISO = "2026-10-28T10:00:00.000Z";
const TODAY = "2026-10-28";
const movesKey = (ms: readonly ChainMovement[]) => JSON.stringify(
  [...ms].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.movementKey.localeCompare(b.movementKey))
    .map((m) => [m.sequence, m.movementKey, m.role, m.baseUnitsDelta.toString(), m.dateISO]));

async function main() {
  // ══ 0. PURE PIECES ═════════════════════════════════════════════════════════
  console.log("\n0. Pure pieces");
  check("ETH_HISTORY_FAST_PATH defaults ON; 0/false/off/no turn it off",
    ethFastPathEnabled({}) && ethFastPathEnabled({ ETH_HISTORY_FAST_PATH: "true" }) && ethFastPathEnabled({ ETH_HISTORY_FAST_PATH: "1" })
      && !ethFastPathEnabled({ ETH_HISTORY_FAST_PATH: "0" }) && !ethFastPathEnabled({ ETH_HISTORY_FAST_PATH: "false" })
      && !ethFastPathEnabled({ ETH_HISTORY_FAST_PATH: " OFF " }) && !ethFastPathEnabled({ ETH_HISTORY_FAST_PATH: "no" }));
  check("probe points: both ends, every c and c−1 inside (segLo, top], descending",
    JSON.stringify(fastProbePoints({ top: 100, segLo: 10, candidates: [50, 11, 100, 5, 200], maxGap: null })) === JSON.stringify([100, 99, 50, 49, 11, 10]));
  check("probe points without a key proof: no gap wider than maxGap",
    JSON.stringify(fastProbePoints({ top: 100, segLo: 0, candidates: [60], maxGap: 25 })) === JSON.stringify([100, 75, 60, 59, 34, 9, 0]));
  let refused = false;
  try { parseAssetTransfersPage({ transfers: [{ blockNum: 7 }] }); } catch { refused = true; }
  check("an index page with a non-hex blockNum is refused (⇒ the walk), never coerced", refused);
  check("an index page yields block numbers and the page key — nothing else",
    JSON.stringify(parseAssetTransfersPage({ transfers: [{ blockNum: "0x10", value: 9 }], pageKey: "k" })) === JSON.stringify({ blocks: [16], pageKey: "k" }));

  // ══ 1. A TYPICAL WALLET ════════════════════════════════════════════════════
  console.log("\n1. A typical wallet (5 changes, 2 own transactions), fresh from Byzantium");
  {
    const { fast, walk } = await both({ events: TYPICAL });
    const K = TYPICAL.length;
    // pages (2) + receipts for the 2 sent-from blocks (K proof) + 3·(2K+2) state
    // + receipts for the other K−2 change blocks + 2 coverage headers.
    const expected = 2 + 2 * SENDS + 3 * (2 * K + 2) + 2 * (K - SENDS) + 2;
    check("identical result to the walk (movements, coverage, cursor, balances)", result(fast.acq) === result(walk.acq),
      `${result(fast.acq)}\n        vs ${result(walk.acq)}`);
    check("COMPLETE from the provable floor", fast.acq.coverage.kind === "COMPLETE" && fast.acq.cursor.reachedWindowStart);
    check(`exactly ${expected} JSON-RPC calls`, fast.calls === expected, `got ${fast.calls}`);
    // anchor probe · index pages · K receipts · 2 probe groups · evidence · coverage headers
    check("…in exactly 7 HTTP requests", fast.sim.stats.requests === 7, `got ${fast.sim.stats.requests}`);
    check("…vs the walk's (≥ 10× fewer)", fast.calls * 10 <= walk.calls, `fast ${fast.calls}, walk ${walk.calls}`);
    check("the index is metered under its own method name", fast.meter[ASSET_TRANSFERS_METHOD] === 2, JSON.stringify(fast.meter));
    check("no interval fell back (the index listed every change)", fast.acq.fastPath?.fallbackIntervals === 0 && fast.acq.fastPath?.used === true);
    check("FEE legs from the receipts, exact", fast.acq.movements.filter((m) => m.role === "FEE").map((m) => m.baseUnitsDelta).join() === [-GAS(20), -GAS(15)].join());
    console.log(`     calls: fast ${fast.calls} (${fast.sim.stats.requests} requests) vs walk ${walk.calls} (${walk.sim.stats.requests} requests)`);
  }

  // ══ 2. A CREDIT THE INDEX MISSES ═══════════════════════════════════════════
  console.log("\n2. Credits the index cannot list: a validator withdrawal and a SELFDESTRUCT payout");
  {
    const events: IndexedSimEvent[] = [
      ...TYPICAL,
      { block: 22_000_000, delta: ETH(0.7), indexed: false },                                // SELFDESTRUCT payout, missed
      { block: 24_500_000, delta: ETH(0.032), withdrawalWei: ETH(0.032) },                  // withdrawal: never listed
    ];
    const { fast, walk } = await both({ events });
    check("identical result to the walk", result(fast.acq) === result(walk.acq), `${result(fast.acq)}\n        vs ${result(walk.acq)}`);
    check("both missed blocks are found", fast.acq.changeBlocks.includes(22_000_000) && fast.acq.changeBlocks.includes(24_500_000));
    check("the withdrawal is a REWARD from the block header", fast.acq.movements.some((m) => m.sequence === 24_500_000 && m.role === "REWARD" && m.baseUnitsDelta === ETH(0.032)));
    check("exactly the two gaps that held them fell back to bisection", fast.acq.fastPath?.fallbackIntervals === 2, JSON.stringify(fast.acq.fastPath));
    check("…and the run is still far cheaper than the walk", fast.calls * 3 <= walk.calls, `fast ${fast.calls}, walk ${walk.calls}`);
  }

  // ══ 3. MULTI-PAGE ══════════════════════════════════════════════════════════
  console.log("\n3. A multi-page index (page size 3, 20 changes)");
  const MANY: IndexedSimEvent[] = Array.from({ length: 20 }, (_, i) => i % 2 === 0
    ? { block: 20_000_000 + i * 250_000, delta: ETH(1) }
    : { block: 20_000_000 + i * 250_000, delta: -ETH(0.1) - GAS(10 + i), originated: true, feeWei: GAS(10 + i) });
  {
    const { fast, walk } = await both({ events: MANY, index: { pageSize: 3 } });
    check("identical result to the walk", result(fast.acq) === result(walk.acq));
    check("every page was read (10 per stream ⇒ 4 + 4 pages)", fast.acq.fastPath?.pages === 8, JSON.stringify(fast.acq.fastPath));
    check("no interval fell back: page boundaries lose no candidate", fast.acq.fastPath?.fallbackIntervals === 0);
    check("all 20 changes found", fast.acq.changeBlocks.length === 20);
  }

  // ══ 4. DEADLINE MID-PAGING / MID-SEGMENT ═══════════════════════════════════
  console.log("\n4. A deadline mid-paging resumes at the proven boundary");
  {
    const walk = await acquire({ events: MANY }, { fastPath: false });
    let t = 0;
    const sim = simulate({ events: MANY, index: { pageSize: 2 }, onRequest: () => { t += 1_000; } });
    let cursor: EthHistoryCursor | undefined;
    const got: ChainMovement[] = [];
    let runs = 0, partial = 0, last: EthHistoryAcquisition | null = null;
    const bounds: number[] = [];
    for (; runs < 200; runs++) {
      const acq = await acquireEthHistory({
        ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD, cursor,
        ownerSigned: got.some((m) => m.role === "FEE"),
      }, { transport: sim.transport, fastPath: true, now: () => t, deadlineMs: t + 5_000 });
      last = acq;
      if (acq.coverage.kind !== "COMPLETE") continue; // nothing proven this run: the cursor is unchanged
      got.push(...acq.movements);
      bounds.push(acq.cursor.provenFromBlock!);
      cursor = acq.cursor;
      if (acq.cursor.reachedWindowStart) break;
      partial++;
    }
    check("several deadline-bounded runs, each stopped part-way", partial >= 3, `runs ${runs}, partial ${partial}`);
    check("the proven boundary only ever moves down", bounds.every((b, i) => i === 0 || b < bounds[i - 1]), bounds.join(","));
    check("the union of the runs' movements is exactly the walk's — nothing lost, nothing twice", movesKey(got) === movesKey(walk.acq.movements));
    check("the final run reaches the floor with the walk's opening and anchor",
      !!last && last.cursor.reachedWindowStart && last.openingBalanceWei === walk.acq.openingBalanceWei && last.anchorBalanceWei === walk.acq.anchorBalanceWei);
  }
  {
    // A deadline that has already passed: no index call, nothing proven, the cursor untouched.
    const r = await acquire({ events: TYPICAL }, { fastPath: true, now: () => 10, deadlineMs: 5 });
    check("deadline already passed ⇒ nothing licensed (PAGE_BUDGET_EXHAUSTED), no call at all",
      r.acq.coverage.kind !== "COMPLETE" && r.acq.coverage.caveats.includes("PAGE_BUDGET_EXHAUSTED") && r.calls === 0);
  }
  {
    // Through the WORKER: CAS'd steps under a moving clock, then COMPLETE once.
    // Six requests per step: head, anchor, index page, K receipts, a probe group
    // (+1) — the least that proves something (live: ~8 requests/s, 60 s steps).
    let t = Date.parse(NOW_ISO);
    const sim = simulate({ events: MANY, index: { pageSize: 2 }, onRequest: () => { t += 1_000; } });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const outcomes: string[] = [];
    for (let i = 0; i < 100; i++) {
      const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY },
        { probeBudget: 1_500, now: () => t, deadlineMs: t + 6_000, eth: { transport: sim.transport, fastPath: true } });
      outcomes.push(o.failure ? `${o.stoppedBecause}:${o.failure.code}` : o.stoppedBecause);
      if (o.stoppedBecause !== "PROBE_BUDGET") break;
    }
    const walk = await acquire({ events: MANY }, { fastPath: false });
    check("the worker's deadline-bounded steps reach COMPLETE with no failure", outcomes[outcomes.length - 1] === "COMPLETE" && !outcomes.some((o) => o.includes(":")), outcomes.join(" "));
    check("…written once, with exactly the walk's movements", store.writes.length === 1 && movesKey(store.writes[0].movements) === movesKey(walk.acq.movements));
    check("…over several steps (the checkpoint carried the proven boundary)", outcomes.length >= 3, outcomes.join(" "));
  }
  {
    // A budget too small for the segment: proven intervals kept, the in-flight one discarded.
    const events: IndexedSimEvent[] = [...TYPICAL, { block: 24_500_000, delta: ETH(0.032), withdrawalWei: ETH(0.032) }];
    const walk = await acquire({ events }, { fastPath: false });
    const r = await acquire({ events }, { fastPath: true, probeBudget: 30 });
    const p = r.acq.cursor.provenFromBlock!;
    const walkAbove = walk.acq.movements.filter((m) => (m.sequence ?? 0) > p);
    check("budget stop mid-segment: COMPLETE over [provenFrom, head], PROBE_BUDGET",
      r.acq.coverage.kind === "COMPLETE" && r.acq.cursor.stoppedBecause === "PROBE_BUDGET" && p > EARLIEST_PROVABLE_BLOCK && p < HEAD, JSON.stringify(r.acq.cursor));
    check("…its movements are exactly the walk's above that boundary (no partial interval)", movesKey(r.acq.movements) === movesKey(walkAbove));
    check("…and its opening is the true balance at the boundary", r.acq.openingBalanceWei === r.sim.stateAt(p).balance);
  }

  // ══ 5. FLAG OFF ════════════════════════════════════════════════════════════
  console.log("\n5. ETH_HISTORY_FAST_PATH=off reproduces the walk");
  {
    const prev = process.env.ETH_HISTORY_FAST_PATH;
    process.env.ETH_HISTORY_FAST_PATH = "off";
    const off = await acquire({ events: TYPICAL });
    process.env.ETH_HISTORY_FAST_PATH = prev;
    if (prev === undefined) delete process.env.ETH_HISTORY_FAST_PATH;
    const walk = await acquire({ events: TYPICAL }, { fastPath: false });
    const on = await acquire({ events: TYPICAL });
    check("flag off: no index call at all", !off.meter[ASSET_TRANSFERS_METHOD]);
    check("flag off: the same result, the same calls by method, the same requests as the walk",
      result(off.acq) === result(walk.acq) && JSON.stringify(off.meter) === JSON.stringify(walk.meter) && off.sim.stats.requests === walk.sim.stats.requests,
      `${JSON.stringify(off.meter)} vs ${JSON.stringify(walk.meter)}`);
    check("flag off: no fast-path diagnostics, and probesUsed is the walk's", off.acq.fastPath === undefined && off.acq.probesUsed === walk.acq.probesUsed);
    check("flag unset: the fast path runs (default ON)", on.acq.fastPath?.used === true && (on.meter[ASSET_TRANSFERS_METHOD] ?? 0) > 0);
  }

  // ══ 6. RECEIVE-ONLY ════════════════════════════════════════════════════════
  console.log("\n6. A receive-only wallet (no own transaction ⇒ no key proof, no FEE)");
  {
    const events: IndexedSimEvent[] = [
      { block: 21_000_000, delta: ETH(2) }, { block: 23_000_000, delta: ETH(0.5) }, { block: 25_000_000, delta: ETH(0.25) },
    ];
    const { fast, walk } = await both({ events });
    check("COMPLETE, identical to the walk", fast.acq.coverage.kind === "COMPLETE" && result(fast.acq) === result(walk.acq));
    check("no FEE movement", !fast.acq.movements.some((m) => m.role === "FEE"));
    check("no gap longer than a walk chunk was closed in one step (no K)", maxProbeGap(fast.sim.stats.probesAt, EARLIEST_PROVABLE_BLOCK, HEAD) <= DEFAULT_CHUNK_BLOCKS,
      `max gap ${maxProbeGap(fast.sim.stats.probesAt, EARLIEST_PROVABLE_BLOCK, HEAD)}`);
    check("…and still cheaper than the walk (no per-change bisection)", fast.calls < walk.calls, `fast ${fast.calls}, walk ${walk.calls}`);
    console.log(`     calls: fast ${fast.calls} vs walk ${walk.calls}`);
  }
  {
    // A listing in the FROM stream whose receipts do not show the owner signing
    // is not a key proof: the gaps stay chunk-bounded.
    const events: IndexedSimEvent[] = [{ block: 21_000_000, delta: ETH(2) }, { block: 25_000_000, delta: ETH(0.25) }];
    const r = await acquire({ events, index: { phantom: [{ block: 24_000_000, dir: "from" }] } }, { fastPath: true });
    check("an index 'from' listing without the owner's receipt is NOT a key proof",
      r.acq.coverage.kind === "COMPLETE" && maxProbeGap(r.sim.stats.probesAt, EARLIEST_PROVABLE_BLOCK, HEAD) <= DEFAULT_CHUNK_BLOCKS);
  }
  {
    // A signed wallet: the long gaps close in one step each.
    const r = await acquire({ events: TYPICAL }, { fastPath: true });
    check("a signed wallet (K) closes long gaps in one step", maxProbeGap(r.sim.stats.probesAt, EARLIEST_PROVABLE_BLOCK, HEAD) > DEFAULT_CHUNK_BLOCKS);
  }

  // ══ 7. REVERTED TRANSACTIONS ═══════════════════════════════════════════════
  console.log("\n7. Fees of reverted transactions are counted");
  {
    const events: IndexedSimEvent[] = [
      ...TYPICAL,
      { block: 23_500_000, delta: -GAS(30), originated: true, feeWei: GAS(30), reverted: true },                 // not listed
      { block: 24_200_000, delta: -GAS(31), originated: true, feeWei: GAS(31), reverted: true, indexed: true },  // listed
    ];
    const { fast, walk } = await both({ events });
    check("identical result to the walk", result(fast.acq) === result(walk.acq));
    check("an UNLISTED reverted transaction's gas is a FEE movement", fast.acq.movements.some((m) => m.sequence === 23_500_000 && m.role === "FEE" && m.baseUnitsDelta === -GAS(30)));
    check("a LISTED reverted transaction's gas is a FEE movement", fast.acq.movements.some((m) => m.sequence === 24_200_000 && m.role === "FEE" && m.baseUnitsDelta === -GAS(31)));
    check("only the unlisted one cost a fallback (its nonce bump fails the gap)", fast.acq.fastPath?.fallbackIntervals === 1, JSON.stringify(fast.acq.fastPath));
  }

  // ══ 8. AN INDEX THAT LIES, OR IS NOT THERE ═════════════════════════════════
  console.log("\n8. Phantom listings, wrong values, an unavailable or throttled index");
  {
    const phantom = [{ block: 22_222_222, dir: "to" as const }, { block: 24_444_444, dir: "from" as const }];
    const { fast, walk } = await both({ events: TYPICAL, index: { phantom } });
    check("phantom listings (blocks with no change) change nothing", result(fast.acq) === result(walk.acq)
      && !fast.acq.changeBlocks.includes(22_222_222) && !fast.acq.changeBlocks.includes(24_444_444));
  }
  {
    const { fast, walk } = await both({ events: TYPICAL, indexFault: "missing" });
    check("an endpoint without the index: the walk takes over, identical result", result(fast.acq) === result(walk.acq));
    check("…recorded as INDEX_UNAVAILABLE, the refused call still metered",
      /^INDEX_UNAVAILABLE/.test(fast.acq.fastPath?.disabledBecause ?? "") && fast.meter[ASSET_TRANSFERS_METHOD] === 2 && fast.acq.fastPath?.used === false);
  }
  {
    const r = await acquire({ events: TYPICAL, indexFault: "throttle" }, { fastPath: true, throttleRetries: 0, sleepImpl: async () => {} });
    check("a throttled index stops the run like a throttled probe (PROVIDER_THROTTLED, nothing licensed)",
      r.acq.coverage.kind === "UNKNOWN" && r.acq.coverage.caveats.includes("PROVIDER_THROTTLED"));
  }
  {
    const opts: SimOpts = { events: TYPICAL, codeAt: (b) => (b >= 22_000_000 ? "0x60" : "0x") };
    const { fast, walk } = await both(opts);
    check("a contract / delegated account: PROOF_PREMISES_UNMET, as the walk",
      fast.acq.coverage.kind === "UNKNOWN" && fast.acq.coverage.caveats.includes("PROOF_PREMISES_UNMET")
        && walk.acq.coverage.kind === "UNKNOWN" && walk.acq.coverage.caveats.includes("PROOF_PREMISES_UNMET"));
  }

  // ══ 9. INCREMENTAL / FORWARD WINDOWS ═══════════════════════════════════════
  console.log("\n9. Short windows (the incremental suffix and the worker's forward segment)");
  {
    const lo = 25_960_000; // a suffix within one chunk (a day is ~7,200 blocks)
    const f = await acquire({ events: TYPICAL }, { fastPath: true }, { fromBlock: lo });
    const w = await acquire({ events: TYPICAL }, { fastPath: false }, { fromBlock: lo });
    check("a quiet suffix: no index call, the walk's exact calls", result(f.acq) === result(w.acq) && !f.meter[ASSET_TRANSFERS_METHOD] && f.calls === w.calls,
      `${JSON.stringify(f.meter)} vs ${JSON.stringify(w.meter)}`);
    const busy = [...TYPICAL, { block: 25_970_000, delta: ETH(0.3) }, { block: 25_980_000, delta: -ETH(0.1) - GAS(9), originated: true, feeWei: GAS(9) }];
    const f2 = await acquire({ events: busy }, { fastPath: true }, { fromBlock: lo });
    const w2 = await acquire({ events: busy }, { fastPath: false }, { fromBlock: lo });
    check("a busy suffix: identical to the walk, fewer calls", result(f2.acq) === result(w2.acq) && f2.calls < w2.calls, `fast ${f2.calls}, walk ${w2.calls}`);
  }

  // ══ 10. THE SHARED CAP'S ARITHMETIC ════════════════════════════════════════
  console.log("\n10. ≤ 4 calls per budget unit (CALLS_PER_PROBE + EVIDENCE_CALLS_PER_PROBE)");
  {
    // The densest case: 30 changes in CONSECUTIVE blocks (each c−1 is the previous
    // c), on a SIGNED wallet (no gap subdivision to pad the budget): one evidence
    // read per probed block, which is why a probed block costs 2 units.
    const dense: IndexedSimEvent[] = Array.from({ length: 30 }, (_, i) => i === 0
      ? { block: 25_000_000, delta: -GAS(5), originated: true, feeWei: GAS(5) }
      : { block: 25_000_000 + i, delta: ETH(0.01) });
    dense.unshift({ block: 24_000_000, delta: ETH(1) });
    const cases: Array<[string, SimOpts]> = [["typical", { events: TYPICAL }], ["many", { events: MANY, index: { pageSize: 3 } }], ["dense", { events: dense }]];
    for (const [name, opts] of cases) {
      const r = await acquire(opts, { fastPath: true });
      check(`${name}: calls ≤ 4 × budget units + 16`, r.calls <= 4 * r.acq.probesUsed + 16, `calls ${r.calls}, units ${r.acq.probesUsed}`);
      // …and on the PROBE side alone (pages, charged at their compute cost, excluded): state + evidence calls ≤ 4 per probe unit.
      const pages = r.acq.fastPath?.pages ?? 0;
      check(`${name}: probe-side calls ≤ 4 × probe units + 16`, r.calls - pages <= 4 * (r.acq.probesUsed - INDEX_PAGE_UNITS * pages) + 16,
        `calls ${r.calls - pages}, probe units ${r.acq.probesUsed - INDEX_PAGE_UNITS * pages}`);
    }
    const { fast, walk } = await both({ events: dense });
    check("dense consecutive changes: identical to the walk", result(fast.acq) === result(walk.acq));
  }

  // ══ 11. LIVENESS: A FRESH, VERY ACTIVE SIGNED WALLET UNDER A TIGHT DEADLINE ═
  console.log("\n11. 300 own transactions, 20 requests per step: every step advances");
  {
    const busy: IndexedSimEvent[] = [{ block: 20_000_000, delta: ETH(10) }];
    for (let i = 0; i < 300; i++) {
      busy.push({ block: 20_000_001 + i * 1_000, delta: -ETH(0.01) - GAS(10 + (i % 7)), originated: true, feeWei: GAS(10 + (i % 7)) });
    }
    let t = Date.parse(NOW_ISO);
    const sim = simulate({ events: busy, onRequest: () => { t += 1_000; } });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const outcomes: string[] = [];
    const bounds: Array<number | null> = [];
    let firstStepRequests = 0;
    for (let i = 0; i < 60; i++) {
      const before = sim.stats.requests;
      const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY },
        { probeBudget: 1_500, now: () => t, deadlineMs: t + 20_000, eth: { transport: sim.transport, fastPath: true } });
      if (i === 0) firstStepRequests = sim.stats.requests - before;
      outcomes.push(o.failure ? `${o.stoppedBecause}:${o.failure.code}` : o.stoppedBecause);
      const c = store.cp();
      if (c && !c.reachedFloor) bounds.push(c.provenFromBlock);
      if (o.stoppedBecause !== "PROBE_BUDGET") break;
    }
    const walk = await acquire({ events: busy }, { fastPath: false, probeBudget: 200_000 });
    check("the FIRST step already proves a boundary (the key proof did not eat the deadline)", bounds.length > 0 && bounds[0] !== null,
      `bounds ${bounds.join(",")}; first step ${firstStepRequests} requests`);
    check("every backward step moves the proven boundary DOWN (monotone progress, no chunk halving)",
      bounds.every((b, i) => b !== null && (i === 0 || b < (bounds[i - 1] as number))) && !(store.cp()?.chunkBlocks !== undefined && store.cp()!.chunkBlocks < DEFAULT_CHUNK_BLOCKS),
      bounds.join(","));
    check("…and the wallet COMPLETEs, once, with exactly the walk's 301 changes",
      outcomes[outcomes.length - 1] === "COMPLETE" && store.writes.length === 1 && movesKey(store.writes[0].movements) === movesKey(walk.acq.movements)
        && walk.acq.changeBlocks.length === 301, `${outcomes.join(" ")}`);
    console.log(`     ${outcomes.length} steps, ${sim.stats.requests} requests (walk alone: ${walk.sim.stats.requests} requests)`);
  }

  // ══ 12. THE CANCELLING PAIR ════════════════════════════════════════════════
  console.log("\n12. An unlisted send + an unlisted receive netting 0 inside one long index-empty gap");
  {
    const events: IndexedSimEvent[] = [
      ...TYPICAL,
      // Both inside the 21.5M → 23.0M gap, which (signed wallet) closes in ONE step.
      { block: 22_100_000, delta: -ETH(1) - GAS(20), originated: true, feeWei: GAS(20), indexed: false },
      { block: 22_400_000, delta: ETH(1) + GAS(20), indexed: false },
    ];
    const r = await acquire({ events }, { fastPath: true });
    const walk = await acquire({ events }, { fastPath: false });
    check("the gap's endpoints agree in balance (the hazard is real)", r.sim.stateAt(21_500_000).balance === r.sim.stateAt(22_999_999).balance);
    check("the nonce catches it: both blocks found, the gap bisected",
      r.acq.changeBlocks.includes(22_100_000) && r.acq.changeBlocks.includes(22_400_000) && (r.acq.fastPath?.fallbackIntervals ?? 0) >= 1,
      JSON.stringify(r.acq.changeBlocks));
    check("…identical to the walk", result(r.acq) === result(walk.acq));
  }

  // ══ 13. PAGING AGAINST THE BUDGET ══════════════════════════════════════════
  console.log("\n13. Index pages are charged at their compute cost and capped per run");
  {
    const budget = 80;
    const r = await acquire({ events: MANY, index: { pageSize: 1 } }, { fastPath: true, probeBudget: budget });
    const fp = r.acq.fastPath!;
    const cap = Math.max(2, Math.floor((budget * INDEX_PAGE_BUDGET_SHARE) / INDEX_PAGE_UNITS));
    check(`each page costs ${INDEX_PAGE_UNITS} units, each probed block ${FAST_UNITS_PER_PROBE} (the whole budget accounted)`,
      // (the anchor probe precedes the fast path: 1 unit, as in the walk)
      r.acq.probesUsed === INDEX_PAGE_UNITS * fp.pages + FAST_UNITS_PER_PROBE * (fp.statesProbed - 1) + 1, `units ${r.acq.probesUsed}, pages ${fp.pages}, states ${fp.statesProbed}`);
    check(`pages capped at ${INDEX_PAGE_BUDGET_SHARE * 100}% of the run's budget (${cap})`, fp.pages <= cap, `pages ${fp.pages}`);
    check("…the run still proved something and stopped honestly (PROBE_BUDGET)",
      r.acq.coverage.kind === "COMPLETE" && r.acq.cursor.stoppedBecause === "PROBE_BUDGET" && (r.acq.cursor.provenFromBlock ?? HEAD) < HEAD);
    const big = await acquire({ events: MANY, index: { pageSize: 1 } }, { fastPath: true });
    const walk = await acquire({ events: MANY }, { fastPath: false });
    check("with the default budget the same 1-per-page index pages through to an identical result", result(big.acq) === result(walk.acq) && big.acq.fastPath!.pages === 20);
  }

  // ══ 14. INTERNAL-CALL CREDITS ══════════════════════════════════════════════
  console.log("\n14. Credits paid by an internal call are asked for (category \"internal\")");
  {
    const events: IndexedSimEvent[] = [
      ...TYPICAL,
      { block: 22_500_000, delta: ETH(0.4), internal: true },
      { block: 24_800_000, delta: ETH(0.6), internal: true },
    ];
    const { fast, walk } = await both({ events });
    const K = events.length;
    const expected = 2 + 2 * SENDS + 3 * (2 * K + 2) + 2 * (K - SENDS) + 2;
    check("identical to the walk", result(fast.acq) === result(walk.acq));
    check("listed, so no interval fell back", fast.acq.fastPath?.fallbackIntervals === 0, JSON.stringify(fast.acq.fastPath));
    check(`exactly ${expected} calls (8K + 10)`, fast.calls === expected, `got ${fast.calls}`);
  }

  // ══ 15. THE KEY PROOF'S READS ARE BOUNDED ══════════════════════════════════
  console.log("\n15. The key proof stops at the first signed receipt, and on the clock");
  {
    const busy: IndexedSimEvent[] = [{ block: 20_000_000, delta: ETH(10) }];
    for (let i = 0; i < 40; i++) busy.push({ block: 20_000_001 + i * 1_000, delta: -GAS(10), originated: true, feeWei: GAS(10) });
    // anchor probe · pages · ONE key-proof batch · one probe group = 4 requests.
    let t = 0;
    const r = await acquire({ events: busy, onRequest: () => { t += 1_000; } }, { fastPath: true, now: () => t, deadlineMs: 4_000 });
    check("4 requests suffice to prove a boundary: the key proof read ONE batch and stopped at the first signed receipt",
      // receipts read = the one key-proof batch (2 blocks, both also change blocks) + evidence for the rest proven.
      r.acq.coverage.kind === "COMPLETE" && (r.acq.cursor.provenFromBlock ?? HEAD) < HEAD && r.acq.changeBlocks.length >= 2
        && r.meter["eth_getBlockReceipts"] === r.acq.changeBlocks.length,
      `${JSON.stringify(r.acq.cursor)} ${JSON.stringify(r.meter)}`);
  }
  {
    // A receive-only wallet whose newest "from" listings are phantoms (no signed
    // receipt): the key proof keeps looking — but never past the deadline.
    const events: IndexedSimEvent[] = [{ block: 21_000_000, delta: ETH(2) }];
    const phantom = Array.from({ length: 8 }, (_, i) => ({ block: 25_990_000 + i, dir: "from" as const }));
    let t = 0, late = 0;
    const deadline = 4_000;
    const r = await acquire({ events, index: { phantom }, onRequest: () => { if (t >= deadline) late++; t += 1_000; } },
      { fastPath: true, now: () => t, deadlineMs: deadline });
    check("no request starts at or after the deadline while looking for the key proof", late === 0 && r.acq.coverage.kind !== "COMPLETE",
      `late ${late}, ${JSON.stringify(r.meter)}`);
    const full = await acquire({ events, index: { phantom } }, { fastPath: true });
    const walk = await acquire({ events, index: { phantom } }, { fastPath: false });
    check("…not found within KEY_PROOF_MAX_BLOCKS ⇒ laid out as receive-only (chunk-bounded), identical to the walk",
      result(full.acq) === result(walk.acq) && maxProbeGap(full.sim.stats.probesAt, EARLIEST_PROVABLE_BLOCK, HEAD) <= DEFAULT_CHUNK_BLOCKS
        && (full.meter["eth_getBlockReceipts"] ?? 0) <= 8 + 1, JSON.stringify(full.meter));
  }

  console.log(`\neth-history-fast: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
