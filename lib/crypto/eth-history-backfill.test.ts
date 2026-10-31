/**
 * lib/crypto/eth-history-backfill.test.ts
 *
 * The Ethereum FULL rebuild off the sync path (2026-10-28).
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/eth-history-backfill.test.ts
 *
 * Deterministic and offline: every RPC answer comes from a SIMULATED CHAIN (as
 * eth-history.test.ts), every database touch from an in-memory store or fake.
 *
 * Pinned:
 *   - flag OFF: the incremental path, else ONE bounded inline worker step (never an unbounded rebuild);
 *   - flag ON: an incremental fallback is QUEUED and nothing is written;
 *   - the worker resumes across PROBE_BUDGET stops (never restarts) and writes
 *     once, with movements that reconcile in exact wei;
 *   - a head that moved during the import is closed before the write;
 *   - the shared Alchemy daily cap defers the pass; a re-run is idempotent;
 *   - status reads truthfully in the SOL/BTC vocabulary.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  acquireEthHistory, EARLIEST_PROVABLE_BLOCK, WEI_PER_GWEI, type EthAccountState, type EthRpcTransport,
} from "./eth-history";
import { reconcileMovementsAgainstBalance, type ChainCoverage, type ChainMovement } from "./chain-movement";
import {
  ethWorkerEnabled, ethWorkerConfig, queuedCheckpoint, serializeCheckpoint, parseCheckpoint, ethStatusFromCursor,
  backfillStatus, probeBudgetFor, orderEthCandidates, isEthBackfillCursor, MAX_CONSECUTIVE_FAILURES, MIN_ETH_CHUNK_BLOCKS,
  type EthBackfillCheckpoint,
} from "./eth-history-backfill.core";
import { runEthHistoryBackfill, EthCheckpointConflictError, type EthBackfillStore } from "./eth-history-backfill";
import {
  reconstructEthHistoryForSync, enqueueEthHistoryBackfill, prismaEthBackfillStore, ethHistoryPending, type EthSyncImpl,
} from "./eth-history-backfill.store";
import type { EthHistoryResult } from "./eth-history-sync";
import { walletHistoryCheckpointStatus, historyWorkerEnabledFor } from "./history-checkpoint-status";
import { historyImportText } from "@/lib/connections/connection-detail.core";
import { emptyCheckpoint as emptyBtcCheckpoint, serializeCheckpoint as serializeBtcCheckpoint } from "./btc-history-backfill.core";
import { emptyCheckpoint as emptySolCheckpoint, serializeCheckpoint as serializeSolCheckpoint } from "./sol-history-backfill.core";
import { solHistoryBackfill, type SolBackfillJobDeps } from "@/jobs/sol-history-backfill";
import { workerConfig } from "./sol-backfill-worker.core";
import { btcWorkerConfig } from "./btc-backfill-worker.core";

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
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

// ── A simulated chain whose FINALIZED head can move ──────────────────────────
interface SimEvent { block: number; delta: bigint; originated?: boolean; feeWei?: bigint }
function simulate(opts: { events: SimEvent[]; head: number; headTimeSec: number; code?: string }) {
  const chain = { head: opts.head, events: [...opts.events].sort((a, b) => a.block - b.block), probes: 0, calls: 0 };
  const stateAt = (block: number): EthAccountState => {
    let balance = BigInt(0); let nonce = BigInt(0);
    for (const e of chain.events) { if (e.block > block) break; balance += e.delta; if (e.originated) nonce += BigInt(1); }
    return { balance, nonce, code: opts.code ?? "0x" };
  };
  const tsOf = (b: number) => BigInt(opts.headTimeSec + (b - opts.head) * 12);
  interface Row { id: number; method: string; params: unknown[] }
  const transport: EthRpcTransport = async (body) => {
    const rows: Row[] = Array.isArray(body) ? body as Row[] : [body as Row];
    const out = rows.map((r) => {
      chain.calls++;
      const blockOf = () => Number(BigInt(r.params[1] as string));
      if (r.method === "eth_getBalance") { chain.probes++; return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(blockOf()).balance) }; }
      if (r.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: hex(stateAt(blockOf()).nonce) };
      if (r.method === "eth_getCode") return { jsonrpc: "2.0", id: r.id, result: stateAt(blockOf()).code };
      if (r.method === "eth_getBlockByNumber") {
        const b = r.params[0] === "finalized" ? chain.head : Number(BigInt(r.params[0] as string));
        return { jsonrpc: "2.0", id: r.id, result: { number: hex(b), hash: `0xblock${b}`, timestamp: hex(tsOf(b)), withdrawals: [] } };
      }
      if (r.method === "eth_getBlockReceipts") {
        const ev = chain.events.find((e) => e.block === Number(BigInt(r.params[0] as string)));
        const receipts = ev?.originated
          ? [{ from: OWNER, to: OTHER, status: "0x1", gasUsed: hex(BigInt(21000)), effectiveGasPrice: hex((ev.feeWei ?? BigInt(0)) / BigInt(21000)) }] : [];
        return { jsonrpc: "2.0", id: r.id, result: receipts };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    });
    return JSON.stringify(Array.isArray(body) ? out : out[0]);
  };
  return { chain, transport, stateAt };
}

/** An in-memory history link: the checkpoint, a CAS, and the completing write. */
class MemoryStore implements EthBackfillStore {
  walletAddress = OWNER;
  cursor: string | null;
  writes: Array<{ movements: ChainMovement[]; coverage: ChainCoverage; anchorBalanceWei: bigint }> = [];
  constructor(cursor: string | null, private rowsWritten = 42) { this.cursor = cursor; }
  async readCursor() { return this.cursor; }
  async casCursor(expected: string | null, next: string) { if (this.cursor !== expected) return false; this.cursor = next; return true; }
  async complete(c: Parameters<EthBackfillStore["complete"]>[0]): Promise<EthHistoryResult> {
    // The real binding is persistEthFullHistory: reconcile in wei, then rows + licence + CAS in one transaction.
    const recon = reconcileMovementsAgainstBalance(c.movements, c.anchorBalanceWei);
    if (!recon.reconciles) return { accountId: "a1", ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE", reason: recon.reason };
    if (this.cursor !== c.expectedCursor) throw new EthCheckpointConflictError();
    this.cursor = c.nextCursor;
    this.writes.push({ movements: c.movements, coverage: c.coverage, anchorBalanceWei: c.anchorBalanceWei });
    return { accountId: "a1", ok: true, mode: "FULL", derivedRowsWritten: this.rowsWritten, impactedFromISO: c.coverage.kind === "COMPLETE" ? c.coverage.fromISO : null };
  }
  cp(): EthBackfillCheckpoint | null { return parseCheckpoint(this.cursor, "a1"); }
}

const HEAD = 26_000_000;
const T_HEAD = Date.UTC(2026, 9, 27, 12, 0, 0) / 1000;
const EVENTS: SimEvent[] = [
  { block: 9_000_123, delta: ETH(3) },
  { block: 15_000_001, delta: -ETH(1) - GAS(40), originated: true, feeWei: GAS(40) },
  { block: 22_500_000, delta: ETH(0.25) },
  { block: 25_999_000, delta: -GAS(12), originated: true, feeWei: GAS(12) },
];
const NOW_ISO = "2026-10-28T10:00:00.000Z";
const TODAY = "2026-10-28";

async function main() {
  // ══ 1. THE GATE ════════════════════════════════════════════════════════════
  check("ETH_BACKFILL_ENABLED alone does not defer (the worker job must run: SOL_BACKFILL_ENABLED)",
    !ethWorkerEnabled({ ETH_BACKFILL_ENABLED: "true" }) && !ethWorkerEnabled({ SOL_BACKFILL_ENABLED: "true" })
      && ethWorkerEnabled({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true" })
      && !ethWorkerEnabled({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "1" }) && !ethWorkerEnabled({}));
  const c = ethWorkerConfig({ ETH_BACKFILL_PROBE_BUDGET: "999999" });
  check("worker config is clamped (a bad value falls back to the default, never unlimited)", c.probeBudget === 1_500 && !c.enabled);

  // ══ 2. FLAG OFF — the incremental path, else ONE bounded inline step ══════
  //    (2026-10-31: never the unbounded inline FULL rebuild of before.)
  {
    const calls: Array<Record<string, unknown>> = [];
    const steps: Array<Record<string, unknown>> = [];
    const meter = { x: 1 };
    const impl: EthSyncImpl = {
      reconstruct: async (a) => { calls.push(a as never); return { accountId: a.accountId, ok: true, mode: "INCREMENTAL" }; },
      pending: async () => null,
      enqueue: async () => { throw new Error("enqueue after an incremental success"); },
      step: async (a) => { steps.push(a as never); return { accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_IN_PROGRESS" }; },
    };
    const r = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: "2026-01-01", windowToISO: TODAY, client: {} as never, deferFull: false, deps: { meter } }, impl);
    const arg = calls[0];
    check("flag off: the incremental path runs with deferFull (a fallback can never rebuild inline), the caller's meter, a FINITE deadline",
      calls.length === 1 && arg.deferFull === true && (arg.deps as { meter: unknown }).meter === meter
        && Number.isFinite((arg.deps as { deadlineMs?: number }).deadlineMs) && r.ok && steps.length === 0, JSON.stringify(arg));
    const queued: string[] = [];
    const fb = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: "2026-01-01", windowToISO: TODAY, client: {} as never, deferFull: false, deps: { meter } }, {
      ...impl, reconstruct: async (a) => ({ accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED", mode: "INCREMENTAL", fallbackReason: "NO_COVERAGE" }),
      enqueue: async (_c, id, reason) => { queued.push(`${id}:${reason}`); return true; } });
    check("…a fallback is QUEUED and ONE inline step runs on it, with the same bounded deps",
      queued.join() === "a1:NO_COVERAGE" && steps.length === 1 && (steps[0].deps as { meter: unknown }).meter === meter
        && Number.isFinite((steps[0].deps as { deadlineMs?: number }).deadlineMs) && fb.refusal === "FULL_REBUILD_IN_PROGRESS");
    calls.length = 0; steps.length = 0;
    await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: "2026-01-01", windowToISO: TODAY, client: {} as never, deferFull: false }, { ...impl, pending: async () => "IMPORTING" });
    check("…an owed rebuild skips the incremental path (it would only fall back) and takes one step", calls.length === 0 && steps.length === 1);
    const refresh = code(read("lib", "crypto", "wallet-history-refresh.ts"));
    check("the production ETH arm passes the gate, and only the gate",
      /key === ETH_NATIVE\.chain \? [^\n]*reconstructEthHistoryForSync\(\{ \.\.\.a, client: db, deferFull: ethWorkerEnabled\(\), deps: \{ meter \} \}\)/.test(refresh));
    const SYNC = code(read("lib", "crypto", "eth-history-sync.ts"));
    check("the deferral returns before ANY full-rebuild work (acquisition, finalized head, write)",
      SYNC.indexOf('"FULL_REBUILD_DEFERRED"') > 0 && SYNC.indexOf('"FULL_REBUILD_DEFERRED"') < SYNC.indexOf("finalizedBlockNumber(")
        && SYNC.indexOf('"FULL_REBUILD_DEFERRED"') < SYNC.indexOf("acquireEthHistory(") && SYNC.indexOf('"FULL_REBUILD_DEFERRED"') < SYNC.indexOf("$transaction"));
    check("…and only when asked (args.deferFull), so the default path is unchanged", /if \(args\.deferFull\) \{/.test(SYNC));
  }

  // ══ 3. FLAG ON — fallback ⇒ queued, nothing written ═══════════════════════
  {
    const seen: Array<Record<string, unknown>> = [];
    const queued: string[] = [];
    const impl: EthSyncImpl = {
      reconstruct: async (a) => { seen.push(a as never); return { accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED", mode: "INCREMENTAL", fallbackReason: "NO_COVERAGE" }; },
      pending: async () => null,
      enqueue: async (_c, id, reason) => { queued.push(`${id}:${reason}`); return true; },
      step: async () => { throw new Error("an inline step with the worker on"); },
    };
    const r = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: {} as never, deferFull: true }, impl);
    check("flag on: the incremental path runs with deferFull", seen.length === 1 && seen[0].deferFull === true);
    check("a fallback (here: a newly connected wallet, NO_COVERAGE) is queued with its reason", queued.join() === "a1:NO_COVERAGE", queued.join());
    check("…and the sync reports a refusal (nothing refreshed, nothing written)", !r.ok && r.refusal === "FULL_REBUILD_DEFERRED");

    seen.length = 0; queued.length = 0;
    const r2 = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: {} as never, deferFull: true },
      { ...impl, pending: async () => "IMPORTING" });
    check("while the worker owes the rebuild, the sync does not even try (no requests) and defers",
      seen.length === 0 && queued.length === 0 && r2.refusal === "FULL_REBUILD_DEFERRED" && /importing/.test(r2.reason ?? ""));

    const r3 = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: {} as never, deferFull: true },
      { ...impl, reconstruct: async (a) => ({ accountId: a.accountId, ok: true, mode: "INCREMENTAL", derivedRowsWritten: 2 }) });
    check("an incremental success is returned as-is (nothing queued)", r3.ok && r3.mode === "INCREMENTAL" && queued.length === 0);
  }

  // ══ 4. ENQUEUE — idempotent, never clobbers ═══════════════════════════════
  {
    let stored: string | null = null;
    const fake = {
      accountConnection: { findFirst: async () => ({ connectionId: "c1", connection: { credential: null, cursor: null } }) },
      $queryRaw: async () => [{ historyCheckpoint: stored }],
      $executeRaw: async (_s: TemplateStringsArray, next: string, _id: string, expected: string | null) => {
        if (stored !== expected) return 0; stored = next; return 1;
      },
    } as never;
    // casHistoryCheckpoint's template is (next, connectionId, expected) — the fake reads the same order.
    check("a first fallback queues", await enqueueEthHistoryBackfill(fake, "a1", "NO_COVERAGE", new Date(NOW_ISO)) && parseCheckpoint(stored, "a1")?.reason === "NO_COVERAGE");
    const first = stored;
    check("a second fallback while queued is a no-op (idempotent)", !(await enqueueEthHistoryBackfill(fake, "a1", "HISTORY_GAP")) && stored === first);
    stored = serializeCheckpoint({ ...queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO), completedAtISO: NOW_ISO, snapshotPendingFromISO: "2026-01-01" });
    check("after COMPLETE, a new fallback starts a fresh generation (keeping an owed regeneration)",
      await enqueueEthHistoryBackfill(fake, "a1", "VERSION_MISMATCH") && parseCheckpoint(stored, "a1")?.completedAtISO === null
        && parseCheckpoint(stored, "a1")?.reason === "VERSION_MISMATCH" && parseCheckpoint(stored, "a1")?.snapshotPendingFromISO === "2026-01-01");
    stored = serializeBtcCheckpoint(emptyBtcCheckpoint("a1", NOW_ISO));
    const btc = stored;
    check("a checkpoint that is not this account's ETH one is never overwritten", !(await enqueueEthHistoryBackfill(fake, "a1", "NO_COVERAGE")) && stored === btc);
  }

  // ══ 5. ACQUISITION RESUME (eth-history.ts cursor) ═════════════════════════
  {
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const whole = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD }, { transport: sim.transport });
    const first = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD }, { transport: sim.transport, probeBudget: 120 });
    check("a budget-bounded run stops with a PROVEN boundary and says why", first.cursor.stoppedBecause === "PROBE_BUDGET" && first.cursor.provenFromBlock! > EARLIEST_PROVABLE_BLOCK);
    const second = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD, cursor: first.cursor }, { transport: sim.transport, probeBudget: 100_000 });
    check("a resumed run continues BELOW the boundary and reaches the floor",
      second.cursor.reachedWindowStart && second.cursor.provenFromBlock === EARLIEST_PROVABLE_BLOCK && second.probesUsed < whole.probesUsed,
      `resumed probes ${second.probesUsed} vs whole ${whole.probesUsed}`);
    const together = [...first.changeBlocks, ...second.changeBlocks].sort((a, b) => a - b);
    check("…and the two runs' change blocks are exactly the whole run's (no gap, no overlap)",
      JSON.stringify(together) === JSON.stringify(whole.changeBlocks), `${together} vs ${whole.changeBlocks}`);
    check("…with a coverage reaching from the floor to the SAME anchor", second.coverage.kind === "COMPLETE" && whole.coverage.kind === "COMPLETE"
      && second.coverage.fromISO === whole.coverage.fromISO && second.coverage.toISO === whole.coverage.toISO && second.anchorBalanceWei === whole.anchorBalanceWei);
    const foreign = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD, cursor: { ...first.cursor, anchorBlock: HEAD - 5 } }, { transport: sim.transport });
    check("a cursor for a DIFFERENT anchor is ignored — the run is exactly the cursorless one",
      JSON.stringify(foreign.changeBlocks) === JSON.stringify(whole.changeBlocks) && foreign.probesUsed === whole.probesUsed && foreign.cursor.provenFromBlock === whole.cursor.provenFromBlock);
  }

  // ══ 6. THE WORKER STEP — resumes across PROBE_BUDGET, writes once ═════════
  {
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const status0 = ethStatusFromCursor(store.cursor, TODAY);
    check("a queued checkpoint reads QUEUED, with no licence claimed", status0?.state === "QUEUED" && status0.historyFromISO === null);
    const meter: Record<string, number> = {};
    const outcomes: string[] = [];
    const bounds: number[] = [];
    let maxStepProbes = 0;
    for (let i = 0; i < 20; i++) {
      const p0 = sim.chain.probes;
      const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 150, now: () => Date.parse(NOW_ISO), eth: { transport: sim.transport, meter } });
      maxStepProbes = Math.max(maxStepProbes, sim.chain.probes - p0);
      outcomes.push(o.stoppedBecause);
      if (store.cp()?.provenFromBlock) bounds.push(store.cp()!.provenFromBlock!);
      if (i === 0) {
        check("after the first step: IMPORTING, nothing written, the anchor pinned",
          o.stoppedBecause === "PROBE_BUDGET" && store.writes.length === 0 && ethStatusFromCursor(store.cursor, TODAY)?.state === "IMPORTING"
            && store.cp()?.anchorBlock === HEAD && ethStatusFromCursor(store.cursor, TODAY)?.historyFromISO === null);
      }
      if (o.stoppedBecause === "COMPLETE") break;
      // The head moves on while the import runs; one new movement lands after the anchor.
      if (i === 1) { sim.chain.head = HEAD + 2_000; sim.chain.events.push({ block: HEAD + 1_500, delta: ETH(0.5) }); }
    }
    check("several bounded steps, then COMPLETE", outcomes.length > 2 && outcomes.at(-1) === "COMPLETE" && outcomes.slice(0, -1).every((x) => x === "PROBE_BUDGET"), outcomes.join(","));
    check("the proven boundary only ever moves DOWN — a PROBE_BUDGET stop resumes, never restarts",
      bounds.every((b, i) => i === 0 || b <= bounds[i - 1]), bounds.join(","));
    check("rows are written exactly ONCE, at completion", store.writes.length === 1);
    check("EVERY step — including the completing one — stays within ONE probe budget", maxStepProbes <= 150, `max ${maxStepProbes}`);
    const w = store.writes[0];
    const expectedFinal = sim.stateAt(HEAD + 2_000).balance;
    check("…anchored at the CURRENT head: the movement after the original anchor is included",
      w.anchorBalanceWei === expectedFinal && w.movements.some((m) => m.baseUnitsDelta === ETH(0.5)), `${w.anchorBalanceWei} vs ${expectedFinal}`);
    check("…and the movements reconcile to it in exact wei", reconcileMovementsAgainstBalance(w.movements, w.anchorBalanceWei).reconciles);
    check("…every change block found once (no double count across resumed steps)",
      new Set(w.movements.map((m) => `${m.eventId}#${m.movementKey}`)).size === w.movements.length && w.movements.length >= EVENTS.length + 1);
    check("…under a licence from the provable floor to the new head", w.coverage.kind === "COMPLETE" && w.coverage.toISO === "2026-10-27"
      && w.coverage.fromISO === new Date((T_HEAD - (HEAD - EARLIEST_PROVABLE_BLOCK) * 12) * 1000).toISOString().slice(0, 10), `${w.coverage.kind === "COMPLETE" ? w.coverage.fromISO : ""}`);
    const done = ethStatusFromCursor(store.cursor, TODAY)!;
    check("the checkpoint is COMPLETE, the movements moved into the rows (count kept), usage recorded",
      done.state === "COMPLETE" && w.coverage.kind === "COMPLETE" && done.historyFromISO === w.coverage.fromISO && store.cp()!.movements.length === 0
        && done.movementsFound === w.movements.length && done.requestsToday === Object.values(meter).reduce((a, b) => a + b, 0),
      JSON.stringify({ s: done.state, r: done.requestsToday, m: Object.values(meter).reduce((a, b) => a + b, 0) }));

    // Idempotent re-run: nothing to do, nothing sent, nothing written.
    const callsBefore = sim.chain.calls;
    const again = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 150, eth: { transport: sim.transport } });
    check("a re-run after COMPLETE does nothing (no requests, no write)", again.stoppedBecause === "SKIPPED" && sim.chain.calls === callsBefore && store.writes.length === 1);
    check("…and the worker no longer lists it", orderEthCandidates([{ accountId: "a1", connectionId: "c1", cursor: store.cursor, checkpoint: store.cp() }], Date.parse(NOW_ISO)).length === 0);
  }

  // ══ 7. FAILURES ═══════════════════════════════════════════════════════════
  {
    // A contract / delegated account: refused, paused for a day, nothing written.
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD, code: "0xef0100aa" });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 150, now: () => Date.parse(NOW_ISO), eth: { transport: sim.transport } });
    const st = ethStatusFromCursor(store.cursor, TODAY)!;
    check("a non-EOA fails with PROOF_PREMISES_UNMET, FAILED, retried in a day, nothing written",
      o.failure?.code === "PROOF_PREMISES_UNMET" && st.state === "FAILED" && st.failures >= MAX_CONSECUTIVE_FAILURES
        && st.nextAutomaticRetryISO === "2026-10-29T10:00:00.000Z" && store.writes.length === 0);
    const paused = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 150, now: () => Date.parse(NOW_ISO) + 3600_000, eth: { transport: sim.transport } });
    check("…and an automatic run inside the pause does nothing", paused.stoppedBecause === "SKIPPED");

    // A provider outage keeps the proof progress.
    const ok = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const s2 = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    await runEthHistoryBackfill({ accountId: "a1", store: s2, todayISO: TODAY }, { probeBudget: 150, eth: { transport: ok.transport } });
    const bound = s2.cp()!.provenFromBlock;
    const down: EthRpcTransport = async () => { throw new Error("ECONNRESET"); };
    const o2 = await runEthHistoryBackfill({ accountId: "a1", store: s2, todayISO: TODAY }, { probeBudget: 150, eth: { transport: down } });
    check("a provider failure is a coded failure that KEEPS the proven boundary",
      o2.failure?.code === "PROVIDER_FAILED" && s2.cp()!.provenFromBlock === bound && s2.cp()!.failures === 1 && s2.writes.length === 0);

    // A chunk too dense for the budget: the chunk shrinks instead of stalling.
    const dense = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const busy = simulate({ events: Array.from({ length: 40 }, (_, k) => ({ block: HEAD - 1_000 - k * 997, delta: ETH(0.01) })), head: HEAD, headTimeSec: T_HEAD });
    const o3 = await runEthHistoryBackfill({ accountId: "a1", store: dense, todayISO: TODAY }, { probeBudget: 20, eth: { transport: busy.transport } });
    check("a step that closes no chunk halves the chunk (never below the floor) and defers",
      o3.stoppedBecause === "PROBE_BUDGET" && dense.cp()!.chunkBlocks === 25_000 && dense.cp()!.chunkBlocks >= MIN_ETH_CHUNK_BLOCKS && dense.writes.length === 0);

    // A CAS lost to a concurrent writer: nothing is claimed.
    const racing = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    racing.casCursor = async () => false;
    const o4 = await runEthHistoryBackfill({ accountId: "a1", store: racing, todayISO: TODAY }, { probeBudget: 150, eth: { transport: ok.transport } });
    check("a lost compare-and-swap reports CONFLICT and writes nothing", o4.stoppedBecause === "CONFLICT" && racing.writes.length === 0);

    check("no checkpoint ⇒ NOT_QUEUED, no requests",
      (await runEthHistoryBackfill({ accountId: "a1", store: new MemoryStore(null), todayISO: TODAY }, { probeBudget: 150, eth: { transport: down } })).stoppedBecause === "NOT_QUEUED");
  }

  // ══ 8. THE JOB'S ETH PASS — shared Alchemy cap, locks, flag ═══════════════
  {
    const solCfg = { ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }), dailyRequestCap: 10_000 };
    const btcCfg = { ...btcWorkerConfig({}), enabled: false };
    const ethCfg = ethWorkerConfig({ SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true", ETH_BACKFILL_PROBE_BUDGET: "150" });
    let t = Date.parse(NOW_ISO);
    const locks = new Map<string, number>();
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    const ledger: Record<string, number> = {};
    const log: string[] = [];
    const base: SolBackfillJobDeps = {
      now: () => t, sleep: async (ms) => { t += ms; }, wakeStartedAt: async () => null,
      wallets: async () => [],
      claimLock: async (cId, s) => { if (locks.has(cId)) return false; locks.set(cId, s); return true; },
      renewLock: async (cId, f, to) => { if (locks.get(cId) !== f) return false; locks.set(cId, to); return true; },
      releaseLock: async (cId, s) => { if (locks.get(cId) === s) locks.delete(cId); },
      reconstruct: async () => { throw new Error("no SOL work"); },
      store: async () => null,
      regenerationEnabled: () => true,
      regenerate: async (id, from) => { log.push(`regen:${id}:${from}`); },
      providerUsageToday: async () => ({ solana: 0, other: Object.values(ledger).reduce((a, b) => a + b, 0) }),
      eth: {
        wallets: async () => [{ accountId: "a1", connectionId: "c1", cursor: store.cursor }],
        reconstruct: async ({ accountId, todayISO, deps }) => { log.push(`eth:${deps.probeBudget}`); return runEthHistoryBackfill({ accountId, store, todayISO }, { ...deps, eth: { ...deps.eth, transport: sim.transport } }); },
        store: async () => store,
        recordUsage: async (meter, flushed) => { for (const [k, v] of Object.entries(meter)) { const d = v - (flushed[k] ?? 0); if (d > 0) { ledger[k] = (ledger[k] ?? 0) + d; flushed[k] = v; } } },
      },
    };
    const off = await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: { ...ethCfg, enabled: false },
      deps: { ...base, eth: { ...base.eth!, wallets: async () => { throw new Error("listed with the flag off"); } } } });
    check("flag off: the job never lists ETH wallets and reports no ETH pass", off.eth === undefined && off.stoppedBecause === "NO_WORK");

    const s = await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg, deps: base });
    check("flag on: the queued ETH wallet runs one bounded step under its lock (released)",
      s.eth?.walletsRun === 1 && log[0] === `eth:${ethCfg.probeBudget}` && locks.size === 0 && store.cp()!.provenFromBlock !== null, JSON.stringify(s.eth));
    check("…its requests are recorded on the shared Alchemy ledger, exactly once each",
      Object.values(ledger).reduce((a, b) => a + b, 0) === s.eth?.requests.total && s.eth.requests.total > 0, `${JSON.stringify(ledger)} vs ${s.eth?.requests.total}`);
    check("…and the job self-continues while the import is unfinished", s.deferred >= 1 && (s.eth?.deferred ?? 0) >= 1);

    log.length = 0;
    const capped = await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg,
      deps: { ...base, providerUsageToday: async () => ({ solana: 6_000, other: 3_990 }) } });
    check("the SHARED Alchemy cap (Solana + Ethereum calls today) defers the pass: DAILY_CAP, nothing runs",
      capped.eth?.stoppedBecause === "DAILY_CAP" && capped.eth.walletsRun === 0 && log.length === 0 && capped.eth.dailyRequestsUsedBefore === 9_990, JSON.stringify(capped.eth));
    check("…and the step's probe budget never exceeds what the allowance pays for",
      capped.eth?.eligible === 1 && probeBudgetFor(10_000 - 9_990, 1_500) === 0 && probeBudgetFor(616, 1_500) === 150 && probeBudgetFor(1e9, 1_500) === 1_500);

    // Run to completion: the rows trigger a regeneration over what changed.
    for (let i = 0; i < 40 && !store.cp()!.completedAtISO; i++) await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg, deps: base });
    check("the job carries the wallet to COMPLETE and regenerates wealth history from the impacted date",
      !!store.cp()!.completedAtISO && store.writes.length === 1 && log.some((l) => l.startsWith("regen:a1:")), log.filter((l) => l.startsWith("regen")).join(","));
    const idle = await solHistoryBackfill({ config: solCfg, btcConfig: btcCfg, ethConfig: ethCfg, deps: base });
    check("…after which a wake is NO_WORK (idempotent)", idle.stoppedBecause === "NO_WORK" && idle.eth?.stoppedBecause === "NO_WORK" && store.writes.length === 1);
  }

  // ══ 9. STATUS — same vocabulary, each chain in its own words ══════════════
  {
    const q = serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO));
    const eth = walletHistoryCheckpointStatus(null, q, TODAY);
    check("ETH on historyCheckpoint ⇒ chain ETH, QUEUED, signatures 0, movements counted",
      eth?.chain === "ETH" && eth.state === "QUEUED" && eth.signaturesProcessed === 0 && eth.processed.unit === "movements");
    const importing = serializeCheckpoint({ ...queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO), provenFromBlock: 20_000_000, provenFromISO: "2024-06-01", anchorBlock: HEAD });
    check("proof progress ⇒ IMPORTING, still no licence claimed", backfillStatus(parseCheckpoint(importing, "a1")!).state === "IMPORTING"
      && walletHistoryCheckpointStatus(null, importing, TODAY)?.historyFromISO === null);
    const btc = walletHistoryCheckpointStatus(null, serializeBtcCheckpoint(emptyBtcCheckpoint("b1", NOW_ISO)), TODAY);
    check("BTC on historyCheckpoint ⇒ chain BTC, its own state, transactions counted", btc?.chain === "BTC" && btc.state === "QUEUED" && btc.processed.unit === "transactions");
    const sol = walletHistoryCheckpointStatus(serializeSolCheckpoint(emptySolCheckpoint("s1", "addr", NOW_ISO)), null, TODAY);
    check("SOL on cursor ⇒ chain SOL, signatures", sol?.chain === "SOL" && sol.processed.unit === "signatures");
    check("nothing (or garbage) ⇒ null: no claim", walletHistoryCheckpointStatus(null, null, TODAY) === null
      && walletHistoryCheckpointStatus("{discovery:1}", "not json", TODAY) === null && !isEthBackfillCursor(serializeBtcCheckpoint(emptyBtcCheckpoint("b1", NOW_ISO))));
    check("the ETH parser rejects another account's checkpoint", parseCheckpoint(q, "someone-else") === null);
    check("historyWorkerEnabled is per chain",
      historyWorkerEnabledFor("SOL", { SOL_BACKFILL_ENABLED: "true" }) && historyWorkerEnabledFor("BTC", { SOL_BACKFILL_ENABLED: "true" })
        && !historyWorkerEnabledFor("BTC", { SOL_BACKFILL_ENABLED: "true", BTC_BACKFILL_ENABLED: "false" })
        && !historyWorkerEnabledFor("ETH", { SOL_BACKFILL_ENABLED: "true" }) && historyWorkerEnabledFor("ETH", { SOL_BACKFILL_ENABLED: "true", ETH_BACKFILL_ENABLED: "true" })
        && !historyWorkerEnabledFor("BNB", { SOL_BACKFILL_ENABLED: "true" }));
    const sd = code(read("lib", "connections", "space-data.ts"));
    check("Connections reads every chain's checkpoint and gates per chain",
      /walletHistoryCheckpointStatus\(/.test(sd) && /historyWorkerEnabledFor\(chain\)/.test(sd) && !/SOL_BACKFILL_ENABLED/.test(sd));
    check("Platform Ops reads the same", /walletHistoryCheckpointStatus\(/.test(code(read("lib", "platform", "connection-diagnostics.ts"))));
  }

  // ══ 10. A HISTORY THAT CANNOT RECONCILE IS BOUNDED ═════════════════════════
  {
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    let attempts = 0;
    store.complete = async () => { attempts++; return { accountId: "a1", ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE", reason: "residual 1 wei" }; };
    let t = Date.parse(NOW_ISO);
    const states: string[] = [];
    let pausedOk = true;
    for (let i = 0; i < 200; i++) {
      const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 400, now: () => t, eth: { transport: sim.transport } });
      if (o.stoppedBecause === "FAILED") {
        states.push(ethStatusFromCursor(store.cursor, TODAY)!.state);
        const soon = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 400, now: () => t + 3600_000, eth: { transport: sim.transport } });
        pausedOk = pausedOk && soon.stoppedBecause === "SKIPPED";
        t += 25 * 3600_000; // the daily pause elapses
      }
      if (ethStatusFromCursor(store.cursor, TODAY)!.state === "RECOVERY_REQUIRED") break;
    }
    check("a reconciliation failure restarts AND pauses for a day (FAILED), never resets to a daily re-proof",
      states[0] === "FAILED" && pausedOk, states.join(","));
    check("…and after MAX_RECONCILE_FAILURES full proofs it stops for an operator (RECOVERY_REQUIRED)",
      attempts === 3 && states.at(-1) === "RECOVERY_REQUIRED" && store.cp()!.reconcileFailures === 3, `${attempts} ${states.join(",")}`);
    const callsBefore = sim.chain.calls;
    const after = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 400, now: () => t + 30 * 86_400_000, eth: { transport: sim.transport } });
    check("…after which no automatic run sends a request", after.stoppedBecause === "SKIPPED" && sim.chain.calls === callsBefore
      && orderEthCandidates([{ accountId: "a1", connectionId: "c1", cursor: store.cursor, checkpoint: store.cp() }], t).length === 0);

    // A wallet that held ETH at the provable floor: refused honestly, before any write.
    const pre = simulate({ events: [{ block: 4_000_000, delta: ETH(1) }, ...EVENTS], head: HEAD, headTimeSec: T_HEAD });
    const s2 = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    let last = "";
    for (let i = 0; i < 20 && last !== "FAILED"; i++) {
      last = (await runEthHistoryBackfill({ accountId: "a1", store: s2, todayISO: TODAY }, { probeBudget: 400, eth: { transport: pre.transport } })).stoppedBecause;
    }
    const st = ethStatusFromCursor(s2.cursor, TODAY)!;
    check("a balance already held at the provable floor ⇒ BALANCE_BEFORE_PROVABLE_FLOOR, RECOVERY_REQUIRED, nothing written",
      st.state === "RECOVERY_REQUIRED" && st.lastFailureCode === "BALANCE_BEFORE_PROVABLE_FLOOR" && s2.writes.length === 0, JSON.stringify(st));
  }

  // ══ 11. A FORWARD GAP LARGER THAN ONE BUDGET COMPLETES OVER SEVERAL RUNS ═══
  {
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    for (let i = 0; i < 20 && !store.cp()!.reachedFloor; i++) {
      await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 400, eth: { transport: sim.transport } });
    }
    check("(setup) the backward proof reached the floor without writing", store.cp()!.reachedFloor && store.writes.length === 0);
    // The head moves far on, through a busy stretch: many more changes than one budget proves.
    const busy = Array.from({ length: 60 }, (_, k) => ({ block: HEAD + 1_000 + k * 4_999, delta: ETH(0.001 * (k + 1)) }));
    sim.chain.events.push(...busy);
    sim.chain.events.sort((a, b) => a.block - b.block);
    sim.chain.head = HEAD + 320_000;
    const outcomes: string[] = [];
    let sawForwardProgress = false;
    let maxStepProbes = 0;
    for (let i = 0; i < 60; i++) {
      const p0 = sim.chain.probes;
      const o = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 120, eth: { transport: sim.transport } });
      maxStepProbes = Math.max(maxStepProbes, sim.chain.probes - p0);
      outcomes.push(o.stoppedBecause);
      if (store.cp()!.forward?.provenFromBlock) sawForwardProgress = true;
      if (o.stoppedBecause === "COMPLETE" || o.stoppedBecause === "FAILED") break;
    }
    const w = store.writes[0];
    check("the gap is proven over several runs, its progress persisted (never retried from scratch)",
      outcomes.at(-1) === "COMPLETE" && outcomes.length > 2 && sawForwardProgress, outcomes.join(","));
    check("…each run within one budget", maxStepProbes <= 120, `max ${maxStepProbes}`);
    check("…and the single write holds every movement, reconciling to the new head exactly",
      store.writes.length === 1 && w.anchorBalanceWei === sim.stateAt(HEAD + 320_000).balance
        && reconcileMovementsAgainstBalance(w.movements, w.anchorBalanceWei).reconciles // (an outbound transfer is two movements — value and fee — so ≥ one per event, each exactly once)
        && w.movements.length >= EVENTS.length + busy.length && new Set(w.movements.map((m) => `${m.eventId}#${m.movementKey}`)).size === w.movements.length
        && busy.every((b) => w.movements.some((m) => m.baseUnitsDelta === b.delta)),
      `${w?.movements.length} movements`);
  }

  // ══ 12. CONNECTIONS SHOWS AN INCOMPLETE ETH CHECKPOINT WHATEVER THE FLAG ═
  {
    const sd = code(read("lib", "connections", "space-data.ts"));
    check("Connections no longer hides an ETH checkpoint's state while the ETH worker is off (syncs advance it now)",
      !/found\.chain !== "ETH"/.test(sd) && !/historyWorkerEnabledFor\("ETH"\)/.test(sd));
  }

  // ══ 13. THE PRODUCTION STORE: CAS IN THE WRITE TRANSACTION ════════════════
  {
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const acq = await acquireEthHistory({ ownerAddress: OWNER, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: HEAD }, { transport: sim.transport });
    const world = { cursor: serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)) as string | null, rows: [] as unknown[], coverage: null as unknown };
    const cas = (box: { cursor: string | null }) => async (_s: TemplateStringsArray, next: string, _id: string, expected: string | null) => {
      if (box.cursor !== expected) return 0; box.cursor = next; return 1; };
    const fakeDb = {
      financialAccount: { findUnique: async () => ({ walletChain: "ETH", walletAddress: OWNER, deletedAt: null }) },
      accountConnection: { findFirst: async () => ({ connectionId: "c1", connection: { credential: null, cursor: null } }) },
      instrumentAlias: { findUnique: async () => ({ instrumentId: "inst-eth" }) },
      positionObservation: {
        findFirst: async () => ({ id: "obs-1", date: new Date("2026-10-27T12:00:00Z"), origin: "OBSERVED", completeness: null }),
        findMany: async () => [],
      },
      $queryRaw: async () => [{ historyCheckpoint: world.cursor }],
      $executeRaw: cas(world),
      async $transaction(fn: (tx: unknown) => Promise<void>) {
        // Staged, applied only if the callback resolves — a throw is a rollback.
        const staged = { cursor: world.cursor, rows: [] as unknown[], coverage: null as unknown };
        const tx = {
          positionObservation: { deleteMany: async () => ({ count: 0 }), createMany: async (a: { data: unknown[] }) => { staged.rows.push(...a.data); return { count: a.data.length }; } },
          positionCoverage: { upsert: async (a: unknown) => { staged.coverage = a; return a; } },
          $executeRaw: cas(staged),
        };
        await fn(tx);
        world.cursor = staged.cursor; world.rows = staged.rows; world.coverage = staged.coverage;
      },
    } as never;
    const bound = await prismaEthBackfillStore("a1", fakeDb);
    const coverage = acq.coverage as ChainCoverage & { kind: "COMPLETE" };
    const args = { movements: acq.movements, coverage, anchorBalanceWei: acq.anchorBalanceWei!, fallbackReason: "NO_COVERAGE" as const, windowToISO: TODAY };
    const lost = world.cursor;
    let conflict = false;
    try { await bound!.store.complete({ ...args, expectedCursor: "not-the-stored-value", nextCursor: "next" }); }
    catch (e) { conflict = e instanceof EthCheckpointConflictError; }
    check("a lost checkpoint CAS inside the write throws CONFLICT and ROLLS BACK: no rows, no licence, cursor unchanged",
      conflict && world.rows.length === 0 && world.coverage === null && world.cursor === lost);
    const done = serializeCheckpoint({ ...queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO), completedAtISO: NOW_ISO });
    const r = await bound!.store.complete({ ...args, expectedCursor: lost!, nextCursor: done });
    check("…and a won CAS commits rows, licence and checkpoint together", r.ok && world.rows.length > 0 && world.coverage !== null && world.cursor === done,
      JSON.stringify({ ok: r.ok, refusal: r.refusal, rows: world.rows.length }));
  }

  // ══ 14. RECOVERY_REQUIRED IS NOT A DEAD END ═══════════════════════════════
  {
    const recovered = serializeCheckpoint({ ...queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO), failures: MAX_CONSECUTIVE_FAILURES,
      lastFailure: { code: "BALANCE_BEFORE_PROVABLE_FLOOR", atISO: NOW_ISO }, recovery: { code: "BALANCE_BEFORE_PROVABLE_FLOOR", atISO: NOW_ISO } });
    let stored: string | null = recovered;
    const fake = {
      accountConnection: { findFirst: async () => ({ connectionId: "c1", connection: { credential: null, cursor: null } }) },
      $queryRaw: async () => [{ historyCheckpoint: stored }],
      $executeRaw: async (_s: TemplateStringsArray, next: string, _id: string, expected: string | null) => { if (stored !== expected) return 0; stored = next; return 1; },
    } as never;
    check("RECOVERY_REQUIRED is not 'owed' to the worker (the worker will never run it on its own)", (await ethHistoryPending(fake, "a1")) === null);
    stored = serializeCheckpoint({ ...queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO), provenFromBlock: 20_000_000, anchorBlock: HEAD });
    check("…while QUEUED / IMPORTING still are", (await ethHistoryPending(fake, "a1")) === "IMPORTING");
    stored = recovered;
    const ran: string[] = [];
    const r = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: fake, deferFull: true }, {
      reconstruct: async (a) => { ran.push(String(a.deferFull)); return { accountId: a.accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED", mode: "INCREMENTAL", fallbackReason: "NO_COVERAGE" }; },
      pending: ethHistoryPending, enqueue: enqueueEthHistoryBackfill, step: async () => { throw new Error("an inline step with the worker on"); },
    });
    check("flag on + RECOVERY_REQUIRED: the sync runs the INCREMENTAL path (not skipped)", ran.join() === "true");
    check("…and its fallback does NOT re-queue the wallet automatically (checkpoint unchanged, nothing written)",
      stored === recovered && r.refusal === "FULL_REBUILD_DEFERRED");
    const ok = await reconstructEthHistoryForSync({ accountId: "a1", windowFromISO: TODAY, windowToISO: TODAY, client: fake, deferFull: true }, {
      reconstruct: async (a) => ({ accountId: a.accountId, ok: true, mode: "INCREMENTAL", derivedRowsWritten: 3 }),
      pending: ethHistoryPending, enqueue: enqueueEthHistoryBackfill, step: async () => { throw new Error("an inline step with the worker on"); },
    });
    check("…so a wallet whose stored history still verifies keeps refreshing incrementally", ok.ok && ok.mode === "INCREMENTAL");

    // The operator exit: `resume`, the lever SOL and BTC expose — never set automatically.
    const sim = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const store = new MemoryStore(recovered);
    const auto = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY }, { probeBudget: 150, now: () => Date.parse(NOW_ISO) + 90 * 86_400_000, eth: { transport: sim.transport } });
    check("an automatic run never touches a RECOVERY_REQUIRED wallet, however much later", auto.stoppedBecause === "SKIPPED" && store.cursor === recovered);
    const resumed = await runEthHistoryBackfill({ accountId: "a1", store, todayISO: TODAY, resume: true }, { probeBudget: 150, eth: { transport: sim.transport } });
    const st = ethStatusFromCursor(store.cursor, TODAY)!;
    check("an operator resume clears the recovery and restarts the proof (a fresh generation, IMPORTING)",
      resumed.stoppedBecause === "PROBE_BUDGET" && st.state === "IMPORTING" && store.cp()!.recovery === null && store.cp()!.reconcileFailures === 0);
    const src = code(read("jobs", "sol-history-backfill.ts")) + code(read("lib", "crypto", "wallet-history-refresh.ts"));
    check("…and no automatic path passes resume", !/resume: true/.test(src));

    // WALL-CLOCK BOUND: a slow provider (every JSON-RPC call costs 1 s here)
    // cannot stretch a step past its deadline, whatever the probe budget.
    {
      const sim3 = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
      const clock = { t: Date.parse(NOW_ISO) };
      const slow: typeof sim3.transport = async (body) => { clock.t += (Array.isArray(body) ? body.length : 1) * 1_000; return sim3.transport(body); };
      const timed = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
      const t0 = clock.t;
      const o3 = await runEthHistoryBackfill({ accountId: "a1", store: timed, todayISO: TODAY },
        { probeBudget: 4_000, now: () => clock.t, deadlineMs: t0 + 60_000, eth: { transport: slow, batchSize: 3 } });
      const overrun = clock.t - (t0 + 60_000);
      // After the stop, only the evidence for changes ALREADY proven is read (≤ 2 calls each) — never another probe.
      check("a 4,000-probe step on a slow provider stops at its deadline, not at its probe budget (no probe after it; only evidence for what was proven)",
        o3.stoppedBecause === "PROBE_BUDGET" && overrun <= 10_000 && sim3.chain.probes < 100, `overrun ${overrun} ms, probes ${sim3.chain.probes}`);
    }

    // CLOCK STOPS MUST STILL MAKE PROGRESS: a step too short to close even one
    // chunk halves the chunk (as density does) and records the calls it spent,
    // so a slow provider shrinks the chunk until steps close; and a wallet that
    // cannot close even the minimum chunk reaches FAILED instead of spending budget for ever.
    {
      const run = async (stepMs: number) => {
        const sim4 = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
        const clock = { t: Date.parse(NOW_ISO) };
        const slow: typeof sim4.transport = async (body) => { clock.t += (Array.isArray(body) ? body.length : 1) * 1_000; return sim4.transport(body); };
        const st = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
        const chunks: number[] = []; const stops: string[] = [];
        for (let i = 0; i < 40; i++) {
          const o = await runEthHistoryBackfill({ accountId: "a1", store: st, todayISO: TODAY },
            { probeBudget: 4_000, now: () => clock.t, deadlineMs: clock.t + stepMs, eth: { transport: slow, batchSize: 3 } });
          stops.push(o.stoppedBecause); chunks.push(st.cp()!.chunkBlocks);
          if (st.cp()!.provenFromBlock !== null || ethStatusFromCursor(st.cursor, TODAY)?.state === "FAILED") break;
          clock.t += 3_600_000; // the next run
        }
        return { st, chunks, stops };
      };
      // 30 s per step at 1 s per call: the default 50,000-block chunk cannot close; smaller ones can.
      const a = await run(30_000);
      check("every clock-stopped step halves the chunk (never retries the same one)", a.chunks.length > 1 && a.chunks.slice(0, -1).every((c, i) => i === 0 || c < a.chunks[i - 1]), a.chunks.join(","));
      check("…and the wallet eventually progresses (a chunk closes, proof boundary set)", a.st.cp()!.provenFromBlock !== null, `${a.stops.join(",")} / ${a.chunks.join(",")}`);
      check("…every step's calls are recorded on the checkpoint (usage is true)", (a.st.cp()!.usage?.requests ?? 0) > 0);
      // 3 s per step: not even the minimum chunk closes — escalate honestly.
      const b = await run(3_000);
      check("a step that cannot close even the minimum chunk escalates to FAILED (pauses) instead of spending for ever",
        ethStatusFromCursor(b.st.cursor, TODAY)?.state === "FAILED" && b.chunks.at(-1) === MIN_ETH_CHUNK_BLOCKS, `${b.stops.join(",")} / ${b.chunks.join(",")}`);
    }

    // A FAILED streak alone (transient provider failures) keeps the proof: the
    // operator resume clears the pause and continues BELOW the stored boundary.
    const sim2 = simulate({ events: EVENTS, head: HEAD, headTimeSec: T_HEAD });
    const partial = new MemoryStore(serializeCheckpoint(queuedCheckpoint("a1", "NO_COVERAGE", NOW_ISO)));
    await runEthHistoryBackfill({ accountId: "a1", store: partial, todayISO: TODAY }, { probeBudget: 150, now: () => Date.parse(NOW_ISO), eth: { transport: sim2.transport } });
    const proven = partial.cp();
    const failedCp: EthBackfillCheckpoint = { ...proven!, failures: MAX_CONSECUTIVE_FAILURES, lastFailure: { code: "PROVIDER_FAILED", atISO: NOW_ISO, detail: "timeout" } };
    partial.cursor = serializeCheckpoint(failedCp);
    check("a transient-failure streak reads FAILED", ethStatusFromCursor(partial.cursor, TODAY)?.state === "FAILED" && proven!.provenFromBlock !== null);
    const res2 = await runEthHistoryBackfill({ accountId: "a1", store: partial, todayISO: TODAY, resume: true }, { probeBudget: 150, now: () => Date.parse(NOW_ISO), eth: { transport: sim2.transport } });
    const kept = partial.cp()!;
    check("an operator resume of FAILED keeps the proof: same anchor, the boundary moves strictly BELOW the stored one (no restart), movements kept, pause cleared",
      res2.stoppedBecause !== "FAILED" && kept.anchorBlock === proven!.anchorBlock && (kept.reachedFloor || kept.provenFromBlock! < proven!.provenFromBlock!)
        && kept.movements.length >= proven!.movements.length && kept.failures === 0 && kept.lastFailure === null,
      JSON.stringify({ stop: res2.stoppedBecause, a: kept.anchorBlock, p: kept.provenFromBlock, p0: proven!.provenFromBlock }));

    // Honest, failure-specific copy.
    check("RECOVERY_REQUIRED for a balance before the provable floor says exactly that",
      /held ETH before the earliest block we can verify/.test(historyImportText("RECOVERY_REQUIRED", true, "BALANCE_BEFORE_PROVABLE_FLOOR")?.text ?? ""));
    check("…a non-reconciling one says it does not add up",
      /doesn’t add up/.test(historyImportText("RECOVERY_REQUIRED", true, "LEDGER_DOES_NOT_RECONCILE")?.text ?? ""));
    check("…and SOL/BTC continuity recoveries keep their wording",
      historyImportText("RECOVERY_REQUIRED", true, "GAP_DETECTED")?.text === "Needs attention — a gap was found"
        && historyImportText("RECOVERY_REQUIRED", true)?.text === "Needs attention — a gap was found");
    check("the detail view passes the failure code through",
      /historyImportText\(wh\?\.historyImport\?\.state, i\?\.facts\?\.historyWorkerEnabled === true, wh\?\.historyImport\?\.lastFailureCode\)/.test(read("lib", "connections", "connection-detail.core.ts")));
  }

  console.log(`\neth-history-backfill: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
