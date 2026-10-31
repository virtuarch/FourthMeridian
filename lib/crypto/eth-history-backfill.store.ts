/**
 * lib/crypto/eth-history-backfill.store.ts
 *
 * The database half of the Ethereum history worker (eth-history-backfill.ts):
 * the checkpoint on `Connection.historyCheckpoint` (Bitcoin's column, the same
 * history link and compare-and-swap — btc-history-checkpoint.ts), the
 * completing write through the full rebuild's own persistence, the entry
 * point `refreshWalletHistory` calls for ETH, and the bounded INLINE step it
 * runs when the worker is off.
 *
 * The client is always the CALLER's authority (audit-db-authority).
 */

import type { PrismaClient } from "@prisma/client";
import { ETH_ASSET, resolveCryptoInstrumentId } from "@/lib/investments/crypto-instrument";
import { ETH_NATIVE } from "./native-asset";
import { btcHistoryLink as historyLink, readHistoryCheckpoint, casHistoryCheckpoint } from "./btc-history-checkpoint";
import { reconstructEthHistory, persistEthFullHistory, type EthHistoryResult } from "./eth-history-sync";
import type { EthHistoryDeps } from "./eth-history";
import {
  parseCheckpoint, queuedCheckpoint, serializeCheckpoint, backfillStatus, boundedEthDeps, ethInlineStepMs, ethInlineStepConfig, inlineStepProbeBudget,
  INLINE_MIN_START_MS, SUFFIX_STOPS_BEFORE_REBUILD, suffixStopsOf, type EthBackfillState, type EthBackfillWorkerConfig,
} from "./eth-history-backfill.core";
import { currentBudgetStartedAtMs } from "@/lib/jobs/run";
import { workerConfig } from "./sol-backfill-worker.core";
import { providerCallsOn, ALCHEMY_USAGE_PROVIDER, meterTotal } from "@/lib/usage/provider-budget";
import { readErc20Section, carriedTokens } from "./erc20-history.core";
import { runEthHistoryBackfill, EthCheckpointConflictError, type EthBackfillStore, type EthBackfillDeps, type EthBackfillOutcome } from "./eth-history-backfill";

/** One account's checkpoint cell: read and compare-and-swap (prismaEthBackfillStore's, or any test store). */
export type EthCheckpointCell = Pick<EthBackfillStore, "readCursor" | "casCursor">;

function prismaCell(client: PrismaClient, connectionId: string): EthCheckpointCell {
  return { readCursor: () => readHistoryCheckpoint(client, connectionId), casCursor: (e, n) => casHistoryCheckpoint(client, connectionId, e, n) };
}

/**
 * Hand an account's FULL rebuild to the resumable checkpoint (QUEUED, reason
 * = the incremental fallback); true only when it was queued. Idempotent: a
 * queued / importing / failed checkpoint is never replaced; a COMPLETE one
 * starts a new generation (the incremental path fell back again). A value
 * that is not this account's ETH checkpoint is never overwritten.
 *
 * SUFFIX_EXCEEDS_RUN (a full-cap run whose incremental suffix did not close)
 * is not enough on its own to re-prove a COMPLETE history (2026-10-31): the
 * stop is COUNTED on the checkpoint, which stays COMPLETE (a wallet licensed
 * before any checkpoint existed gets a COMPLETE one to count on), and only
 * the SUFFIX_STOPS_BEFORE_REBUILD-th stop in a row queues the new generation.
 * An incremental success resets the count (resetEthSuffixStops).
 */
export async function enqueueEthCheckpoint(cell: EthCheckpointCell, accountId: string, reason: string, now: Date = new Date()): Promise<boolean> {
  const raw = await cell.readCursor();
  const existing = parseCheckpoint(raw, accountId);
  // ERC-20 HISTORY — a standalone token section (no native checkpoint yet) is
  // not a native checkpoint: it never blocks the queue, and the token section
  // (wherever it lives) is carried into the new document untouched.
  const tokenOnly = readErc20Section(raw, accountId).host === "STANDALONE";
  if (raw !== null && !tokenOnly && !existing?.completedAtISO) return false;
  const nowISO = now.toISOString();
  if (reason === "SUFFIX_EXCEEDS_RUN") {
    const stops = suffixStopsOf(existing) + 1;
    if (stops < SUFFIX_STOPS_BEFORE_REBUILD) {
      const complete = existing ?? { ...queuedCheckpoint(accountId, "INCREMENTAL_LICENCE", nowISO), completedAtISO: nowISO, ...carriedTokens(raw, accountId) };
      await cell.casCursor(raw, serializeCheckpoint({ ...complete, suffixStops: stops }));
      return false; // counted; the history stays COMPLETE
    }
  }
  const next = { ...queuedCheckpoint(accountId, reason, nowISO), snapshotPendingFromISO: existing?.snapshotPendingFromISO ?? null,
    ...carriedTokens(raw, accountId) };
  return cell.casCursor(raw, serializeCheckpoint(next));
}

/** The production binding of enqueueEthCheckpoint, on the account's history link. */
export async function enqueueEthHistoryBackfill(client: PrismaClient, accountId: string, reason: string, now: Date = new Date()): Promise<boolean> {
  const link = await historyLink(client, accountId);
  return link ? enqueueEthCheckpoint(prismaCell(client, link.connectionId), accountId, reason, now) : false;
}

/** An incremental success: the suffix stops recorded on the checkpoint no longer run in a row. */
export async function resetEthSuffixStops(cell: EthCheckpointCell, accountId: string): Promise<boolean> {
  const raw = await cell.readCursor();
  const cp = parseCheckpoint(raw, accountId);
  if (!cp || suffixStopsOf(cp) === 0) return false;
  return cell.casCursor(raw, serializeCheckpoint({ ...cp, suffixStops: 0 }));
}

/** The production binding of resetEthSuffixStops. */
export async function clearEthSuffixStops(client: PrismaClient, accountId: string): Promise<boolean> {
  const link = await historyLink(client, accountId);
  return link ? resetEthSuffixStops(prismaCell(client, link.connectionId), accountId) : false;
}

/**
 * The worker's state for this account's rebuild, while the WORKER will still
 * carry it (null: none, COMPLETE, or RECOVERY_REQUIRED).
 *
 * RECOVERY_REQUIRED is not owed: the worker never runs it again on its own, so
 * deferring to it would leave the wallet with no history path at all. The sync
 * runs the INCREMENTAL path as usual; a fallback stays refused (nothing
 * written) and does not re-queue it — enqueueEthHistoryBackfill never
 * replaces a non-complete checkpoint. The exit is an operator resume
 * (runEthHistoryBackfill `resume`, as SOL/BTC).
 */
export async function ethHistoryPending(client: PrismaClient, accountId: string): Promise<EthBackfillState | null> {
  const link = await historyLink(client, accountId);
  if (!link) return null;
  const cp = parseCheckpoint(await readHistoryCheckpoint(client, link.connectionId), accountId);
  if (!cp || cp.completedAtISO) return null;
  const state = backfillStatus(cp).state;
  return state === "RECOVERY_REQUIRED" ? null : state;
}

export interface EthSyncImpl {
  reconstruct: typeof reconstructEthHistory;
  pending: typeof ethHistoryPending;
  enqueue: typeof enqueueEthHistoryBackfill;
  /** One bounded worker step for this account, inline (worker off). */
  step: typeof inlineEthHistoryStepForSync;
  /** After an incremental success: reset the suffix-stop count. */
  clearSuffixStops: typeof clearEthSuffixStops;
}
const PRODUCTION_IMPL: EthSyncImpl = {
  reconstruct: reconstructEthHistory, pending: ethHistoryPending, enqueue: enqueueEthHistoryBackfill, step: inlineEthHistoryStepForSync,
  clearSuffixStops: clearEthSuffixStops,
};

/**
 * What `refreshWalletHistory` calls for ETH. Every path here runs under a
 * FINITE deadline (boundedEthDeps: the caller's, else the wake-aware inline
 * deadline — ETH_INLINE_STEP_MS from now, never past the function's safe
 * budget minus the evidence and commit reserves) — never the acquisition's +∞
 * default. An incremental suffix too large for full runs falls back
 * (SUFFIX_EXCEEDS_RUN) into the same resumable path — after
 * SUFFIX_STOPS_BEFORE_REBUILD full-cap stops in a row, never one — so it
 * converges, and a COMPLETE history is not re-proved because one run was slow.
 *
 * `deferFull` false (the worker does not carry Ethereum) — 2026-10-31: the
 * FULL rebuild is NEVER run inline any more. It used to be: an unbounded walk
 * from the finalized head that ignored the checkpoint, kept nothing, and was
 * killed by the function's time limit, so every sync restarted it. Now:
 *   - a rebuild already owed (QUEUED / IMPORTING / FAILED) is advanced by ONE
 *     bounded worker step (runEthHistoryBackfill — the worker's own step,
 *     checkpoint and commit-at-the-proven-boundary), without re-trying the
 *     incremental path (it would only fall back again);
 *   - otherwise the incremental path runs; a fallback records the QUEUED
 *     checkpoint (enqueueEthHistoryBackfill) and runs that first step.
 * Progress therefore accumulates across syncs, and the step that closes the
 * proof writes the rows exactly as the worker's would.
 *
 * `deferFull` true (the worker carries Ethereum): a rebuild already owed to the
 * worker is not attempted here; otherwise the incremental path runs, and a
 * fallback records the QUEUED checkpoint and returns FULL_REBUILD_DEFERRED,
 * having written nothing. The worker advances it.
 */
export async function reconstructEthHistoryForSync(
  args: { accountId: string; windowFromISO: string; windowToISO: string; client: PrismaClient; deferFull: boolean; deps?: EthHistoryDeps },
  impl: EthSyncImpl = PRODUCTION_IMPL,
): Promise<EthHistoryResult> {
  const { accountId, windowFromISO, windowToISO } = args;
  // WAKE-AWARE: bounded by the step's cap AND by what the function has left
  // (the dispatch wake's start when under a job), minus the evidence and
  // commit reserves that run after the deadline (inlineEthDeadlineMs).
  const deps = boundedEthDeps(args.deps, { stepMs: ethInlineStepMs(), budgetStartedAtMs: currentBudgetStartedAtMs() });
  const clock = deps.now ?? Date.now;

  let pending: EthBackfillState | null = null;
  try { pending = await impl.pending(args.client, accountId); }
  catch (e) {
    // A transient read failure: the incremental path still runs, and a fallback still defers.
    console.warn(`[eth-history] checkpoint read failed for ${accountId} (non-fatal):`, e instanceof Error ? e.message : String(e));
  }
  if (pending && args.deferFull) {
    return { accountId, ok: false, refusal: "FULL_REBUILD_DEFERRED",
      reason: `history is carried by the background worker (${pending.toLowerCase()})` };
  }
  if (deps.deadlineMs - clock() < INLINE_MIN_START_MS) {
    // A late wake: nothing useful fits. No request is sent and nothing is
    // written or queued — this run's shortness decides nothing; a later one runs.
    return pending
      ? { accountId, ok: false, refusal: "FULL_REBUILD_IN_PROGRESS", mode: "FULL", reason: "no time left in this run; history continues on a later sync" }
      : { accountId, ok: false, refusal: "COVERAGE_UNLICENSED", mode: "INCREMENTAL", reason: "no time left in this run; history refreshes on a later sync" };
  }
  if (!pending) {
    const r = await impl.reconstruct({ accountId, windowFromISO, windowToISO, deps, deferFull: true });
    if (r.ok) {
      try { await impl.clearSuffixStops(args.client, accountId); }
      catch (e) { console.warn(`[eth-history] could not reset the suffix-stop count for ${accountId} (non-fatal):`, e instanceof Error ? e.message : String(e)); }
      return r;
    }
    if (r.refusal !== "FULL_REBUILD_DEFERRED") return r;
    let queued = false;
    try { queued = await impl.enqueue(args.client, accountId, r.fallbackReason ?? "UNKNOWN"); }
    catch (e) {
      // Nothing was written; the next sync falls back and enqueues again.
      console.warn(`[eth-history] could not queue the full rebuild for ${accountId} (non-fatal):`, e instanceof Error ? e.message : String(e));
    }
    if (r.fallbackReason === "SUFFIX_EXCEEDS_RUN" && !queued) {
      // Counted, not queued: one slow run never re-proves a COMPLETE history.
      return { accountId, ok: false, refusal: "COVERAGE_UNLICENSED", mode: "INCREMENTAL",
        reason: `the incremental suffix did not close within a full run; counted (a re-proof is queued only after ${SUFFIX_STOPS_BEFORE_REBUILD} in a row)` };
    }
    if (args.deferFull) return r;
  }
  // Worker off: one bounded step of the resumable rebuild, inline.
  return impl.step({ accountId, client: args.client, todayISO: windowToISO, deps });
}

/**
 * ONE bounded worker step, inline. The store is any EthBackfillStore (the
 * production binding is prismaEthBackfillStore); the allowance is the calls
 * left today under the SHARED Alchemy cap (null = unreadable ⇒ do not start).
 *
 * Never a new proof decision: runEthHistoryBackfill resumes the checkpoint at
 * its proven boundary, carries the FEE key proof (ownerSignedIn), commits only
 * proven boundaries (CAS), halves a chunk the clock stopped, and writes rows
 * only when the proof closes — exactly as in the worker. A step that does not
 * close reports FULL_REBUILD_IN_PROGRESS (nothing written, progress kept).
 */
export async function runInlineEthHistoryStep(args: {
  accountId: string; store: EthBackfillStore; todayISO: string;
  deps: EthHistoryDeps & { deadlineMs: number };
  allowanceCalls: number | null;
  cfg?: Pick<EthBackfillWorkerConfig, "probeBudget" | "probesPerSecond">;
}): Promise<EthHistoryResult> {
  const { accountId, deps } = args;
  const now = deps.now ?? Date.now;
  const cfg = args.cfg ?? ethInlineStepConfig();
  const inProgress = (reason: string): EthHistoryResult => ({ accountId, ok: false, refusal: "FULL_REBUILD_IN_PROGRESS", mode: "FULL", reason });
  const probeBudget = inlineStepProbeBudget({ allowanceCalls: args.allowanceCalls, msLeft: deps.deadlineMs - now(), cfg });
  if (probeBudget <= 0) {
    return inProgress(args.allowanceCalls === null ? "the shared provider budget could not be read; history continues on a later sync"
      : deps.deadlineMs <= now() ? "no time left in this sync; history continues on a later sync"
      : "the shared daily provider budget is spent; history continues after UTC midnight");
  }
  // The step re-applies the clock and the deadline to the acquisition (and meters every call into deps.meter).
  const o = await runEthHistoryBackfill({ accountId, store: args.store, todayISO: args.todayISO },
    { probeBudget, now, deadlineMs: deps.deadlineMs, eth: deps });
  if (o.stoppedBecause === "COMPLETE") {
    return { accountId, ok: true, mode: "FULL", derivedRowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO };
  }
  const st = o.status;
  const where = st?.importedBackToISO ? `; verified back to ${st.importedBackToISO}` : "";
  return inProgress(o.failure
    ? `history import step failed (${o.failure.code}): ${o.failure.detail}${where}`
    : `history import ${(st?.state ?? o.stoppedBecause).toLowerCase()} (${o.stoppedBecause.toLowerCase()})${where}; continues on a later sync`);
}

/** The production inline step: this account's checkpoint store and today's shared Alchemy allowance. */
export async function inlineEthHistoryStepForSync(args: { accountId: string; client: PrismaClient; todayISO: string; deps: EthHistoryDeps & { deadlineMs: number } }): Promise<EthHistoryResult> {
  const bound = await prismaEthBackfillStore(args.accountId, args.client);
  if (!bound) return { accountId: args.accountId, ok: false, refusal: "NOT_AN_ETH_WALLET", reason: "no ETH history link for this account" };
  // The SAME cap the worker and token capture spend (one Alchemy key, one bill),
  // read from the shared ledger; this run's own calls are counted by its meter
  // and recorded to the same ledger (wallet-history-refresh.ts metered()).
  const ledger = await providerCallsOn(args.client, ALCHEMY_USAGE_PROVIDER, args.todayISO);
  // + this run's meter so far (the incremental path's calls): conservative —
  // its already-flushed part is in the ledger too, so it can only over-count.
  const spent = ledger ? ledger.solana + ledger.other + meterTotal(args.deps.meter ?? {}) : null;
  const allowanceCalls = spent === null ? null : workerConfig().dailyRequestCap - spent;
  return runInlineEthHistoryStep({ accountId: args.accountId, store: bound.store, todayISO: args.todayISO, deps: args.deps, allowanceCalls });
}

/** The production store for one ETH wallet account. */
export async function prismaEthBackfillStore(accountId: string, db: PrismaClient): Promise<{ store: EthBackfillStore; connectionId: string } | null> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId }, select: { walletChain: true, walletAddress: true, deletedAt: true },
  });
  if (!account || account.deletedAt || account.walletChain?.trim().toUpperCase() !== ETH_NATIVE.chain || !account.walletAddress) return null;
  const link = await historyLink(db, accountId);
  if (!link) return null;
  const connectionId = link.connectionId;
  const store: EthBackfillStore = {
    walletAddress: account.walletAddress,
    readCursor: () => readHistoryCheckpoint(db, connectionId),
    casCursor: (expected, next) => casHistoryCheckpoint(db, connectionId, expected, next),
    async complete(c) {
      return persistEthFullHistory({
        accountId, client: db, writer: db, movements: c.movements, coverage: c.coverage, anchorBalanceWei: c.anchorBalanceWei,
        // The licence starts at the provable floor, before any stored evidence.
        windowFromISO: c.coverage.fromISO, windowToISO: c.windowToISO, fallbackReason: c.fallbackReason,
        instrumentId: await resolveCryptoInstrumentId(ETH_ASSET, { client: db }),
        txTimeoutMs: 30_000,
        inTransaction: async (tx) => {
          if (!(await casHistoryCheckpoint(tx, connectionId, c.expectedCursor, c.nextCursor))) throw new EthCheckpointConflictError();
        },
      });
    },
  };
  return { store, connectionId };
}

/** One worker step for one ETH wallet. */
export async function reconstructEthHistoryResumable(args: { accountId: string; client: PrismaClient; todayISO: string; resume?: boolean; deps: EthBackfillDeps }): Promise<EthBackfillOutcome> {
  const bound = await prismaEthBackfillStore(args.accountId, args.client);
  if (!bound) return { stoppedBecause: "NOT_QUEUED", status: null, rowsWritten: 0, impactedFromISO: null, failure: null, requests: 0 };
  return runEthHistoryBackfill({ accountId: args.accountId, store: bound.store, todayISO: args.todayISO, resume: args.resume }, args.deps);
}
