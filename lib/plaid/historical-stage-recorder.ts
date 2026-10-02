/**
 * lib/plaid/historical-stage-recorder.ts
 *
 * V26-STAGE-1 — the DB binding that makes historical stages RESUMABLE.
 *
 * ── Why this exists beside the existing recorder ─────────────────────────────
 * `RefreshStageRecorder` buffers stages in memory and the orchestrator flushes
 * them with one `createMany` at completion (refresh-execution.ts). That is
 * correct for a short provider fan-out — but it means a crash mid-run persists
 * NO stage rows at all, so nothing can be resumed and the whole pipeline is
 * re-paid on the next attempt. The opaque `HISTORY_BACKFILL` stage hid that,
 * because there was nothing to resume to anyway.
 *
 * This writer persists EACH historical stage the moment it settles, before the
 * next one begins. That single change is what turns the ledger from a post-hoc
 * report into a resumption point.
 *
 * It does not replace the existing recorder and does not touch the provider
 * stages it owns; the two write to the same table, for different stages, with
 * different durability needs.
 *
 * ── What it will not do ──────────────────────────────────────────────────────
 * It records. It never decides: ordering comes from HISTORICAL_STAGES, resume
 * points from `nextStageToRun`, readiness from `deriveHistoryReadiness`. And it
 * never writes a financial row — recording that a stage succeeded is not the
 * same as authorizing what it produced, which remains snapshot status alone.
 *
 * ── RLS-P-1: IT NO LONGER ISSUES THE WRITE ───────────────────────────────────
 * `RefreshEndpointResult` is revoked from `fm_app` outright, and the operational
 * ledger now has exactly one door (lib/plaid/refresh-ledger.ts). So what used to
 * be `settleHistoricalStage` is split: the STAGE VOCABULARY and the row shape
 * stay here, where the five stage names and their statuses are defined, and the
 * INSERT happens at the door under the one client that may perform it. The read
 * that numbers the next attempt stays here too — it is keyed by the execution id
 * the door minted and by this module's own stage vocabulary, and it returns a
 * number, never a row.
 */

import { db } from "@/lib/db";
import {
  HISTORICAL_STAGES, LEGACY_HISTORY_STAGE, isHistoricalStage, isHistoricalStageStatus,
  isStageErrorCode, nextStageToRun,
  type HistoricalStage, type HistoricalStageStatus, type StageErrorCode,
  type StageAttemptRecord, type RetryDecision,
} from "./historical-stages.core";

export type { HistoricalStage, HistoricalStageStatus, StageErrorCode, RetryDecision };
export { HISTORICAL_STAGES, LEGACY_HISTORY_STAGE, nextStageToRun };

/** Concise, stage-specific counts. Summaries only — never per-instrument dumps. */
export type StageResultSummary = Record<string, number | string | boolean | null>;

export interface StageSettleArgs {
  /**
   * ⚠️ NEVER SUPPLIED BY A PRODUCER (RLS-P-1). The ledger door takes
   * `Omit<StageSettleArgs, "refreshExecutionId">` and fills this from the id it
   * minted; the field survives on the type so that `Omit` names something real
   * and so the row shape stays readable in one place.
   */
  refreshExecutionId: string;
  stage: HistoricalStage;
  status: HistoricalStageStatus;
  startedAt: Date;
  windowFromISO?: string | null;
  windowToISO?: string | null;
  plannerMode?: string | null;
  errorCode?: StageErrorCode | null;
  /** Human-facing only. Truncated, and never a provider payload or credential. */
  errorSummary?: string | null;
  retryable?: boolean;
  resultSummary?: StageResultSummary;
  skipReason?: string | null;
}

/** Max stored error prose. Long provider bodies are truncated, never stored raw. */
const MAX_ERROR_CHARS = 500;

/**
 * Load every historical stage attempt for an execution, newest-relevant last.
 * The retry and readiness authorities consume exactly this.
 */
export async function loadHistoricalStageAttempts(
  refreshExecutionId: string,
): Promise<StageAttemptRecord[]> {
  const rows = await db.refreshEndpointResult.findMany({
    where:   { refreshExecutionId, endpoint: { in: [...HISTORICAL_STAGES] } },
    orderBy: [{ endpoint: "asc" }, { attempt: "asc" }],
  });
  return rows.flatMap((r) => {
    if (!isHistoricalStage(r.endpoint) || !isHistoricalStageStatus(r.status)) return [];
    return [{
      stage:         r.endpoint,
      status:        r.status,
      attempt:       r.attempt ?? 1,
      windowFromISO: r.windowFromISO,
      windowToISO:   r.windowToISO,
      errorCode:     isStageErrorCode(r.errorCode) ? r.errorCode : null,
      startedAt:     r.startedAt,
      completedAt:   r.completedAt,
    } satisfies StageAttemptRecord];
  });
}

/** The next attempt number for this (execution, stage). 1-based. */
async function nextAttemptNumber(refreshExecutionId: string, stage: HistoricalStage): Promise<number> {
  const last = await db.refreshEndpointResult.findFirst({
    where:   { refreshExecutionId, endpoint: stage },
    orderBy: { attempt: "desc" },
    select:  { attempt: true },
  });
  return (last?.attempt ?? 0) + 1;
}

/** The exact `RefreshEndpointResult` row one settled historical stage becomes. */
export interface HistoricalStageRow {
  refreshExecutionId: string;
  endpoint:      string;
  stageKind:     "DERIVED";
  status:        HistoricalStageStatus;
  skipReason:    string | null;
  startedAt:     Date;
  completedAt:   Date;
  durationMs:    number;
  attempt:       number;
  windowFromISO: string | null;
  windowToISO:   string | null;
  plannerMode:   string | null;
  errorCode:     StageErrorCode | null;
  retryable:     boolean;
  errorSummary:  string | null;
  resultSummary: never;
}

/**
 * Build the row for a settled historical stage, or refuse it.
 *
 * Guarded at the write boundary — the stage name, status and error code all pass
 * through the canonical vocabulary, so no caller can introduce a parallel one.
 * The legacy opaque stage is refused outright: it stays readable for old rows
 * and unwritable for migrated workflows. `null` means REFUSED BY VOCABULARY,
 * which is not a failure and must not be reported as one.
 *
 * ⚠️ `refreshExecutionId` is a parameter here and not in the door's signature on
 * purpose: this function cannot write anything, so it cannot be the leak. It is
 * supplied by the handle, which minted it (lib/plaid/refresh-ledger.ts).
 *
 * The one read it performs — the next attempt ordinal — is keyed by that minted
 * id and by this module's own stage vocabulary, and it returns a number.
 */
export async function prepareHistoricalStageRow(
  refreshExecutionId: string,
  args: Omit<StageSettleArgs, "refreshExecutionId">,
): Promise<HistoricalStageRow | null> {
  if (!isHistoricalStage(args.stage)) return null;
  if ((args.stage as string) === LEGACY_HISTORY_STAGE) return null;
  if (!isHistoricalStageStatus(args.status)) return null;

  const completedAt = new Date();
  const attempt = await nextAttemptNumber(refreshExecutionId, args.stage);

  return {
    refreshExecutionId,
    endpoint:      args.stage,
    stageKind:     "DERIVED",
    status:        args.status,
    skipReason:    args.status === "SKIPPED" ? (args.skipReason ?? "NOT_APPLICABLE") : null,
    startedAt:     args.startedAt,
    completedAt,
    durationMs:    completedAt.getTime() - args.startedAt.getTime(),
    attempt,
    windowFromISO: args.windowFromISO ?? null,
    windowToISO:   args.windowToISO ?? null,
    plannerMode:   args.plannerMode ?? null,
    errorCode:     isStageErrorCode(args.errorCode) ? args.errorCode : null,
    // A provider limit is settled but NOT retryable — retrying cannot change
    // what the tier will serve. Everything else defaults to retryable only
    // when it actually failed.
    retryable:     args.retryable ?? (args.status === "FAILED"),
    errorSummary:  args.errorSummary ? truncateError(args.errorSummary) : null,
    resultSummary: (args.resultSummary ?? undefined) as never,
  };
}

/**
 * Truncate stored error prose.
 *
 * Provider bodies can carry request echoes and identifiers; storing them whole
 * would put unbounded third-party content — potentially including credential
 * material echoed back in a URL — into a table operators read casually.
 */
function truncateError(msg: string): string {
  const clean = msg.replace(/\s+/g, " ").trim();
  return clean.length <= MAX_ERROR_CHARS ? clean : `${clean.slice(0, MAX_ERROR_CHARS)}…`;
}

/**
 * Where should this execution's historical work resume?
 *
 * Convenience over `loadHistoricalStageAttempts` + `nextStageToRun`; the
 * decision itself stays in the pure authority.
 */
export async function resolveResumePoint(
  refreshExecutionId: string,
  window?: { fromDate: string; toDate: string },
  now?: Date,
): Promise<RetryDecision> {
  const attempts = await loadHistoricalStageAttempts(refreshExecutionId);
  return nextStageToRun(attempts, {
    windowFromISO: window?.fromDate ?? null,
    windowToISO:   window?.toDate ?? null,
    now,
  });
}
