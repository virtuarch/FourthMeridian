/**
 * lib/crypto/eth-history-origin.test.ts
 *
 * The EARLY ORIGIN of the native ETH proof (2026-10-28).
 *
 *     npx tsx lib/crypto/eth-history-origin.test.ts
 *
 * Deterministic and offline: every RPC answer comes from a SIMULATED CHAIN (as
 * eth-history.test.ts). The reference for every comparison is the SAME
 * acquisition with the early origin disabled (`earlyOrigin: false`), i.e. the
 * full right-to-left walk to the window start.
 *
 * Pinned:
 *   - the KEY PROOF: no early stop until a receipt (this run's, or carried by
 *     the worker as a stored FEE) proves the address signed a transaction — a
 *     receive-only address, which could be a counterfactual CREATE2 address
 *     swept by a create-and-destroy, always walks;
 *   - a wallet first active late completes at its origin with ≥ 90% fewer
 *     probes than the walk to Byzantium, and an IDENTICAL result (movements,
 *     change blocks, coverage, cursor, opening and anchor balances) — directly
 *     and through the history worker's resumable steps;
 *   - no early stop at a boundary with nonce 0 but balance > 0, with balance 0
 *     but nonce > 0, with contract code, with an EIP-7702 delegation, or with a
 *     stale contract still present at the window start;
 *   - a balance held AT the floor still walks there and still fails
 *     BALANCE_BEFORE_PROVABLE_FLOOR;
 *   - a failed / throttled / unaffordable window-start probe never stops early,
 *     and the proof survives it;
 *   - the extra probe is metered; a window that starts at a resume block (the
 *     incremental and forward paths) lands exactly on that block.
 */

import {
  acquireEthHistory, looksLikeOrigin, EARLIEST_PROVABLE_BLOCK, WEI_PER_GWEI,
  type EthAccountState, type EthHistoryAcquisition, type EthHistoryDeps, type EthRpcTransport,
} from "./eth-history";
import { reconcileMovementsAgainstBalance, type ChainCoverage, type ChainMovement } from "./chain-movement";
import { queuedCheckpoint, serializeCheckpoint, parseCheckpoint, type EthBackfillCheckpoint } from "./eth-history-backfill.core";
import { runEthHistoryBackfill, ownerSignedIn, EthCheckpointConflictError, type EthBackfillStore } from "./eth-history-backfill";
import { ETHEREUM_NETWORK_ID } from "./eth-history";
import type { EthHistoryResult } from "./eth-history-sync";
import { replayEthHistory } from "./eth-history-rows";
import { readFileSync } from "fs";
import { join } from "path";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const ETH = (n: number) => BigInt(Math.round(n * 1e9)) * BigInt(1e9);
const GAS = (gwei: number) => BigInt(21000) * BigInt(gwei) * WEI_PER_GWEI;
const OWNER = "0x000000000000000000000000000000000000abcd";
const OTHER = "0x0000000000000000000000000000000000001234";
const DELEGATE = "0xef0100" + "11".repeat(20);

// ── A simulated chain ────────────────────────────────────────────────────────
interface SimEvent { block: number; delta: bigint; originated?: boolean; feeWei?: bigint; withdrawalWei?: bigint }
interface SimOpts {
  events: SimEvent[];
  head: number;
  headTimeSec: number;
  /** Account code at a block (default: a plain EOA everywhere). */
  codeAt?: (block: number) => string;
  /** Inject a failure for one call: "throttle" (JSON-RPC 429) or "error" (−32000). */
  failAt?: (block: number, method: string) => "throttle" | "error" | null;
}
function simulate(opts: SimOpts) {
  const events = [...opts.events].sort((a, b) => a.block - b.block);
  const stats = { probesAt: new Map<number, number>() };
  const stateAt = (block: number): EthAccountState => {
    let balance = BigInt(0); let nonce = BigInt(0);
    for (const e of events) { if (e.block > block) break; balance += e.delta; if (e.originated) nonce += BigInt(1); }
    return { balance, nonce, code: opts.codeAt ? opts.codeAt(block) : "0x" };
  };
  const tsOf = (b: number) => BigInt(opts.headTimeSec + (b - opts.head) * 12);
  interface Row { id: number; method: string; params: unknown[] }
  const transport: EthRpcTransport = async (body) => {
    const rows: Row[] = Array.isArray(body) ? body as Row[] : [body as Row];
    const out = rows.map((r) => {
      const isState = r.method === "eth_getBalance" || r.method === "eth_getTransactionCount" || r.method === "eth_getCode";
      const b = isState ? Number(BigInt(r.params[1] as string))
        : r.params[0] === "finalized" ? opts.head : Number(BigInt(r.params[0] as string));
      const f = opts.failAt?.(b, r.method) ?? null;
      if (f === "throttle") return { jsonrpc: "2.0", id: r.id, error: { code: 429, message: "capacity" } };
      if (f === "error") return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "header not found" } };
      if (r.method === "eth_getBalance") { stats.probesAt.set(b, (stats.probesAt.get(b) ?? 0) + 1); return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(b).balance) }; }
      if (r.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(b).nonce) };
      if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: stateAt(b).code };
      const ev = events.find((e) => e.block === b);
      if (r.method === "eth_getBlockByNumber") {
        return { jsonrpc: "2.0", id: r.id, result: { number: hex(b), hash: `0xblock${b}`, timestamp: hex(tsOf(b)),
          withdrawals: ev?.withdrawalWei ? [{ address: OWNER, amount: hex(ev.withdrawalWei / WEI_PER_GWEI) }] : [] } };
      }
      if (r.method === "eth_getBlockReceipts") {
        return { jsonrpc: "2.0", id: r.id, result: ev?.originated
          ? [{ from: OWNER, to: OTHER, status: "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex((ev.feeWei ?? BigInt(0)) / BigInt(21000)) }] : [] };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    });
    return JSON.stringify(Array.isArray(body) ? out : out[0]);
  };
  return { transport, stats, stateAt };
}

/** Everything a consumer can read off an acquisition, except its cost. */
function result(a: EthHistoryAcquisition): string {
  return JSON.stringify({
    movements: a.movements, coverage: a.coverage, changeBlocks: a.changeBlocks,
    cursor: { p: a.cursor.provenFromBlock, a: a.cursor.anchorBlock, r: a.cursor.reachedWindowStart, s: a.cursor.stoppedBecause ?? null },
    anchor: a.anchorBalanceWei, opening: a.openingBalanceWei,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function both(opts: SimOpts, args: { fromBlock?: number; toBlock?: number } = {}, deps: EthHistoryDeps = {}) {
  const run = async (earlyOrigin: boolean) => {
    const sim = simulate(opts);
    const meter: Record<string, number> = {};
    const acq = await acquireEthHistory(
      { ownerAddress: OWNER, fromBlock: args.fromBlock ?? EARLIEST_PROVABLE_BLOCK, toBlock: args.toBlock ?? opts.head },
      { transport: sim.transport, meter, ...deps, earlyOrigin });
    return { acq, meter, sim };
  };
  return { early: await run(true), walk: await run(false) };
}

/** An in-memory history link (as eth-history-backfill.test.ts). */
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
async function worker(opts: SimOpts, earlyOrigin: boolean, probeBudget = 150, maxSteps = 400, simIn?: ReturnType<typeof simulate>) {
  const sim = simIn ?? simulate(opts);
  const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
  const meter: Record<string, number> = {};
  const outcomes: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY },
      { probeBudget, now: () => Date.parse(NOW_ISO), eth: { transport: sim.transport, meter, earlyOrigin } });
    outcomes.push(o.failure ? `${o.stoppedBecause}:${o.failure.code}` : o.stoppedBecause);
    if (o.stoppedBecause !== "PROBE_BUDGET") break;
  }
  const requests = Object.values(meter).reduce((a, b) => a + b, 0);
  return { store, outcomes, requests, sim };
}

const HEAD = 26_000_000;
const T_HEAD = Date.UTC(2026, 9, 27, 12, 0, 0) / 1000;
/** A wallet added soon after it was created: first active ~11 days before the
 *  head; then a spend and a validator withdrawal. */
const LATE: SimEvent[] = [
  { block: 25_920_000, delta: ETH(2) },
  { block: 25_940_000, delta: -ETH(0.5) - GAS(20), originated: true, feeWei: GAS(20) },
  { block: 25_941_000, delta: ETH(0.032), withdrawalWei: ETH(0.032) },
];

/** The distinct blocks a run probed strictly below `b` (its cost there). */
const probedBelow = (sim: ReturnType<typeof simulate>, b: number) => [...sim.stats.probesAt.keys()].filter((x) => x < b).length;

async function main() {
  // ══ 0. THE GATE ════════════════════════════════════════════════════════════
  {
    const z = BigInt(0);
    check("gate: a never-used empty EOA looks like an origin", looksLikeOrigin({ balance: z, nonce: z, code: "0x" }));
    check("gate: nonce 0 but a balance is not an origin", !looksLikeOrigin({ balance: BigInt(1), nonce: z, code: "0x" }));
    check("gate: balance 0 but nonce > 0 (it spent) is not an origin", !looksLikeOrigin({ balance: z, nonce: BigInt(1), code: "0x" }));
    check("gate: contract code is not an origin", !looksLikeOrigin({ balance: z, nonce: z, code: "0x6080604052" }));
    check("gate: an EIP-7702 delegation designator is not an origin", !looksLikeOrigin({ balance: z, nonce: z, code: DELEGATE }));
  }

  // ══ 1. A WALLET FIRST ACTIVE LATE — identical result, ≥ 90% fewer probes ══
  {
    const { early, walk } = await both({ events: LATE, head: HEAD, headTimeSec: T_HEAD });
    const cut = 1 - early.acq.probesUsed / walk.acq.probesUsed;
    console.log(`(late wallet, 50k chunks: early ${early.acq.probesUsed} probes / ${early.acq.rpcReads} reads vs walk ${walk.acq.probesUsed} / ${walk.acq.rpcReads}; −${(cut * 100).toFixed(1)}%)`);
    check("the walk reference reaches Byzantium COMPLETE with every change block",
      walk.acq.coverage.kind === "COMPLETE" && walk.acq.cursor.reachedWindowStart && walk.acq.cursor.provenFromBlock === EARLIEST_PROVABLE_BLOCK
        && JSON.stringify(walk.acq.changeBlocks) === JSON.stringify(LATE.map((e) => e.block)));
    check("the early origin gives EXACTLY the walk's result (movements, coverage, cursor, balances)",
      result(early.acq) === result(walk.acq), `${result(early.acq).slice(0, 300)}\n        ${result(walk.acq).slice(0, 300)}`);
    check("…closing at a proven boundary just below the first activity",
      early.acq.originProvenAtBlock !== undefined && early.acq.originProvenAtBlock < LATE[0].block
        && early.acq.originProvenAtBlock > LATE[0].block - 50_000 && walk.acq.originProvenAtBlock === undefined, String(early.acq.originProvenAtBlock));
    check("…EXACTLY the walk's cost above the origin, plus one probe: everything below it collapses to the window-start probe",
      early.acq.probesUsed === walk.acq.probesUsed - probedBelow(walk.sim, early.acq.originProvenAtBlock!) + 1,
      `${early.acq.probesUsed} vs ${walk.acq.probesUsed} − ${probedBelow(walk.sim, early.acq.originProvenAtBlock!)} + 1`);
    check("…with ≥ 90% fewer probes", cut >= 0.9, `${early.acq.probesUsed} vs ${walk.acq.probesUsed}`);
    check("…and ≥ 90% fewer RPC reads", early.acq.rpcReads <= walk.acq.rpcReads / 10, `${early.acq.rpcReads} vs ${walk.acq.rpcReads}`);
    check("the one extra probe (at the window start) is METERED like every other",
      early.meter.eth_getBalance === early.acq.probesUsed && early.meter.eth_getTransactionCount === early.acq.probesUsed
        && early.sim.stats.probesAt.get(EARLIEST_PROVABLE_BLOCK) === 1, JSON.stringify(early.meter));
  }

  // ══ 1b. The Preview-shaped case: halved chunks, first active 2025-01-30 ════
  {
    const PREVIEW: SimEvent[] = [{ block: 21_736_759, delta: ETH(0.3) }, { block: 22_400_000, delta: -ETH(0.1) - GAS(9), originated: true, feeWei: GAS(9) }];
    const opts = { events: PREVIEW, head: 23_700_000, headTimeSec: T_HEAD };
    const { early, walk } = await both(opts, {}, { chunkBlocks: 2_000, probeBudget: 100_000 });
    const cut = 1 - early.acq.probesUsed / walk.acq.probesUsed;
    console.log(`(Preview-shaped, 2k chunks: early ${early.acq.probesUsed} probes vs walk ${walk.acq.probesUsed}; −${(cut * 100).toFixed(1)}%)`);
    check("Preview-shaped: identical result", result(early.acq) === result(walk.acq));
    const below = probedBelow(walk.sim, early.acq.originProvenAtBlock!);
    check("Preview-shaped: the ~17.4M provably-empty blocks below the origin cost ONE probe instead of the walk's thousands",
      early.acq.originProvenAtBlock! < 21_736_759 && below > 8_000 && early.acq.probesUsed === walk.acq.probesUsed - below + 1,
      `${early.acq.probesUsed} vs ${walk.acq.probesUsed} (below origin: ${below})`);
  }

  // ══ 2. THROUGH THE WORKER — same rows, same licence, far fewer steps ══════
  {
    const opts = { events: LATE, head: HEAD, headTimeSec: T_HEAD };
    const e = await worker(opts, true);
    const w = await worker(opts, false);
    console.log(`(worker, 150 probes/step: early ${e.outcomes.length} steps / ${e.requests} requests vs walk ${w.outcomes.length} steps / ${w.requests} requests)`);
    check("both complete", e.outcomes.at(-1) === "COMPLETE" && w.outcomes.at(-1) === "COMPLETE", `${e.outcomes.at(-1)} / ${w.outcomes.at(-1)}`);
    const ser = (s: MemoryStore) => JSON.stringify(s.writes, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    check("the worker writes IDENTICAL movements, licence and anchor", e.store.writes.length === 1 && ser(e.store) === ser(w.store));
    check("…licensed from the provable floor's date, as the walk's", e.store.cp()?.licensedFromISO === w.store.cp()?.licensedFromISO
      && e.store.cp()?.provenFromBlock === EARLIEST_PROVABLE_BLOCK && e.store.cp()?.reachedFloor === true);
    check("…in ≥ 90% fewer requests", e.requests * 10 <= w.requests, `${e.requests} vs ${w.requests}`);
  }

  // ══ 3. NO EARLY STOP: nonce 0 but balance > 0 at the boundary ═════════════
  {
    // Receive-only: every boundary above the deposit has nonce 0 and a balance.
    const opts = { events: [{ block: 20_000_000, delta: ETH(1) }], head: HEAD, headTimeSec: T_HEAD };
    const { early, walk } = await both(opts);
    check("receive-only (never signed): FAIL CLOSED — no early stop anywhere, the full walk",
      early.acq.originProvenAtBlock === undefined && early.acq.probesUsed === walk.acq.probesUsed, String(early.acq.originProvenAtBlock));
    check("…and the result is the walk's", result(early.acq) === result(walk.acq));
  }
  {
    // nonce 0 ∧ balance > 0 at every boundary between the deposit and the
    // first spend, WITH the key proven (the spend is signed): the gate fails at
    // each of them; it may close only below the deposit.
    const events: SimEvent[] = [
      { block: 20_000_000, delta: ETH(1) },
      { block: 25_940_000, delta: -ETH(0.1) - GAS(20), originated: true, feeWei: GAS(20) },
    ];
    const { early, walk } = await both({ events, head: HEAD, headTimeSec: T_HEAD });
    check("balance > 0 at B (key proven): no early stop at any boundary holding the balance",
      early.acq.originProvenAtBlock !== undefined && early.acq.originProvenAtBlock < 20_000_000
        && early.acq.originProvenAtBlock >= 20_000_000 - 50_000, String(early.acq.originProvenAtBlock));
    check("…the deposit is still found, and the result is the walk's",
      early.acq.changeBlocks.includes(20_000_000) && result(early.acq) === result(walk.acq));
  }
  {
    // The case the key proof exists for: a COUNTERFACTUAL CREATE2 address,
    // pre-funded at 15M and swept at 15M+10 by a contract created there and
    // destroyed in the same transaction (nonce 0, no code at every block end),
    // later funded again. State reads at chunk ends cannot see the pair, so the
    // run must never close early over it — and, never having signed, it doesn't.
    const events: SimEvent[] = [
      { block: 15_000_000, delta: ETH(3) },
      { block: 15_000_010, delta: -ETH(3) },
      { block: 25_920_000, delta: ETH(1) },
    ];
    const { early, walk } = await both({ events, head: HEAD, headTimeSec: T_HEAD });
    check("counterfactual CREATE2 sweep (no signature ever): no early stop — the walk, with its own chunk-boundary limits",
      early.acq.originProvenAtBlock === undefined && result(early.acq) === result(walk.acq));
  }
  {
    // Held ETH AT the floor and never moved: the gate never passes, the walk
    // reaches the floor, and the worker still refuses the zero-opening rebuild.
    const opts = { events: [{ block: 1_000_000, delta: ETH(4) }], head: HEAD, headTimeSec: T_HEAD };
    const { early, walk } = await both(opts);
    check("a balance held at the floor: never an early stop, walks to the floor with the opening balance",
      early.acq.originProvenAtBlock === undefined && result(early.acq) === result(walk.acq)
        && early.acq.cursor.reachedWindowStart && early.acq.openingBalanceWei === ETH(4));
    const wk = await worker(opts, true, 1_000);
    check("…and the worker still fails BALANCE_BEFORE_PROVABLE_FLOOR", wk.outcomes.at(-1) === "FAILED:BALANCE_BEFORE_PROVABLE_FLOOR", wk.outcomes.join(","));
  }

  // ══ 4. NO EARLY STOP: balance 0 but nonce > 0 (it spent before) ═══════════
  {
    const IN = ETH(1) + GAS(20);
    const events: SimEvent[] = [
      { block: 24_000_000, delta: IN },
      { block: 25_000_000, delta: -IN, originated: true, feeWei: GAS(20) },  // swept to zero
    ];
    const { early, walk } = await both({ events, head: HEAD, headTimeSec: T_HEAD });
    check("balance 0 ∧ nonce 1: no early stop above the spend — both movements found",
      early.acq.originProvenAtBlock !== undefined && early.acq.originProvenAtBlock < 24_000_000
        && JSON.stringify(early.acq.changeBlocks) === JSON.stringify([24_000_000, 25_000_000]), `${early.acq.originProvenAtBlock} ${early.acq.changeBlocks}`);
    check("…and the result is the walk's", result(early.acq) === result(walk.acq));
  }

  // ══ 5. NO EARLY STOP: contract code / EIP-7702 / a stale contract ═════════
  {
    const { early, walk } = await both({ events: LATE, head: HEAD, headTimeSec: T_HEAD, codeAt: () => "0x6080604052" });
    check("a contract account: PROOF_PREMISES_UNMET, exactly as the walk",
      early.acq.coverage.kind === "UNKNOWN" && early.acq.coverage.caveats.includes("PROOF_PREMISES_UNMET")
        && early.acq.originProvenAtBlock === undefined && result(early.acq) === result(walk.acq));
  }
  {
    // EIP-7702: funded, delegation installed (signed authorization ⇒ nonce 1),
    // later cleared (another authorization ⇒ nonce 2). The anchor has no code,
    // but the delegated interval is a proof hole, and no boundary above it is
    // origin-like (nonce 2) — so nothing may skip over it.
    const events: SimEvent[] = [
      { block: 25_500_000, delta: ETH(1) },
      { block: 25_700_000, delta: -GAS(30), originated: true, feeWei: GAS(30) },
      { block: 25_800_000, delta: -GAS(30), originated: true, feeWei: GAS(30) },
    ];
    const codeAt = (b: number) => (b >= 25_700_000 && b < 25_800_000 ? DELEGATE : "0x");
    const { early, walk } = await both({ events, head: HEAD, headTimeSec: T_HEAD, codeAt });
    check("an EIP-7702 delegation in the history: PROOF_PREMISES_UNMET, no early stop, as the walk",
      early.acq.coverage.kind === "UNKNOWN" && early.acq.coverage.caveats.includes("PROOF_PREMISES_UNMET")
        && early.acq.originProvenAtBlock === undefined && result(early.acq) === result(walk.acq), result(early.acq).slice(0, 200));
  }
  {
    // A stale contract still at the window start (code below 10M), the address
    // later empty and never used: the gate passes at the boundary below the
    // first activity, but the predicate refuses (code at lo) — the walk goes on
    // and meets the contract exactly where the full walk does.
    const codeAt = (b: number) => (b < 10_000_000 ? "0x6080604052" : "0x");
    const { early, walk } = await both({ events: LATE, head: HEAD, headTimeSec: T_HEAD, codeAt });
    check("code still present at the window start: no early stop, the walk's own refusal",
      early.acq.originProvenAtBlock === undefined && early.acq.coverage.kind === "UNKNOWN"
        && early.acq.coverage.caveats.includes("PROOF_PREMISES_UNMET") && result(early.acq) === result(walk.acq));
    check("…the window start was probed once and memoised, not per chunk",
      early.sim.stats.probesAt.get(EARLIEST_PROVABLE_BLOCK) === 1 && early.acq.probesUsed === walk.acq.probesUsed + 1,
      `${early.acq.probesUsed} vs ${walk.acq.probesUsed}`);
  }

  // ══ 6. NO EARLY STOP when the window-start probe fails ════════════════════
  {
    // Throttled beyond the backoff: the proof keeps what it closed, stops, and
    // does not claim the window start.
    const opts: SimOpts = { events: LATE, head: HEAD, headTimeSec: T_HEAD,
      failAt: (b, m) => (b === EARLIEST_PROVABLE_BLOCK && m === "eth_getBalance" ? "throttle" : null) };
    const sim = simulate(opts);
    const acq = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD },
      { transport: sim.transport, throttleRetries: 1, sleepImpl: async () => {} });
    check("throttled window-start probe: no early stop, proven chunks kept, says why",
      acq.originProvenAtBlock === undefined && acq.coverage.kind === "COMPLETE" && !acq.cursor.reachedWindowStart
        && acq.cursor.stoppedBecause === "PROVIDER_THROTTLED" && acq.cursor.provenFromBlock! < LATE[0].block
        && JSON.stringify(acq.changeBlocks) === JSON.stringify(LATE.map((e) => e.block)), result(acq).slice(0, 300));
  }
  {
    const opts: SimOpts = { events: LATE, head: HEAD, headTimeSec: T_HEAD,
      failAt: (b, m) => (b === EARLIEST_PROVABLE_BLOCK && m === "eth_getCode" ? "error" : null) };
    const sim = simulate(opts);
    let threw = false;
    try { await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD }, { transport: sim.transport }); }
    catch { threw = true; }
    check("a provider error on the window-start probe licenses nothing (it throws, as any probe failure)", threw);
    // Through the worker: a coded failure, and the proof boundary survives.
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 1_000, now: () => Date.parse(NOW_ISO), eth: { transport: sim.transport } });
    check("…the worker records PROVIDER_FAILED and does not reach the floor", o.failure?.code === "PROVIDER_FAILED" && store.cp()?.reachedFloor === false, JSON.stringify(o.failure));
  }
  {
    // Budget runs out exactly at the window-start probe: no early stop, the
    // boundary is kept, and the NEXT run closes at the origin a chunk lower.
    const ref = await both({ events: LATE, head: HEAD, headTimeSec: T_HEAD });
    const sim = simulate({ events: LATE, head: HEAD, headTimeSec: T_HEAD });
    const first = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD },
      { transport: sim.transport, probeBudget: ref.early.acq.probesUsed - 1 });
    check("budget exhausted at the window-start probe: no early stop, PROBE_BUDGET, boundary kept",
      first.originProvenAtBlock === undefined && !first.cursor.reachedWindowStart && first.cursor.stoppedBecause === "PROBE_BUDGET"
        && first.cursor.provenFromBlock === ref.early.acq.originProvenAtBlock, `${first.cursor.provenFromBlock} ${first.cursor.stoppedBecause}`);
    // The worker carries the key proof as the FEE it already stored.
    const signed = first.movements.some((m) => m.role === "FEE");
    const second = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD, cursor: first.cursor, ownerSigned: signed },
      { transport: sim.transport });
    check("…the resumed run (key proof carried) closes at the origin one chunk lower, reaching the window start",
      signed && second.originProvenAtBlock !== undefined && second.cursor.reachedWindowStart && second.cursor.provenFromBlock === EARLIEST_PROVABLE_BLOCK
        // anchor (re-read every run) + the chunk's two ends + the window start
        && second.openingBalanceWei === BigInt(0) && second.changeBlocks.length === 0 && second.probesUsed === 4, `${second.probesUsed}`);
    const blind = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD, cursor: first.cursor },
      { transport: simulate({ events: LATE, head: HEAD, headTimeSec: T_HEAD }).transport });
    check("…without the carried key proof the resumed run walks (fail closed), to the same result",
      blind.originProvenAtBlock === undefined && blind.cursor.reachedWindowStart && blind.probesUsed > 100
        && result(blind) === result(second), `${blind.probesUsed}`);
  }

  // ══ 7. Other windows: an empty wallet, a resume-block window ══════════════
  {
    const { early, walk } = await both({ events: [], head: HEAD, headTimeSec: T_HEAD });
    check("a wallet with no history at all never signed: it walks (fail closed), the walk's result",
      early.acq.originProvenAtBlock === undefined && early.acq.probesUsed === walk.acq.probesUsed && result(early.acq) === result(walk.acq), `${early.acq.probesUsed}`);
  }
  {
    // The incremental suffix and the forward phase start at a block whose
    // balance they already hold; they require the proof to land ON it.
    const from = 25_000_000;
    const { early, walk } = await both({ events: LATE, head: HEAD, headTimeSec: T_HEAD }, { fromBlock: from });
    check("a window starting at a resume block: the early origin lands exactly on it, the walk's result",
      early.acq.cursor.provenFromBlock === from && early.acq.cursor.reachedWindowStart && early.acq.originProvenAtBlock !== undefined
        && result(early.acq) === result(walk.acq));
    const funded = await both({ events: [{ block: 24_000_000, delta: ETH(1) }, ...LATE], head: HEAD, headTimeSec: T_HEAD }, { fromBlock: from });
    check("…and with a non-zero balance at the resume block the gate never passes",
      funded.early.acq.originProvenAtBlock === undefined && result(funded.early.acq) === result(funded.walk.acq)
        && funded.early.acq.probesUsed === funded.walk.acq.probesUsed);
  }

  // ══ 8. METERING: the key proof re-uses the evidence reads ═════════════════
  {
    const { early, walk } = await both({ events: LATE, head: HEAD, headTimeSec: T_HEAD });
    const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    check("receipts are read ONCE per change block — the key proof's reads are the evidence phase's",
      early.meter.eth_getBlockReceipts === LATE.length && walk.meter.eth_getBlockReceipts === LATE.length, JSON.stringify(early.meter));
    check("every call is metered: the meter equals the acquisition's own read count",
      total(early.meter) === early.acq.rpcReads && total(walk.meter) === walk.acq.rpcReads, `${total(early.meter)} vs ${early.acq.rpcReads}`);
    check("the extra probe counts against the probe budget (≤ budget, budget exact still closes)",
      (await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD },
        { transport: simulate({ events: LATE, head: HEAD, headTimeSec: T_HEAD }).transport, probeBudget: early.acq.probesUsed })).originProvenAtBlock
        === early.acq.originProvenAtBlock);
  }

  // ══ 9. CRASH / RESUME mid-proof, through the worker ═══════════════════════
  {
    // The receipts read the KEY PROOF makes fails once (a provider error, not
    // a throttle): the step records PROVIDER_FAILED and keeps its proof; the
    // operator resume continues from the stored boundary and completes with
    // exactly the walk's rows and licence.
    const opts = { events: LATE, head: HEAD, headTimeSec: T_HEAD };
    let failedOnce = false;
    const sim = simulate({ ...opts, failAt: (b, m) => {
      if (!failedOnce && m === "eth_getBlockReceipts" && b === LATE[0].block) { failedOnce = true; return "error"; }
      return null;
    } });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i++) {
      const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY, resume: true },
        { probeBudget: 150, now: () => Date.parse(NOW_ISO), eth: { transport: sim.transport } });
      outcomes.push(o.failure ? `${o.stoppedBecause}:${o.failure.code}` : o.stoppedBecause);
      if (o.stoppedBecause === "COMPLETE") break;
    }
    const w = await worker(opts, false);
    const ser = (st: MemoryStore) => JSON.stringify(st.writes, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    check("a crash mid-proof (in the key proof's receipts read) fails the step, then resumes to COMPLETE",
      failedOnce && outcomes.includes("FAILED:PROVIDER_FAILED") && outcomes.at(-1) === "COMPLETE", outcomes.join(","));
    check("…with exactly the walk's rows, licence and anchor", ser(store) === ser(w.store));
  }

  // ══ 10. COVERAGE IS THE PROVEN INTERVAL — no earlier, no fabricated rows ══
  {
    const sim = simulate({ events: LATE, head: HEAD, headTimeSec: T_HEAD });
    const acq = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD }, { transport: sim.transport });
    const loISO = new Date((T_HEAD + (EARLIEST_PROVABLE_BLOCK - HEAD) * 12) * 1000).toISOString().slice(0, 10);
    const firstISO = acq.movements.map((m) => m.dateISO).sort()[0];
    check("default deps (as the inline sync passes them) take the early origin", acq.originProvenAtBlock !== undefined);
    check("coverage starts at the deepest block the proof READ (the window start), never earlier, with a zero opening",
      acq.coverage.kind === "COMPLETE" && acq.coverage.fromISO === loISO && acq.cursor.provenFromBlock === EARLIEST_PROVABLE_BLOCK
        && acq.openingBalanceWei === BigInt(0), JSON.stringify(acq.coverage));
    const anchorQty = Number(acq.anchorBalanceWei!) / 1e18;
    const { rows } = replayEthHistory({ accountId: "a1", instrumentId: "eth",
      anchor: { observationId: "o1", dateISO: TODAY, effectiveDateTimeISO: null, quantity: anchorQty, origin: "OBSERVED", completeness: "observed" },
      movements: acq.movements, coverage: acq.coverage, windowFromISO: "2017-01-01", windowToISO: TODAY });
    check("no row precedes the licence; every row before the first movement is ZERO; no movement is invented",
      rows.length > 0 && rows.every((r) => r.dateISO >= loISO) && rows.filter((r) => r.dateISO < firstISO).every((r) => r.quantity === 0)
        && acq.movements.every((m) => LATE.some((e) => e.block === m.sequence)),
      `${rows[0]?.dateISO} first=${firstISO}`);
  }

  // ══ 11. ONE IMPLEMENTATION: the inline sync and the worker share it ═══════
  {
    const src = (f: string) => readFileSync(join(process.cwd(), "lib", "crypto", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    const sync = src("eth-history-sync.ts"), bf = src("eth-history-backfill.ts");
    check("the inline sync acquires through acquireEthHistory and never disables the early origin",
      /acquireEthHistory\(/.test(sync) && !/earlyOrigin/.test(sync));
    check("the worker carries the key proof and never disables the early origin",
      /ownerSigned:\s*ownerSignedIn\(cp\.movements, store\.walletAddress\)/.test(bf) && !/earlyOrigin/.test(bf));
    // The key proof is THIS address on Ethereum: a FEE row for another address or network proves nothing.
    const me = "0xAbC0000000000000000000000000000000000001";
    const fee = (ownedAddress: string, networkId = ETHEREUM_NETWORK_ID, role = "FEE") => ({ role, ownedAddress, networkId });
    check("ownerSignedIn: a FEE row owned by the address on Ethereum proves signing (case-insensitive)",
      ownerSignedIn([fee(me.toLowerCase())], me));
    check("ownerSignedIn: a FEE row for ANOTHER address proves nothing",
      !ownerSignedIn([fee("0x0000000000000000000000000000000000000002")], me));
    check("ownerSignedIn: a FEE row on another network proves nothing",
      !ownerSignedIn([fee(me, "eip155:137")], me));
    check("ownerSignedIn: a non-FEE row owned by the address proves nothing",
      !ownerSignedIn([fee(me, ETHEREUM_NETWORK_ID, "TRANSFER")], me) && !ownerSignedIn([], me));
    check("the rule lives in ONE place: looksLikeOrigin is defined only in eth-history.ts",
      !/function looksLikeOrigin|provablyUnchanged\(/.test(sync + bf));
  }

  console.log(`\neth-history-origin: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
