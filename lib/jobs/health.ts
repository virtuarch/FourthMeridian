/**
 * lib/jobs/health.ts  (OPS-4 S5)
 *
 * THE dead-job detector — a read-only pass over the JobRun ledger that
 * answers "did every registered job run when it should have, and is any of
 * them silently broken?". One implementation, no second execution-tracking
 * mechanism: the S1 ledger is the ONLY source (this module performs zero
 * writes and creates no tables).
 *
 * DETECTION POLICY (per registered job, priority order):
 *   never-ran  no JobRun row exists for the name — the job has never left
 *              a corpse (a just-registered job reports this until its first
 *              slot fires; the operator decides).
 *   overdue    the newest run started more than expectedEveryHours (default
 *              24 — every current job is daily) + GRACE_HOURS ago — the
 *              schedule has silently stopped (dead cron, dead dispatcher,
 *              deregistered job with history).
 *   failing    the last FAILURE_STREAK_THRESHOLD (3) runs all failed — the
 *              job runs on time but is broken. A "running" row older than
 *              STALE_RUNNING_HOURS counts as a failure in the streak (the
 *              process died before its completion write — S1's documented
 *              crash shape); a RECENT "running" row is in-flight and
 *              healthy.
 *   healthy    none of the above.
 *
 * CADENCE is configurable per job via ScheduledJob.expectedEveryHours
 * (lib/jobs/registry.ts, optional — absent means daily). GRACE absorbs slot
 * jitter and dispatch latency.
 *
 * SURFACING DECISION (recorded): /api/health is deliberately NOT extended —
 * its own OPS-1 header freezes "Explicitly NOT exposed: … queue/job state",
 * its test pins the response keys, and it is unauthenticated. Operators use
 * scripts/check-job-health.ts (this helper over the real client); a future
 * admin panel (PO1 Phase 4) can consume the same helper unchanged.
 *
 * DELIBERATELY NOT HERE (S5 scope fence): emails, notifications, Slack/
 * PagerDuty, dashboards, telemetry, metrics, retries, queues. This slice
 * DETECTS; acting on a detection is the operator's job (and later PO1's).
 */

import { db } from "@/lib/db";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";

/** Slot jitter / dispatch latency allowance on top of the cadence. */
export const GRACE_HOURS = 2;
/** Consecutive failed runs before a job is classified "failing". */
export const FAILURE_STREAK_THRESHOLD = 3;
/** A "running" row older than this is a crashed run (no completion write). */
export const STALE_RUNNING_HOURS = 2;
/** Recent runs examined per job for the failure streak. */
const RUNS_EXAMINED = 5;
/** Default cadence when a registry entry does not set expectedEveryHours. */
export const DEFAULT_CADENCE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export type JobHealthStatus = "healthy" | "never-ran" | "overdue" | "failing";

export interface JobHealthReport {
  job: string;
  status: JobHealthStatus;
  expectedEveryHours: number;
  /** startedAt of the newest run; null when never-ran. */
  lastStartedAt: Date | null;
  /** JobRun.status of the newest run; null when never-ran. */
  lastRunStatus: string | null;
  /** Leading failed runs (stale-running counts; a recent running breaks it). */
  consecutiveFailures: number;
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
}

export interface JobRunReadClient {
  jobRun: {
    findMany(args: {
      where: { jobName: string };
      orderBy: { startedAt: "desc" };
      take: number;
      select: { startedAt: true; status: true };
    }): Promise<JobRunHealthRow[]>;
  };
}

// ── Pure classification ───────────────────────────────────────────────────────

/** True when this run counts as a failure for the streak. */
function isFailureForStreak(run: JobRunHealthRow, now: Date): boolean {
  if (run.status === "failed") return true;
  if (run.status === "running") {
    return now.getTime() - run.startedAt.getTime() > STALE_RUNNING_HOURS * HOUR_MS;
  }
  return false;
}

/** Classify one job from its recent runs (pure — fully deterministic). */
export function classifyJobHealth(
  job: Pick<ScheduledJob, "name" | "expectedEveryHours">,
  runs: readonly JobRunHealthRow[],
  now: Date,
): JobHealthReport {
  const expectedEveryHours = job.expectedEveryHours ?? DEFAULT_CADENCE_HOURS;
  const base = { job: job.name, expectedEveryHours };

  if (runs.length === 0) {
    return { ...base, status: "never-ran", lastStartedAt: null, lastRunStatus: null, consecutiveFailures: 0 };
  }

  const last = runs[0];
  let consecutiveFailures = 0;
  for (const run of runs) {
    // A recent in-flight run breaks the streak (it may yet succeed).
    if (run.status === "running" && !isFailureForStreak(run, now)) break;
    if (!isFailureForStreak(run, now)) break;
    consecutiveFailures++;
  }

  const detail = {
    lastStartedAt: last.startedAt,
    lastRunStatus: last.status,
    consecutiveFailures,
  };

  const ageMs = now.getTime() - last.startedAt.getTime();
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
 * Check every registered job against the JobRun ledger. Read-only;
 * structured, deterministic output (given a fixed clock and ledger).
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
      take: RUNS_EXAMINED,
      select: { startedAt: true, status: true },
    });
    reports.push(classifyJobHealth(job, runs, now));
  }

  return {
    healthy: reports.every((r) => r.status === "healthy"),
    checkedAt: now,
    jobs: reports,
  };
}
