/**
 * lib/plaid/historical-stages.core.ts
 *
 * V26-STAGE-1 — THE HISTORICAL PIPELINE, MADE ATTRIBUTABLE AND RESUMABLE.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 * The connect/webhook historical layer was recorded as ONE opaque stage,
 * `HISTORY_BACKFILL`, covering coverage ingestion, reconstruction, ownership,
 * price acquisition and snapshot regeneration. When any part failed the ledger
 * could not say which, what had already succeeded, or where a retry should
 * resume — so a retry restarted everything, re-paying provider calls for work
 * that had already landed.
 *
 * ── Ordering is a financial invariant, not a preference ──────────────────────
 * Each stage consumes what the previous one persisted:
 *   COVERAGE       — what the provider demonstrably returned
 *   RECONSTRUCTION — signed replay + opening anchors, over that coverage
 *   OWNERSHIP      — KNOWN/POSSIBLE intervals, from coverage + reconstruction
 *   PRICES         — acquired only inside licensed, ownership-eligible spans
 *   REGENERATION   — snapshots rebuilt only from stored prices
 *
 * Declared ONCE here so no caller can reorder it and no retry can skip forward.
 *
 * ── The one authorization rule ───────────────────────────────────────────────
 * REGENERATION is the ONLY stage that may advance snapshot support. Coverage,
 * reconstruction, ownership and prices all succeed without authorizing a single
 * historical value: acquiring a price says a date became attemptable, never that
 * it became true. Execution state explains workflow progress; snapshot status
 * authorizes financial truth; neither substitutes for the other.
 */

/** The five historical stages, IN MANDATORY ORDER. The single source of order. */
export const HISTORICAL_STAGES = [
  "COVERAGE",
  "RECONSTRUCTION",
  "OWNERSHIP",
  "PRICES",
  "REGENERATION",
] as const;
export type HistoricalStage = (typeof HISTORICAL_STAGES)[number];

/**
 * The opaque stage these five replace. READ-COMPATIBLE, WRITE-FORBIDDEN:
 * executions recorded before this slice keep it and must stay readable, but no
 * migrated workflow may emit it again. Decomposing those old rows into stages
 * that were never observed would be fabrication, so they are left exactly as
 * they are.
 */
export const LEGACY_HISTORY_STAGE = "HISTORY_BACKFILL";

export function isHistoricalStage(v: unknown): v is HistoricalStage {
  return typeof v === "string" && (HISTORICAL_STAGES as readonly string[]).includes(v);
}

/** Position in the pipeline; -1 when not a historical stage. */
export function stageIndex(stage: string): number {
  return (HISTORICAL_STAGES as readonly string[]).indexOf(stage);
}

/**
 * Stage outcome.
 *
 * PROVIDER_LIMITED is the addition that matters. It is NOT a system failure and
 * NOT a success: the provider cannot supply the interval at all, so retrying
 * changes nothing until capability changes. Folding it into FAILED would make
 * every provider boundary look like an outage and invite endless retries;
 * folding it into SUCCEEDED would claim evidence that was never returned.
 */
export const HISTORICAL_STAGE_STATUSES = [
  "SUCCEEDED", "FAILED", "SKIPPED", "PROVIDER_LIMITED",
] as const;
export type HistoricalStageStatus = (typeof HISTORICAL_STAGE_STATUSES)[number];

export function isHistoricalStageStatus(v: unknown): v is HistoricalStageStatus {
  return typeof v === "string" && (HISTORICAL_STAGE_STATUSES as readonly string[]).includes(v);
}

/**
 * Stable machine-readable failure codes. Prose is never the stored authority.
 * Reuses the vocabulary already established by the price and reconstruction
 * layers so one code means one thing across the system.
 */
export const STAGE_ERROR_CODES = [
  "PROVIDER_AUTH", "PROVIDER_LIMIT", "PROVIDER_ERROR", "PAGINATION_INCOMPLETE",
  "COVERAGE_INVALID", "RECONSTRUCTION_CONFLICT", "UNSUPPORTED_CORPORATE_ACTION",
  "PRICE_GAP", "REGENERATION_FAILED", "LOCKED_OR_CONCURRENT", "MEMBERSHIP_CHANGED",
  "UNKNOWN",
] as const;
export type StageErrorCode = (typeof STAGE_ERROR_CODES)[number];

export function isStageErrorCode(v: unknown): v is StageErrorCode {
  return typeof v === "string" && (STAGE_ERROR_CODES as readonly string[]).includes(v);
}

/** One persisted stage attempt, as the retry/readiness authorities read it. */
export interface StageAttemptRecord {
  stage:   HistoricalStage;
  status:  HistoricalStageStatus;
  attempt: number;
  /** The window this attempt actually covered. Null on stages without one. */
  windowFromISO: string | null;
  windowToISO:   string | null;
  errorCode: StageErrorCode | null;
  /** When the attempt began — used to age out a stale RUNNING attempt. */
  startedAt: Date;
  /** Null while still running. */
  completedAt: Date | null;
}

/**
 * A stage that began and never completed is considered ABANDONED after this.
 *
 * Matches the existing per-item sync lock TTL (6 minutes) rather than inventing
 * a second timeout: if the lock has expired the run that held it is gone, so a
 * stage it left open is gone too. One recovery rule, one clock.
 */
export const STALE_ATTEMPT_MS = 360_000;

export type RetryDecision =
  | { kind: "run"; stage: HistoricalStage; reason: string; reusable: HistoricalStage[] }
  | { kind: "complete"; reason: string; reusable: HistoricalStage[] }
  | { kind: "blocked"; stage: HistoricalStage; reason: string; reusable: HistoricalStage[] };

/**
 * Where should the next attempt begin?
 *
 * Walks the pipeline IN ORDER and stops at the first stage that is not
 * terminally settled. A stage already SUCCEEDED, SKIPPED or PROVIDER_LIMITED is
 * settled and is never rerun merely because something after it failed — that
 * re-payment of provider calls is the defect this slice exists to remove.
 *
 * PROVIDER_LIMITED settles the stage but BLOCKS the pipeline only where a later
 * stage cannot proceed without it. It does not here: a provider that could not
 * serve some dates still returned others, and regeneration must be free to build
 * what evidence exists. The unavailable dates stay unavailable because the
 * snapshot guards refuse them — not because the pipeline stopped.
 *
 * A window mismatch is NOT resumable. Resuming a different interval against
 * stages that settled for another one would silently attribute old work to a new
 * scope, so it reports `run` at the first stage instead.
 */
export function nextStageToRun(
  attempts: readonly StageAttemptRecord[],
  opts: { windowFromISO?: string | null; windowToISO?: string | null; now?: Date } = {},
): RetryDecision {
  const now = opts.now ?? new Date();

  // Latest attempt per stage.
  const latest = new Map<HistoricalStage, StageAttemptRecord>();
  for (const a of attempts) {
    const prev = latest.get(a.stage);
    if (!prev || a.attempt > prev.attempt) latest.set(a.stage, a);
  }

  const reusable: HistoricalStage[] = [];
  for (const stage of HISTORICAL_STAGES) {
    const a = latest.get(stage);

    if (!a) return { kind: "run", stage, reason: `${stage} has no recorded attempt`, reusable };

    // An attempt that began and never completed is only trustworthy while it
    // could still be alive. Past the TTL the run that held it is gone.
    if (a.completedAt === null) {
      const ageMs = now.getTime() - a.startedAt.getTime();
      if (ageMs < STALE_ATTEMPT_MS) {
        return { kind: "blocked", stage, reason: `${stage} is still running (attempt ${a.attempt})`, reusable };
      }
      return { kind: "run", stage, reason: `${stage} attempt ${a.attempt} went stale after ${STALE_ATTEMPT_MS}ms`, reusable };
    }

    if (a.status === "FAILED") {
      return { kind: "run", stage, reason: `${stage} failed (${a.errorCode ?? "UNKNOWN"})`, reusable };
    }

    // Settled. Reusable only if it settled for THIS window.
    const wantFrom = opts.windowFromISO ?? null;
    const wantTo   = opts.windowToISO ?? null;
    const windowDiffers =
      (wantFrom !== null && a.windowFromISO !== null && a.windowFromISO !== wantFrom) ||
      (wantTo   !== null && a.windowToISO   !== null && a.windowToISO   !== wantTo);
    if (windowDiffers) {
      return {
        kind: "run", stage,
        reason: `${stage} settled for ${a.windowFromISO}..${a.windowToISO}, not ${wantFrom}..${wantTo}`,
        reusable,
      };
    }

    reusable.push(stage);
  }

  return { kind: "complete", reason: "every stage is terminally settled", reusable };
}

// ── Readiness ───────────────────────────────────────────────────────────────

export type HistoryReadiness =
  | "HISTORY_READY"
  | "HISTORY_PARTIAL"
  | "HISTORY_BUILDING"
  | "HISTORY_FAILED"
  | "HISTORY_PROVIDER_LIMITED"
  | "HISTORY_UNKNOWN";

export interface ReadinessInput {
  attempts: readonly StageAttemptRecord[];
  /**
   * Did the REGENERATION stage's own result report unsupported/blocked dates?
   * Supplied by the caller from the regeneration summary — this module does not
   * read snapshots, because execution state must never be mistaken for the
   * authorization that snapshot status alone carries.
   */
  regenerationLeftUnsupportedDates?: boolean;
  now?: Date;
}

/**
 * Derive HISTORY readiness from stage evidence alone.
 *
 * Deliberately says nothing about whether a consumer may ASSERT a value — that
 * remains `SpaceSnapshot.cryptoValuationStatus` and the completeness scalars.
 * This answers "did the workflow finish, and how?", which is a different
 * question with a different owner.
 */
export function deriveHistoryReadiness(input: ReadinessInput): HistoryReadiness {
  const { attempts } = input;
  if (attempts.length === 0) return "HISTORY_UNKNOWN";

  const decision = nextStageToRun(attempts, { now: input.now });

  if (decision.kind === "blocked") return "HISTORY_BUILDING";

  if (decision.kind === "run") {
    const latest = attempts
      .filter((a) => a.stage === decision.stage)
      .sort((x, y) => y.attempt - x.attempt)[0];
    // A stage that has never been attempted, or is stale, is still in progress.
    if (!latest || latest.completedAt === null) return "HISTORY_BUILDING";
    return latest.status === "FAILED" ? "HISTORY_FAILED" : "HISTORY_BUILDING";
  }

  // Every stage settled. HOW it settled decides between ready and qualified.
  const latestByStage = new Map<HistoricalStage, StageAttemptRecord>();
  for (const a of attempts) {
    const prev = latestByStage.get(a.stage);
    if (!prev || a.attempt > prev.attempt) latestByStage.set(a.stage, a);
  }
  const regen = latestByStage.get("REGENERATION");
  if (!regen || regen.status !== "SUCCEEDED") {
    // Regeneration is the only stage that can make history ready. Settled any
    // other way means the workflow finished without authorizing anything.
    return regen?.status === "PROVIDER_LIMITED" ? "HISTORY_PROVIDER_LIMITED" : "HISTORY_PARTIAL";
  }

  const anyProviderLimited = [...latestByStage.values()].some((a) => a.status === "PROVIDER_LIMITED");
  if (anyProviderLimited) return "HISTORY_PROVIDER_LIMITED";
  if (input.regenerationLeftUnsupportedDates) return "HISTORY_PARTIAL";
  return "HISTORY_READY";
}

/**
 * Are current balances usable?
 *
 * Deliberately independent of every historical stage: a failed history must
 * never make a freshly-read balance look unavailable. Historical stages cannot
 * appear in this input at all, which makes the independence structural rather
 * than a rule someone must remember.
 */
export function deriveCurrentReadiness(input: {
  balancesStageStatus: "SUCCEEDED" | "FAILED" | "SKIPPED" | null;
}): "CURRENT_READY" | "CURRENT_STALE" | "CURRENT_UNKNOWN" {
  if (input.balancesStageStatus === null) return "CURRENT_UNKNOWN";
  if (input.balancesStageStatus === "FAILED") return "CURRENT_STALE";
  return "CURRENT_READY";
}
