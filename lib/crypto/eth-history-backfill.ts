/**
 * lib/crypto/eth-history-backfill.ts
 *
 * One bounded, resumable step of the Ethereum FULL rebuild, as the history
 * worker runs it (decisions and checkpoint: eth-history-backfill.core.ts).
 *
 *   BACKWARD   prove right-to-left from the checkpoint's finalized anchor,
 *              within the step's probe budget, resuming at the proven
 *              boundary (eth-history.ts cursor). Movements proven so far are
 *              kept in the checkpoint, in exact wei. Nothing is written.
 *   FORWARD    once the proof reaches the provable floor (a step ends there):
 *              prove the gap from the anchor to a newer finalized head — also
 *              resumable, with its own boundary and chunk halving. When it
 *              closes (its opening balance must equal the stored anchor
 *              balance, exactly) the anchor ADVANCES to that head.
 *   COMPLETE   when the anchor was read in THIS step (so it is as fresh as an
 *              inline rebuild's), hand every
 *              movement and the closed licence to the SAME persistence the
 *              inline rebuild uses — reconcile in wei, replay, write rows and
 *              licence — with the checkpoint's compare-and-swap in the same
 *              transaction.
 *
 * The proof itself (EOA premise, emptiness, wei handling) is eth-history.ts's
 * and is not re-decided here. Never throws: a provider failure is a coded
 * failure on the checkpoint; proof progress survives it.
 */

import type { ChainCoverage, ChainMovement } from "./chain-movement";
import {
  acquireEthHistory, finalizedBlockNumber, EARLIEST_PROVABLE_BLOCK, ETH_HISTORY_SOURCE, type EthHistoryDeps,
} from "./eth-history";
import type { EthHistoryResult } from "./eth-history-sync";
import type { EthIncrementalFallback } from "./eth-history-incremental";
import { meterTotal } from "@/lib/usage/provider-budget.core";
import {
  parseCheckpoint, serializeCheckpoint, shouldRunAutomatically, backfillStatus, restartGeneration, mergeMovements,
  storeMovement, loadMovement, addUsage, DEFAULT_ETH_CHUNK_BLOCKS, MIN_ETH_CHUNK_BLOCKS, MAX_CONSECUTIVE_FAILURES,
  MAX_RECONCILE_FAILURES,
  type EthBackfillCheckpoint, type EthBackfillFailureCode, type EthBackfillStatus, type EthForwardSegment,
} from "./eth-history-backfill.core";

export class EthCheckpointConflictError extends Error {
  constructor() { super("ETH history checkpoint changed underneath this run"); }
}

/** What a step reads and writes. Injectable: every path is testable without a database. */
export interface EthBackfillStore {
  walletAddress: string;
  readCursor(): Promise<string | null>;
  /** Compare-and-swap the checkpoint alone (progress, failures). */
  casCursor(expected: string | null, next: string): Promise<boolean>;
  /**
   * The completing write: rows + licence + the checkpoint CAS in ONE
   * transaction (persistEthFullHistory). A refusal writes nothing. Throws
   * EthCheckpointConflictError when the CAS loses (the rows roll back).
   */
  complete(args: {
    expectedCursor: string; nextCursor: string; movements: ChainMovement[];
    coverage: ChainCoverage & { kind: "COMPLETE" }; anchorBalanceWei: bigint;
    fallbackReason: EthIncrementalFallback; windowToISO: string;
  }): Promise<EthHistoryResult>;
}

export interface EthBackfillDeps {
  /** Blocks probed this step (from the worker's budget and the shared allowance). */
  /** Blocks probed this step, across EVERY segment it proves (one budget per step). */
  probeBudget: number;
  now?: () => number;
  /** Do not start another segment after this instant (the worker's per-wallet time budget). */
  deadlineMs?: number;
  /** Transport, meter, batch size… handed to the acquisition. `meter` counts every call. */
  eth?: EthHistoryDeps;
}

export interface EthBackfillOutcome {
  stoppedBecause: "NOT_QUEUED" | "SKIPPED" | "PROBE_BUDGET" | "COMPLETE" | "FAILED" | "CONFLICT";
  status: EthBackfillStatus | null;
  rowsWritten: number;
  impactedFromISO: string | null;
  failure: { code: EthBackfillFailureCode; detail: string } | null;
  /** JSON-RPC calls this step sent. */
  requests: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runEthHistoryBackfill(
  args: { accountId: string; store: EthBackfillStore; todayISO: string },
  deps: EthBackfillDeps,
): Promise<EthBackfillOutcome> {
  const { accountId, store } = args;
  const now = deps.now ?? Date.now;
  const meter = deps.eth?.meter ?? {};
  const ethDeps: EthHistoryDeps = { ...(deps.eth ?? {}), meter };
  const before = meterTotal(meter);
  const calls = () => meterTotal(meter) - before;
  const deadline = deps.deadlineMs ?? Number.POSITIVE_INFINITY;
  let probesLeft = deps.probeBudget;

  let raw = await store.readCursor();
  let cp = parseCheckpoint(raw, accountId);
  const out = (stoppedBecause: EthBackfillOutcome["stoppedBecause"], extra: Partial<EthBackfillOutcome> = {}): EthBackfillOutcome => ({
    stoppedBecause, status: cp ? backfillStatus(cp) : null, rowsWritten: 0, impactedFromISO: null, failure: null, requests: calls(), ...extra,
  });
  if (!cp) return out("NOT_QUEUED");
  if (!shouldRunAutomatically(cp, now())) return out("SKIPPED");

  const nowISO = new Date(now()).toISOString();
  let counted = 0;
  /** CAS the checkpoint, adding the calls not yet recorded on it. False ⇒ someone else advanced it. */
  const commit = async (next: EthBackfillCheckpoint): Promise<boolean> => {
    const n = calls();
    const withUsage = { ...next, usage: addUsage(next, args.todayISO, n - counted) };
    const s = serializeCheckpoint(withUsage);
    if (!(await store.casCursor(raw, s))) return false;
    raw = s; cp = withUsage; counted = n;
    return true;
  };
  /**
   * Record a failure. A reconciliation failure restarts the generation AND
   * pauses it for a day; after MAX_RECONCILE_FAILURES (counted across
   * generations, never reset by progress) it stops for an operator.
   */
  const fail = async (code: EthBackfillFailureCode, detail: string, opts: { restart?: boolean; terminal?: boolean; recovery?: boolean } = {}): Promise<EthBackfillOutcome> => {
    const c = cp!;
    const reconcile = code === "LEDGER_DOES_NOT_RECONCILE";
    const reconcileFailures = (c.reconcileFailures ?? 0) + (reconcile ? 1 : 0);
    const terminal = opts.terminal || reconcile;
    const recovery = opts.recovery || reconcileFailures >= MAX_RECONCILE_FAILURES;
    const base = opts.restart || reconcile ? restartGeneration(c) : c;
    const ok = await commit({ ...base, reconcileFailures,
      failures: terminal ? Math.max(MAX_CONSECUTIVE_FAILURES, c.failures + 1) : c.failures + 1,
      lastFailure: { code, atISO: nowISO, detail },
      recovery: recovery ? { code, atISO: nowISO } : (c.recovery ?? null) });
    return ok ? out("FAILED", { failure: { code, detail } }) : out("CONFLICT");
  };
  /** Progress clears the transient failure streak only (reconcileFailures is kept). */
  const progressed = (c: EthBackfillCheckpoint): EthBackfillCheckpoint => ({ ...c, failures: 0, lastFailure: null, lastProgressAtISO: nowISO });
  const caveatsOf = (cov: ChainCoverage): readonly string[] => (cov.kind === "UNKNOWN" || cov.kind === "PARTIAL" ? cov.caveats : []);

  // ── BACKWARD: resume the proof at the stored boundary. A step that proves
  //    backward ends there — the forward gap is a later step's budget. ──────
  if (!cp.reachedFloor) {
    let acq;
    let hi: number;
    try {
      hi = cp.anchorBlock ?? await finalizedBlockNumber(ethDeps);
      acq = await acquireEthHistory({
        ownerAddress: store.walletAddress, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: hi,
        cursor: cp.anchorBlock !== null && cp.provenFromBlock !== null
          ? { provenFromBlock: cp.provenFromBlock, anchorBlock: cp.anchorBlock, reachedWindowStart: false } : undefined,
      }, { ...ethDeps, probeBudget: probesLeft, chunkBlocks: cp.chunkBlocks });
    } catch (e) {
      return fail("PROVIDER_FAILED", `acquisition failed: ${msg(e)}`);
    }
    if (acq.coverage.kind !== "COMPLETE") {
      const caveats = caveatsOf(acq.coverage);
      if (caveats.includes("PROOF_PREMISES_UNMET")) {
        return fail("PROOF_PREMISES_UNMET", "not a plain EOA (contract wallet, or a live EIP-7702 delegation)", { restart: true, terminal: true });
      }
      if (caveats.includes("PAGE_BUDGET_EXHAUSTED")) {
        // Nothing closed this step: the next chunk is too dense for the budget.
        // Halve it (never below the floor) so the next step can close one.
        const ok = await commit({ ...cp, chunkBlocks: Math.max(MIN_ETH_CHUNK_BLOCKS, Math.floor(cp.chunkBlocks / 2)) });
        return ok ? out("PROBE_BUDGET") : out("CONFLICT");
      }
      return fail("PROVIDER_FAILED", `acquisition licensed no interval (${caveats.join(",") || acq.coverage.kind})`);
    }
    if (acq.anchorBalanceWei === null || (cp.anchorBalanceWei !== null && acq.anchorBalanceWei !== BigInt(cp.anchorBalanceWei))) {
      return fail("LEDGER_DOES_NOT_RECONCILE", "the anchor block's balance differs from the one this proof started from");
    }
    const reachedFloor = acq.cursor.reachedWindowStart;
    if (reachedFloor && acq.openingBalanceWei !== null && acq.openingBalanceWei !== BigInt(0)) {
      // The full rebuild reconciles against a zero opening: this wallet cannot
      // close. Refused honestly — nothing written, no automatic retries.
      return fail("BALANCE_BEFORE_PROVABLE_FLOOR", "the address already held ETH at the provable floor", { restart: true, recovery: true });
    }
    const next: EthBackfillCheckpoint = progressed({
      ...cp, anchorBlock: hi, anchorBalanceWei: acq.anchorBalanceWei.toString(),
      provenFromBlock: acq.cursor.provenFromBlock, provenFromISO: acq.coverage.fromISO, anchorToISO: acq.coverage.toISO,
      reachedFloor, movements: mergeMovements(cp.movements, acq.movements.map(storeMovement)),
      probesUsed: cp.probesUsed + acq.probesUsed,
    });
    return (await commit(next)) ? out("PROBE_BUDGET") : out("CONFLICT");
  }

  // ── FORWARD + COMPLETE ────────────────────────────────────────────────────
  // At most two segments per step: the stored one (if any) and one up to the
  // head read now — after which the anchor is fresh and the rows are written.
  for (let pass = 0; pass < 2; pass++) {
    if (probesLeft <= 0 || now() >= deadline) break;
    const anchorBlock = cp.anchorBlock!;
    let fw: EthForwardSegment | null = cp.forward ?? null;
    let fresh = false;
    if (!fw) {
      let head: number;
      try { head = await finalizedBlockNumber(ethDeps); }
      catch (e) { return fail("PROVIDER_FAILED", `finalized head read failed: ${msg(e)}`); }
      if (head <= anchorBlock) return completeNow(head);
      fw = { headBlock: head, headBalanceWei: null, headToISO: null, provenFromBlock: null, movements: [], chunkBlocks: DEFAULT_ETH_CHUNK_BLOCKS };
      fresh = true;
    }
    let acq;
    try {
      acq = await acquireEthHistory({
        ownerAddress: store.walletAddress, fromBlock: anchorBlock, toBlock: fw.headBlock,
        cursor: fw.provenFromBlock !== null ? { provenFromBlock: fw.provenFromBlock, anchorBlock: fw.headBlock, reachedWindowStart: false } : undefined,
      }, { ...ethDeps, probeBudget: probesLeft, chunkBlocks: fw.chunkBlocks });
    } catch (e) {
      return fail("PROVIDER_FAILED", `head acquisition failed: ${msg(e)}`);
    }
    probesLeft -= acq.probesUsed;
    if (acq.coverage.kind !== "COMPLETE") {
      const caveats = caveatsOf(acq.coverage);
      if (caveats.includes("PROOF_PREMISES_UNMET")) {
        return fail("PROOF_PREMISES_UNMET", "the account is no longer a plain EOA", { restart: true, terminal: true });
      }
      if (caveats.includes("PAGE_BUDGET_EXHAUSTED")) {
        const ok = await commit({ ...cp, forward: { ...fw, chunkBlocks: Math.max(MIN_ETH_CHUNK_BLOCKS, Math.floor(fw.chunkBlocks / 2)) } });
        return ok ? out("PROBE_BUDGET") : out("CONFLICT");
      }
      return fail("PROVIDER_FAILED", `head acquisition licensed no interval (${caveats.join(",") || acq.coverage.kind})`);
    }
    if (acq.anchorBalanceWei === null || (fw.headBalanceWei !== null && acq.anchorBalanceWei !== BigInt(fw.headBalanceWei))) {
      return fail("LEDGER_DOES_NOT_RECONCILE", "the head block's balance differs from the one its segment started from");
    }
    fw = { ...fw, headBalanceWei: acq.anchorBalanceWei.toString(), headToISO: acq.coverage.toISO,
      provenFromBlock: acq.cursor.provenFromBlock, movements: mergeMovements(fw.movements, acq.movements.map(storeMovement)) };
    if (!acq.cursor.reachedWindowStart || acq.cursor.provenFromBlock !== anchorBlock) {
      // Proven part of the gap: keep it, resume next step (the gap stops growing — the head is pinned).
      return (await commit(progressed({ ...cp, forward: fw }))) ? out("PROBE_BUDGET") : out("CONFLICT");
    }
    if (acq.openingBalanceWei !== BigInt(cp.anchorBalanceWei!)) {
      return fail("LEDGER_DOES_NOT_RECONCILE", "the head segment does not open at the stored anchor balance");
    }
    // The gap is closed: the anchor ADVANCES to the segment's head.
    const advanced = progressed({ ...cp, anchorBlock: fw.headBlock, anchorBalanceWei: fw.headBalanceWei, anchorToISO: fw.headToISO,
      movements: mergeMovements(cp.movements, fw.movements), forward: null });
    if (fresh) { cp = advanced; return completeNow(fw.headBlock); }
    if (!(await commit(advanced))) return out("CONFLICT");
  }
  return (await commit({ ...cp })) ? out("PROBE_BUDGET") : out("CONFLICT");

  /** Write once: every movement, the closed licence, and the checkpoint CAS in one transaction. */
  async function completeNow(head: number): Promise<EthBackfillOutcome> {
    const c = cp!;
    const movements = c.movements.map(loadMovement);
    const anchorWei = BigInt(c.anchorBalanceWei!);
    const coverage: ChainCoverage & { kind: "COMPLETE" } = { kind: "COMPLETE", fromISO: c.provenFromISO!, toISO: c.anchorToISO!, source: ETH_HISTORY_SOURCE };
    const done: EthBackfillCheckpoint = progressed({
      ...c, anchorBlock: Math.max(head, c.anchorBlock!), forward: null,
      // The movements now live in the rows; the count stays for the status.
      movements: [], movementsFound: movements.length,
      completedAtISO: nowISO, licensedFromISO: coverage.fromISO, licensedToISO: coverage.toISO,
    });
    const n = calls();
    const nextCursor = serializeCheckpoint({ ...done, usage: addUsage(done, args.todayISO, n - counted) });
    let result: EthHistoryResult;
    try {
      result = await store.complete({ expectedCursor: raw!, nextCursor, movements, coverage, anchorBalanceWei: anchorWei,
        fallbackReason: c.reason as EthIncrementalFallback, windowToISO: args.todayISO });
    } catch (e) {
      if (e instanceof EthCheckpointConflictError) return out("CONFLICT");
      return fail("PROVIDER_FAILED", `history write failed: ${msg(e)}`);
    }
    if (!result.ok) {
      if (result.refusal === "LEDGER_DOES_NOT_RECONCILE") return fail("LEDGER_DOES_NOT_RECONCILE", result.reason ?? "movements do not reconcile");
      if (result.refusal === "NO_OBSERVED_ANCHOR") return fail("NO_OBSERVED_ANCHOR", result.reason ?? "no observed anchor");
      return fail("PROVIDER_FAILED", result.reason ?? String(result.refusal));
    }
    raw = nextCursor; cp = JSON.parse(nextCursor) as EthBackfillCheckpoint; counted = n;
    return out("COMPLETE", { rowsWritten: result.derivedRowsWritten ?? 0, impactedFromISO: result.impactedFromISO ?? null });
  }
}
