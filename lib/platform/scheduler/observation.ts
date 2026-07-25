/**
 * lib/platform/scheduler/observation.ts  (OPS-2C-7)
 *
 * THE scheduler observation authority. It COMPOSES existing authorities and
 * re-derives none of them:
 *
 *   • `checkScheduledJobHealth` (lib/jobs/health.ts) — the overdue/dead verdict.
 *     Read, never recomputed; there is one dead-job detector and it is not here.
 *   • `nextExpectedRun` (same authority) — slot arithmetic already owned there.
 *   • `dueJobs` (lib/jobs/dispatch.ts) — the PURE selection the dispatcher itself
 *     uses to decide what fires. Reusing it is what makes "what fires next"
 *     deterministic rather than a second reading of the registry.
 *   • the `JobRun` ledger — for observed executions only.
 *
 * PURE CORE + INJECTED I/O: every derivation lives in observation-core.ts; this
 * file supplies readers, replaced by fakes in tests.
 *
 * NO WRITES, NO HEALTH VERDICT OF ITS OWN, NO POLICY. Whether a job *should* be
 * paused, resumed, disabled, or rescheduled is OPS-2D and does not exist here.
 */

import "server-only";

import { db } from "@/lib/db";
import { dueJobs } from "@/lib/jobs/dispatch";
import { checkScheduledJobHealth, nextExpectedRun } from "@/lib/jobs/health";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";
import {
  buildSchedulerObservation,
  type SchedulerObservation,
  type SchedulerRunFact,
} from "@/lib/platform/scheduler/observation-core";

/** Observation window for the recorded-execution figures. */
const DEFAULT_WINDOW_HOURS = 24;
/** Bounds the ledger read; operational windows are small. */
const MAX_RUNS = 2_000;

export interface SchedulerObservationReaders {
  now: Date;
  /** Every JobRun started in the window — ANY jobName, registered or not. */
  runsInWindow(from: Date, to: Date): Promise<SchedulerRunFact[]>;
  /** The job-health authority's reports. Read, never recomputed. */
  health(now: Date): Promise<{ jobs: { job: string; status: string; lastStartedAt: Date | null }[] }>;
}

export interface SchedulerObservationDeps {
  readers?: SchedulerObservationReaders;
  jobs?: readonly ScheduledJob[];
}

function realReaders(now: Date): SchedulerObservationReaders {
  return {
    now,
    async runsInWindow(from, to) {
      return db.jobRun.findMany({
        where: { startedAt: { gte: from, lte: to } },
        // Deliberately NOT filtered to SCHEDULED_JOBS: a job the ledger knows and
        // the registry does not is exactly the architectural gap this surface exists
        // to disclose.
        select: { jobName: true, startedAt: true },
        orderBy: { startedAt: "desc" },
        take: MAX_RUNS,
      });
    },
    async health(at) {
      const report = await checkScheduledJobHealth(undefined, at);
      return {
        jobs: report.jobs.map((j) => ({
          job: j.job,
          status: j.status,
          lastStartedAt: j.lastStartedAt,
        })),
      };
    },
  };
}

/**
 * The next slot the registry declares, and which jobs it declares for it.
 *
 * DETERMINISTIC FROM CONFIGURATION ONLY. `nextExpectedRun` gives each job's next
 * declared fire time; the earliest is the next slot. `dueJobs` — the dispatcher's
 * own pure selector — then answers what fires at that instant, so this can never
 * disagree with what the dispatcher would actually pick.
 */
export function deriveNextSlot(
  jobs: readonly ScheduledJob[],
  now: Date,
): { at: Date | null; jobs: string[] } {
  let earliest: Date | null = null;
  for (const job of jobs) {
    const next = nextExpectedRun(job.hourUTC, job.minuteUTC, now);
    if (next && (earliest == null || next < earliest)) earliest = next;
  }
  if (!earliest) return { at: null, jobs: [] };
  return { at: earliest, jobs: dueJobs(earliest, jobs).map((j) => j.name) };
}

/** THE scheduler observation. Read-only. */
export async function getSchedulerObservation(
  deps?: SchedulerObservationDeps,
): Promise<SchedulerObservation & { checkedAt: string }> {
  const readers = deps?.readers ?? realReaders(new Date());
  const jobs = deps?.jobs ?? SCHEDULED_JOBS;
  const now = readers.now;

  const from = new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000);
  const [runs, health] = await Promise.all([readers.runsInWindow(from, now), readers.health(now)]);

  const slot = deriveNextSlot(jobs, now);

  const observation = buildSchedulerObservation({
    jobs,
    health: health.jobs as never, // structurally the JobHealthReport subset used
    runs,
    nextSlotAt: slot.at,
    jobsInNextSlot: slot.jobs,
    window: { from: from.toISOString(), to: now.toISOString() },
  });

  return { ...observation, checkedAt: now.toISOString() };
}
