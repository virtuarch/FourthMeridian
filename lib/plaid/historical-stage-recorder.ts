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

/**
 * Persist a settled historical stage IMMEDIATELY.
 *
 * Guarded at the write boundary — the stage name, status and error code all pass
 * through the canonical vocabulary, so no caller can introduce a parallel one.
 * The legacy opaque stage is refused outright: it stays readable for old rows
 * and unwritable for migrated workflows.
 *
 * Never throws: a ledger write must not be able to fail the financial work it
 * describes. A lost record degrades observability; a thrown one would degrade
 * the user's data.
 */
export async function settleHistoricalStage(args: StageSettleArgs): Promise<void> {
  try {
    if (!isHistoricalStage(args.stage)) return;
    if ((args.stage as string) === LEGACY_HISTORY_STAGE) return;
    if (!isHistoricalStageStatus(args.status)) return;

    const completedAt = new Date();
    const attempt = await nextAttemptNumber(args.refreshExecutionId, args.stage);

    await db.refreshEndpointResult.create({
      data: {
        refreshExecutionId: args.refreshExecutionId,
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
      },
    });
  } catch (e) {
    console.warn(
      `[historical-stage] failed to record ${args.stage} (non-fatal):`,
      e instanceof Error ? e.message : e,
    );
  }
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
