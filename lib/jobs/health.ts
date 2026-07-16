/**
 * lib/jobs/health.ts  (OPS-4 S5 · OPS-5 S2)
 *
 * THE dead-job detector AND the rich job-health read model — a single
 * read-only pass over the JobRun ledger that answers both "did every
 * registered job run when it should have, and is any silently broken?" and
 * "how is each job actually doing operationally?". One implementation, no
 * second execution-tracking mechanism: the OPS-4 S1 ledger is the ONLY source
 * (this module performs zero writes and creates no tables).
 *
 * DETECTION POLICY (per registered job, priority order):
 *   never-ran  no JobRun row exists for the name — the job has never left a
 *              corpse (a just-registered job reports this until its first slot
 *              fires; the operator decides).
 *   running    the newest run is "running" and still fresh (younger than
 *              STALE_RUNNING_HOURS) — a run is in flight right now. A stale
 *              "running" row is NOT this: it is a crashed run (see below).
 *   dead       the newest run started more than expectedEveryHours ×
 *              DEAD_CADENCE_MULTIPLE ago — the schedule has been silently
 *              stopped for MANY cycles, not merely one late slot. Strictly
 *              stronger than overdue; the "escalate now" signal.
 *   overdue    the newest run started more than expectedEveryHours (default
 *              24 — most jobs are daily) + GRACE_HOURS ago — the schedule
 *              missed its window (dead cron, dead dispatcher, deregistered job
 *              with history), but recently enough to be a single miss.
 *   failing    the last FAILURE_STREAK_THRESHOLD (3) runs all failed — the job
 *              runs on time but is broken. A "running" row older than
 *              STALE_RUNNING_HOURS counts as a failure in the streak (the
 *              process died before its completion write — S1's documented crash
 *              shape); a RECENT "running" row is in-flight and healthy.
 *   healthy    none of the above.
 *
 * OPS-5 S2 (2026-07-16) — RICH HEALTH. The same read pass now also derives the
 * operational metrics operators need, ALL from the identical JobRun window (no
 * second query, no persisted counters): last / average / streak, historical
 * success rate, last failure (time + summary), manual-run count, and the next
 * expected fire time (computed from the registry SCHEDULE, since JobRun stores
 * only what has already happened). "Manual runs" reads JobRun.trigger ===
 * "manual"; today only the dispatcher writes rows and it always uses "cron", so
 * this reports 0 until a manual-run producer exists — an honest read of the
 * ledger, never a fabricated figure. No new status logic beyond the two new
 * states above; the metrics are additive projections of the same rows.
 *
 * CADENCE is configurable per job via ScheduledJob.expectedEveryHours
 * (lib/jobs/registry.ts, optional — absent means daily). GRACE absorbs slot
 * jitter and dispatch latency.
 *
 * SURFACING DECISION (recorded): /api/health is deliberately NOT extended —
 * its own OPS-1 header freezes "Explicitly NOT exposed: … queue/job state",
 * its test pins the response keys, and it is unauthenticated. The authorized
 * platform surface is app/api/platform/platform-ops/job-health (PO1.2), which
 * consumes this helper; scripts/check-job-health.ts is the operator CLI.
 *
 * DELIBERATELY NOT HERE (scope fence): emails, notifications, Slack/PagerDuty,
 * dashboards, telemetry, metrics stores, retries, queues, and any WRITE (incl.
 * a manual-run trigger). This slice DETECTS and REPORTS over the existing
 * ledger; acting on a detection, and producing manual runs, are other slices.
 */

import { db } from "@/lib/db";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";

/** Slot jitter / dispatch latency allowance on top of the cadence. */
export const GRACE_HOURS = 2;
/** Consecutive failed runs before a job is classified "failing". */
export const FAILURE_STREAK_THRESHOLD = 3;
/** A "running" row older than this is a crashed run (no completion write). */
export const STALE_RUNNING_HOURS = 2;
/**
 * Missed-cadence multiple past which "overdue" escalates to "dead". At the
 * default daily cadence: overdue at 26h, dead at 72h (three missed cycles) —
 * a distinction between a single late slot and a stopped schedule, not a
 * cosmetic relabel.
 */
export const DEAD_CADENCE_MULTIPLE = 3;
/**
 * Recent runs pulled per job for BOTH classification and the rich metrics
 * (success rate / averages / manual-run count are meaningful only over a
 * window). Newest-first; the streak scan stops at the first non-failure, so a
 * wider window never changes a status — it only deepens the historical stats.
 */
export const HISTORY_EXAMINED = 50;
/** Default cadence when a registry entry does not set expectedEveryHours. */
export const DEFAULT_CADENCE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export type JobHealthStatus =
  | "healthy"
  | "never-ran"
  | "running"
  | "overdue"
  | "dead"
  | "failing";

export interface JobHealthReport {
  job: string;
  status: JobHealthStatus;
  expectedEveryHours: number;
  /** startedAt of the newest run; null when never-ran. */
  lastStartedAt: Date | null;
  /** JobRun.status of the newest run; null when never-ran. */
  lastRunStatus: string | null;
  /** completedAt of the newest COMPLETED run; null when none has completed. */
  lastCompletedAt: Date | null;
  /** Leading failed runs (stale-running counts; a recent running breaks it). */
  consecutiveFailures: number;

  // ── OPS-5 S2 rich metrics — additive projections of the same window ──────────
  /** Rows considered in the window (capped at HISTORY_EXAMINED). */
  totalRuns: number;
  /** succeeded runs in the window. */
  succeededRuns: number;
  /** failed runs in the window. */
  failedRuns: number;
  /** trigger === "manual" runs in the window (0 until a producer exists). */
  manualRuns: number;
  /** durationMs of the most recent run that has one; null if none. */
  lastRuntimeMs: number | null;
  /** mean durationMs over succeeded runs in the window; null if none. */
  avgRuntimeMs: number | null;
  /** succeeded / (succeeded + failed) over the window; null if none completed. */
  successRate: number | null;
  /** startedAt of the most recent failed run; null if none in the window. */
  lastFailureAt: Date | null;
  /** errorSummary of that run; null when absent. */
  lastFailureSummary: string | null;
  /** Next scheduled fire time after `now`, from the registry; null if unknown. */
  nextExpectedAt: Date | null;
}

export interface ScheduledJobsHealth {
  /** True only when every registered job is "healthy". */
  healthy: boolean;
  checkedAt: Date;
  jobs: JobHealthReport[];
}

// ── Narrow read-client contract (injection seam for pure tests) ──────────────

export interface JobRunHealthRow {
  startedAt: Date;
  status: string;
  /** Present from the real ledger; optional so pure tests can omit them. */
  completedAt?: Date | null;
  durationMs?: number | null;
  trigger?: string | null;
  errorSummary?: string | null;
}

export interface JobRunReadClient {
  jobRun: {
    findMany(args: {
      where: { jobName: string };
      orderBy: { startedAt: "desc" };
      take: number;
      select: {
        startedAt: true;
        status: true;
        completedAt: true;
        durationMs: true;
        trigger: true;
        errorSummary: true;
      };
    }): Promise<JobRunHealthRow[]>;
  };
}

/** A job as classification sees it: its name, cadence, and (for next-run) slot. */
export type ClassifiableJob = Pick<ScheduledJob, "name" | "expectedEveryHours"> &
  Partial<Pick<ScheduledJob, "hourUTC" | "minuteUTC">>;

// ── Pure helpers ────────────────────────────────────────────────────────────

/** True when this run counts as a failure for the streak. */
function isFailureForStreak(run: JobRunHealthRow, now: Date): boolean {
  if (run.status === "failed") return true;
  if (run.status === "running") {
    return now.getTime() - run.startedAt.getTime() > STALE_RUNNING_HOURS * HOUR_MS;
  }
  return false;
}

/**
 * The next scheduled fire time strictly after `now`, derived from a job's
 * registry slot(s). JobRun records only the past, so "next expected run" comes
 * from the schedule — not lastStartedAt + cadence, which drifts and cannot
 * answer for a never-ran job. Pure; returns null when the slot is unknown
 * (e.g. a bare {name} in a unit test). Distinct from dispatch.dueJobs(), which
 * asks the backward-looking "is a job due at this tick?".
 */
export function nextExpectedRun(
  hourUTC: number | number[] | undefined,
  minuteUTC: 0 | 30 | undefined,
  now: Date,
): Date | null {
  if (hourUTC === undefined || minuteUTC === undefined) return null;
  const hours = (Array.isArray(hourUTC) ? [...hourUTC] : [hourUTC]).sort((a, b) => a - b);
  // Today's remaining slots, then tomorrow's first — Date.UTC handles rollover.
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const h of hours) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, minuteUTC, 0, 0),
      );
      if (d.getTime() > now.getTime()) return d;
    }
  }
  return null;
}

// ── Pure classification + metrics ─────────────────────────────────────────────

/**
 * Classify one job from its recent runs and derive its rich metrics — pure and
 * fully deterministic given a fixed clock and window. Status precedence:
 * never-ran → running → dead → overdue → failing → healthy.
 */
export function classifyJobHealth(
  job: ClassifiableJob,
  runs: readonly JobRunHealthRow[],
  now: Date,
): JobHealthReport {
  const expectedEveryHours = job.expectedEveryHours ?? DEFAULT_CADENCE_HOURS;
  const nextExpectedAt = nextExpectedRun(job.hourUTC, job.minuteUTC, now);

  // Metrics over the whole provided window — one pass, newest-first order.
  let succeededRuns = 0;
  let failedRuns = 0;
  let manualRuns = 0;
  let runtimeSum = 0;
  let runtimeCount = 0;
  let lastRuntimeMs: number | null = null;
  let lastCompletedAt: Date | null = null;
  let lastFailureAt: Date | null = null;
  let lastFailureSummary: string | null = null;

  for (const r of runs) {
    if (r.trigger === "manual") manualRuns++;
    if (r.status === "succeeded") {
      succeededRuns++;
      if (typeof r.durationMs === "number") {
        runtimeSum += r.durationMs;
        runtimeCount++;
      }
    } else if (r.status === "failed") {
      failedRuns++;
      if (lastFailureAt === null) {
        lastFailureAt = r.startedAt;
        lastFailureSummary = r.errorSummary ?? null;
      }
    }
    if (lastRuntimeMs === null && typeof r.durationMs === "number") lastRuntimeMs = r.durationMs;
    if (lastCompletedAt === null && r.completedAt != null) lastCompletedAt = r.completedAt;
  }

  const completed = succeededRuns + failedRuns;
  const metrics = {
    totalRuns: runs.length,
    succeededRuns,
    failedRuns,
    manualRuns,
    lastRuntimeMs,
    avgRuntimeMs: runtimeCount > 0 ? Math.round(runtimeSum / runtimeCount) : null,
    successRate: completed > 0 ? succeededRuns / completed : null,
    lastFailureAt,
    lastFailureSummary,
    lastCompletedAt,
    nextExpectedAt,
  };

  const base = { job: job.name, expectedEveryHours, ...metrics };

  if (runs.length === 0) {
    return { ...base, status: "never-ran", lastStartedAt: null, lastRunStatus: null, consecutiveFailures: 0 };
  }

  const last = runs[0];
  let consecutiveFailures = 0;
  for (const run of runs) {
    // A recent in-flight run breaks the streak (it may yet succeed).
    if (!isFailureForStreak(run, now)) break;
    consecutiveFailures++;
  }

  const detail = {
    lastStartedAt: last.startedAt,
    lastRunStatus: last.status,
    consecutiveFailures,
  };

  // In-flight right now — a fresh "running" row. Precedes the age-based states
  // (its age is small by definition) and is strictly more informative than the
  // "healthy" it would otherwise fall through to.
  if (last.status === "running" && !isFailureForStreak(last, now)) {
    return { ...base, status: "running", ...detail };
  }

  const ageMs = now.getTime() - last.startedAt.getTime();
  if (ageMs > expectedEveryHours * DEAD_CADENCE_MULTIPLE * HOUR_MS) {
    return { ...base, status: "dead", ...detail };
  }
  if (ageMs > (expectedEveryHours + GRACE_HOURS) * HOUR_MS) {
    return { ...base, status: "overdue", ...detail };
  }
  if (consecutiveFailures >= FAILURE_STREAK_THRESHOLD) {
    return { ...base, status: "failing", ...detail };
  }
  return { ...base, status: "healthy", ...detail };
}

// ── The detector ──────────────────────────────────────────────────────────────

/**
 * Check every registered job against the JobRun ledger. Read-only; structured,
 * deterministic output (given a fixed clock and ledger). One findMany per job
 * over the shared HISTORY_EXAMINED window feeds both status and metrics.
 */
export async function checkScheduledJobHealth(
  client: JobRunReadClient = db as unknown as JobRunReadClient,
  now: Date = new Date(),
  jobs: readonly ScheduledJob[] = SCHEDULED_JOBS,
): Promise<ScheduledJobsHealth> {
  const reports: JobHealthReport[] = [];

  for (const job of jobs) {
    const runs = await client.jobRun.findMany({
      where: { jobName: job.name },
      orderBy: { startedAt: "desc" },
      take: HISTORY_EXAMINED,
      select: {
        startedAt: true,
        status: true,
        completedAt: true,
        durationMs: true,
        trigger: true,
        errorSummary: true,
      },
    });
    reports.push(classifyJobHealth(job, runs, now));
  }

  return {
    healthy: reports.every((r) => r.status === "healthy"),
    checkedAt: now,
    jobs: reports,
  };
}
