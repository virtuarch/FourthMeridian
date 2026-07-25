/**
 * lib/platform/scheduler/observation-core.ts  (OPS-2C-7 — Scheduler Observation)
 *
 * The PURE derivations behind the scheduler observation surface. No Prisma, no
 * clock beyond the injected `now`, no I/O.
 *
 * ── THE THREE-WAY STRUCTURE IS THE WHOLE POINT ────────────────────────────────
 *
 *     OBSERVED   →   EXPECTED   →   OPERATIONAL NOTES
 *
 *   OBSERVED  only facts the ledger actually recorded. Every figure here is a
 *             row that exists.
 *   EXPECTED  only deterministic derivations from the code-owned registry. No
 *             figure here is evidence of anything happening — it is what the
 *             configuration says *should* happen.
 *   NOTES     explanation only. NO figures. A number in a note is a figure
 *             smuggled past the boundary that separates observation from
 *             expectation, which is exactly the confusion this shape prevents.
 *
 * Figures are never mixed across the groups, and the types enforce it: the three
 * groups are separate objects and `notes` is `readonly string[]`.
 *
 * ── WHAT THIS SURFACE REFUSES TO SAY ──────────────────────────────────────────
 * There is no "scheduler health", "dispatcher healthy", or "scheduler OK" —
 * no such authority exists, and inventing a green verdict over a subsystem
 * nobody measures is the false-green defect that created Platform Ops.
 *
 * There is NO "last tick". The dispatcher persists nothing about its own
 * invocation: `dispatchDueJobs` logs a line and returns, and on a slot with no
 * due jobs it writes no row at all. So a tick is UNOBSERVABLE, and the closest
 * true statement — "the last execution we recorded" — is a different fact and is
 * labelled as such. Reporting job executions as ticks would assert an
 * observation nobody made.
 */

import type { ScheduledJob } from "@/lib/jobs/registry";
import type { JobHealthReport } from "@/lib/jobs/health";

// ── OBSERVED ────────────────────────────────────────────────────────────────────

/** One job the ledger has recorded but the registry does not declare. */
export interface ExternalCronObservation {
  /** `JobRun.jobName` as recorded. */
  job: string;
  /** Newest recorded start, or null when the window holds none. */
  lastRecordedExecutionAt: string | null;
  /** Recorded executions inside the window. An observed count. */
  recordedExecutions: number;
  /**
   * Always false — that is the point. It is scheduled outside `SCHEDULED_JOBS`,
   * so `checkScheduledJobHealth` never sees it: no health report, no alerting.
   * It is surfaced as an architectural GAP, never folded in with registry jobs
   * and never given a fabricated health state.
   */
  registered: false;
}

export interface SchedulerObserved {
  /**
   * Newest `JobRun.startedAt` across every job. This is the last execution we
   * RECORDED — deliberately not called a tick (see the module header).
   */
  lastRecordedExecutionAt: string | null;
  /** Executions recorded in the window. Observed. */
  recordedExecutions: number;
  /**
   * Registry jobs whose health authority says they are overdue or dead. Read
   * from `classifyJobHealth` — never recomputed here.
   */
  overdue: readonly { job: string; status: string; lastStartedAt: string | null }[];
  /** Jobs observed in the ledger that the registry does not declare. */
  externalCrons: readonly ExternalCronObservation[];
}

// ── EXPECTED ────────────────────────────────────────────────────────────────────

export interface SchedulerExpected {
  /**
   * The next slot the REGISTRY declares, derived deterministically from the
   * declared fire hours/minutes. This is configuration, not evidence: whether
   * the dispatcher is actually invoked then depends on deploy config the
   * platform does not own (see the notes).
   */
  nextSlotAt: string | null;
  /** Registry jobs declared to fire in that slot. Configuration. */
  jobsInNextSlot: readonly string[];
  /** How many jobs the registry declares. Configuration. */
  registeredJobs: number;
}

// ── The whole observation ───────────────────────────────────────────────────────

export interface SchedulerObservation {
  observed: SchedulerObserved;
  expected: SchedulerExpected;
  /** Explanation only. Never a figure. */
  notes: readonly string[];
  window: { from: string; to: string };
}

/** The ledger facts this derivation needs. */
export interface SchedulerRunFact {
  jobName: string;
  startedAt: Date;
}

/**
 * The fixed operational notes. PROSE ONLY — no counts, no dates, no thresholds
 * rendered as observations. Each states a limit of what this surface can know.
 */
export const SCHEDULER_NOTES: readonly string[] = [
  "Dispatcher invocations are not recorded. A slot with no due jobs writes nothing, so ticks cannot be counted — only executions that happened can be.",
  "A silent dispatcher surfaces as overdue work, not here.",
  "Expected slots come from the job registry in code. Whether the dispatcher is actually invoked at those times depends on deployment configuration this platform does not own.",
];

/** Appended only when an unregistered job was actually observed. Still prose. */
export const EXTERNAL_CRON_NOTE =
  "One or more jobs run on their own schedule outside the registry. They leave execution rows but have no health report and no alert coverage.";

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Build the observation.
 *
 * `nextSlot` is injected rather than computed here so this stays a total
 * function of its inputs — the caller derives it through the job-health
 * authority's own `nextExpectedRun`, which already owns slot arithmetic.
 */
export function buildSchedulerObservation(args: {
  jobs: readonly ScheduledJob[];
  health: readonly JobHealthReport[];
  runs: readonly SchedulerRunFact[];
  nextSlotAt: Date | null;
  jobsInNextSlot: readonly string[];
  window: { from: string; to: string };
}): SchedulerObservation {
  const { jobs, health, runs, nextSlotAt, jobsInNextSlot, window } = args;

  const registered = new Set(jobs.map((j) => j.name));

  // OBSERVED — every figure below is a row that exists.
  const newest = runs.reduce<Date | null>(
    (acc, r) => (acc == null || r.startedAt > acc ? r.startedAt : acc),
    null,
  );

  // Read the health authority's verdict; never recompute overdue here.
  const overdue = health
    .filter((h) => h.status === "overdue" || h.status === "dead")
    .map((h) => ({ job: h.job, status: h.status, lastStartedAt: iso(h.lastStartedAt) }))
    .sort((a, b) => a.job.localeCompare(b.job));

  // Observed-but-unregistered: the ledger knows a job the registry does not.
  const byExternal = new Map<string, SchedulerRunFact[]>();
  for (const r of runs) {
    if (registered.has(r.jobName)) continue;
    const bucket = byExternal.get(r.jobName);
    if (bucket) bucket.push(r);
    else byExternal.set(r.jobName, [r]);
  }
  const externalCrons: ExternalCronObservation[] = [...byExternal.keys()]
    .sort()
    .map((job) => {
      const rows = byExternal.get(job)!;
      const last = rows.reduce<Date | null>(
        (acc, r) => (acc == null || r.startedAt > acc ? r.startedAt : acc),
        null,
      );
      return {
        job,
        lastRecordedExecutionAt: iso(last),
        recordedExecutions: rows.length,
        registered: false as const,
      };
    });

  return {
    observed: {
      lastRecordedExecutionAt: iso(newest),
      recordedExecutions: runs.length,
      overdue,
      externalCrons,
    },
    expected: {
      nextSlotAt: iso(nextSlotAt),
      jobsInNextSlot: [...jobsInNextSlot].sort(),
      registeredJobs: jobs.length,
    },
    notes: externalCrons.length > 0 ? [...SCHEDULER_NOTES, EXTERNAL_CRON_NOTE] : SCHEDULER_NOTES,
    window,
  };
}
