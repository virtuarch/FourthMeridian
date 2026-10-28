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
 *   COMPLETE   once the proof reaches the provable floor: prove the gap from
 *              the anchor to the CURRENT finalized head (its opening balance
 *              must equal the stored anchor balance, exactly), then hand every
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
  type EthBackfillCheckpoint, type EthBackfillFailureCode, type EthBackfillStatus,
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
  probeBudget: number;
  now?: () => number;
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
  const fail = async (code: EthBackfillFailureCode, detail: string, opts: { restart?: boolean; terminal?: boolean } = {}): Promise<EthBackfillOutcome> => {
    const base = opts.restart ? restartGeneration(cp!) : cp!;
    const ok = await commit({ ...base, failures: opts.terminal ? Math.max(MAX_CONSECUTIVE_FAILURES, cp!.failures + 1) : cp!.failures + 1,
      lastFailure: { code, atISO: nowISO, detail } });
    return ok ? out("FAILED", { failure: { code, detail } }) : out("CONFLICT");
  };

  // ── BACKWARD: resume the proof at the stored boundary ──────────────────────
  if (!cp.reachedFloor) {
    let acq;
    let hi: number;
    try {
      hi = cp.anchorBlock ?? await finalizedBlockNumber(ethDeps);
      acq = await acquireEthHistory({
        ownerAddress: store.walletAddress, fromBlock: EARLIEST_PROVABLE_BLOCK, toBlock: hi,
        cursor: cp.anchorBlock !== null && cp.provenFromBlock !== null
          ? { provenFromBlock: cp.provenFromBlock, anchorBlock: cp.anchorBlock, reachedWindowStart: false } : undefined,
      }, { ...ethDeps, probeBudget: deps.probeBudget, chunkBlocks: cp.chunkBlocks });
    } catch (e) {
      return fail("PROVIDER_FAILED", `acquisition failed: ${msg(e)}`);
    }
    if (acq.coverage.kind !== "COMPLETE") {
      const caveats = acq.coverage.kind === "UNKNOWN" || acq.coverage.kind === "PARTIAL" ? acq.coverage.caveats : [];
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
      return fail("LEDGER_DOES_NOT_RECONCILE", "the anchor block's balance differs from the one this proof started from", { restart: true });
    }
    const progressed: EthBackfillCheckpoint = {
      ...cp, anchorBlock: hi, anchorBalanceWei: acq.anchorBalanceWei.toString(),
      provenFromBlock: acq.cursor.provenFromBlock, provenFromISO: acq.coverage.fromISO, anchorToISO: acq.coverage.toISO,
      reachedFloor: acq.cursor.reachedWindowStart,
      movements: mergeMovements(cp.movements, acq.movements.map(storeMovement)),
      probesUsed: cp.probesUsed + acq.probesUsed, failures: 0, lastFailure: null, lastProgressAtISO: nowISO,
    };
    if (!(await commit(progressed))) return out("CONFLICT");
    if (!cp.reachedFloor) return out("PROBE_BUDGET");
  }

  // ── COMPLETE: close the gap to the current head, then write once ──────────
  const anchorBlock = cp.anchorBlock!;
  let movements = cp.movements.map(loadMovement);
  let anchorWei = BigInt(cp.anchorBalanceWei!);
  let toISO = cp.anchorToISO!;
  let head: number;
  try { head = await finalizedBlockNumber(ethDeps); }
  catch (e) { return fail("PROVIDER_FAILED", `finalized head read failed: ${msg(e)}`); }
  if (head > anchorBlock) {
    let fwd;
    try {
      fwd = await acquireEthHistory({ ownerAddress: store.walletAddress, fromBlock: anchorBlock, toBlock: head },
        { ...ethDeps, probeBudget: deps.probeBudget, chunkBlocks: DEFAULT_ETH_CHUNK_BLOCKS });
    } catch (e) {
      return fail("PROVIDER_FAILED", `head acquisition failed: ${msg(e)}`);
    }
    if (fwd.coverage.kind === "UNKNOWN" && fwd.coverage.caveats.includes("PROOF_PREMISES_UNMET")) {
      return fail("PROOF_PREMISES_UNMET", "the account is no longer a plain EOA", { restart: true, terminal: true });
    }
    if (fwd.coverage.kind !== "COMPLETE" || !fwd.cursor.reachedWindowStart || fwd.cursor.provenFromBlock !== anchorBlock) {
      // Not closed within this step's budget (or throttled): try again next run; the backward proof is kept.
      if (fwd.coverage.kind === "COMPLETE" || (fwd.coverage.kind === "UNKNOWN" && fwd.coverage.caveats.includes("PAGE_BUDGET_EXHAUSTED"))) {
        const ok = await commit({ ...cp });
        return ok ? out("PROBE_BUDGET") : out("CONFLICT");
      }
      return fail("PROVIDER_FAILED", `head acquisition licensed no interval (${fwd.coverage.kind})`);
    }
    if (fwd.openingBalanceWei !== anchorWei) {
      return fail("LEDGER_DOES_NOT_RECONCILE", "the head segment does not open at the stored anchor balance", { restart: true });
    }
    movements = mergeMovements(cp.movements, fwd.movements.map(storeMovement)).map(loadMovement);
    anchorWei = fwd.anchorBalanceWei!;
    toISO = fwd.coverage.toISO;
  }

  const coverage: ChainCoverage & { kind: "COMPLETE" } = { kind: "COMPLETE", fromISO: cp.provenFromISO!, toISO, source: ETH_HISTORY_SOURCE };
  const done: EthBackfillCheckpoint = {
    ...cp, anchorBlock: Math.max(head, anchorBlock), anchorBalanceWei: anchorWei.toString(), anchorToISO: toISO,
    // The movements now live in the rows; the count stays for the status.
    movements: [], movementsFound: movements.length,
    completedAtISO: nowISO, licensedFromISO: coverage.fromISO, licensedToISO: coverage.toISO,
    failures: 0, lastFailure: null, lastProgressAtISO: nowISO,
  };
  const n = calls();
  const nextCursor = serializeCheckpoint({ ...done, usage: addUsage(done, args.todayISO, n - counted) });
  let result: EthHistoryResult;
  try {
    result = await store.complete({ expectedCursor: raw!, nextCursor, movements, coverage, anchorBalanceWei: anchorWei,
      fallbackReason: cp.reason as EthIncrementalFallback, windowToISO: args.todayISO });
  } catch (e) {
    if (e instanceof EthCheckpointConflictError) return out("CONFLICT");
    return fail("PROVIDER_FAILED", `history write failed: ${msg(e)}`);
  }
  if (!result.ok) {
    if (result.refusal === "LEDGER_DOES_NOT_RECONCILE") return fail("LEDGER_DOES_NOT_RECONCILE", result.reason ?? "movements do not reconcile", { restart: true });
    if (result.refusal === "NO_OBSERVED_ANCHOR") return fail("NO_OBSERVED_ANCHOR", result.reason ?? "no observed anchor");
    return fail("PROVIDER_FAILED", result.reason ?? String(result.refusal));
  }
  raw = nextCursor; cp = JSON.parse(nextCursor) as EthBackfillCheckpoint; counted = n;
  return out("COMPLETE", { rowsWritten: result.derivedRowsWritten ?? 0, impactedFromISO: result.impactedFromISO ?? null });
}
