/**
 * lib/platform/scheduler/observation.ts  (OPS-2C-7)
 *
 * THE scheduler observation authority. It COMPOSES existing authorities and
 * re-derives none of them:
 *
 *   • `checkScheduledJobHealth` (lib/jobs/health.ts) — the overdue/dead verdict.
 *     Read, never recomputed; there is one dead-job detector and it is not here.
 *   • `nextExpectedRun` (same authority) — lastStart + cadence, the dispatcher's
 *     own arithmetic (P1: there are no slots left to read a "next slot" from).
 *   • `selectDueJobs` (lib/jobs/dispatch.ts) — the PURE selection the dispatcher
 *     itself uses. Reusing it is what makes "what runs at the next due instant"
 *     deterministic rather than a second reading of the registry.
 *   • the `JobRun` ledger — for observed executions and the per-job facts.
 *
 * PURE CORE + INJECTED I/O: every derivation lives in observation-core.ts; this
 * file supplies readers, replaced by fakes in tests.
 *
 * NO WRITES, NO HEALTH VERDICT OF ITS OWN, NO POLICY. Whether a job *should* be
 * paused, resumed, disabled, or rescheduled is OPS-2D and does not exist here.
 */

import "server-only";

import { db } from "@/lib/db";
import { loadJobLedgerFacts, selectDueJobs, type JobLedgerFacts, type JobLedgerReadClient } from "@/lib/jobs/dispatch";
import { checkScheduledJobHealth, nextExpectedRun } from "@/lib/jobs/health";
import { defaultJobCadencePolicies, loadJobCadencePolicies, type JobCadencePolicies } from "@/lib/jobs/cadence-policy";
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
  /** P1 — the newest run per job and the resolved cadences, for the next-due derivation. */
  dueInputs?(): Promise<{ facts: JobLedgerFacts; policies: JobCadencePolicies }>;
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
    async dueInputs() {
      const [facts, policies] = await Promise.all([
        loadJobLedgerFacts(db as unknown as JobLedgerReadClient, SCHEDULED_JOBS),
        loadJobCadencePolicies(db, SCHEDULED_JOBS),
      ]);
      return { facts, policies };
    },
  };
}

/**
 * The next instant any registered job becomes due, and which jobs are due then.
 *
 * DETERMINISTIC FROM THE LEDGER AND THE CADENCE POLICY. For each primary job
 * `nextExpectedRun` gives lastStart + cadence (a never-ran job is due NOW); the
 * earliest is the next due instant, clamped to `now`. `selectDueJobs` — the
 * dispatcher's own pure selector — then answers what runs at that instant, so
 * this can never disagree with what the dispatcher would actually pick.
 * Continuations have no clock of their own and never set the instant.
 */
export function deriveNextSlot(
  jobs: readonly ScheduledJob[],
  now: Date,
  facts: JobLedgerFacts,
  policies: JobCadencePolicies,
): { at: Date | null; jobs: string[] } {
  let earliest: Date | null = null;
  for (const job of jobs) {
    if (job.continuationOf) continue;
    const policy = policies.get(job.name);
    if (!policy) continue;
    const fact = facts.get(job.name);
    const next = fact?.lastStartedAt ? nextExpectedRun(fact.lastStartedAt, policy.hours) : now;
    const at = next && next.getTime() < now.getTime() ? now : next;
    if (at && (earliest == null || at < earliest)) earliest = at;
  }
  if (!earliest) return { at: null, jobs: [] };
  return { at: earliest, jobs: selectDueJobs(earliest, jobs, facts, policies).due.map((j) => j.name) };
}

/**
 * The next due instant from the LIVE ledger and cadence policy — the one-call
 * form for consumers that need only the instant (the Overview's "Next slot").
 */
export async function deriveNextDueFromLedger(
  now: Date,
  jobs: readonly ScheduledJob[] = SCHEDULED_JOBS,
): Promise<{ at: Date | null; jobs: string[] }> {
  const [facts, policies] = await Promise.all([
    loadJobLedgerFacts(db as unknown as JobLedgerReadClient, jobs),
    loadJobCadencePolicies(db, jobs),
  ]);
  return deriveNextSlot(jobs, now, facts, policies);
}

/** THE scheduler observation. Read-only. */
export async function getSchedulerObservation(
  deps?: SchedulerObservationDeps,
): Promise<SchedulerObservation & { checkedAt: string }> {
  const readers = deps?.readers ?? realReaders(new Date());
  const jobs = deps?.jobs ?? SCHEDULED_JOBS;
  const now = readers.now;

  const from = new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000);
  const [runs, health, due] = await Promise.all([
    readers.runsInWindow(from, now),
    readers.health(now),
    readers.dueInputs ? readers.dueInputs() : Promise.resolve({ facts: new Map() as JobLedgerFacts, policies: defaultJobCadencePolicies(jobs) }),
  ]);

  const slot = deriveNextSlot(jobs, now, due.facts, due.policies);

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
