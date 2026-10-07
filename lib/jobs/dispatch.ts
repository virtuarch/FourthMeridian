/**
 * lib/jobs/dispatch.ts  (OPS-4 S2 · P1 scheduling control)
 *
 * The dispatcher: on every wake, decide from the LEDGER and the CADENCE POLICY
 * which registered jobs are due, and execute each through runJob() with per-job
 * isolation. Invoked by the single Vercel cron endpoint
 * (app/api/jobs/dispatch/route.ts), which now wakes every 15 minutes.
 *
 * RESPONSIBILITIES (unchanged fence): dispatch · sequencing (registry order) ·
 * runJob wrapping · isolation (one failing job can never block a sibling) ·
 * logging. NOTHING ELSE — no retries, no dead-job detection, no digests.
 *
 * ── P1: DUE-NESS IS A LEDGER FACT, NOT A SLOT ────────────────────────────────
 * Until P1 a job was due when the wake fell in its half-hour UTC slot, so the
 * registry's fire hours WERE the execution policy and changing Plaid's
 * frequency meant editing code and vercel.json. Now:
 *
 *   • each job's cadence is resolved by lib/jobs/cadence-policy.core.ts
 *     (refresh policy · bounded operator setting · fixed);
 *   • a job is due when it never ran, or its newest run started at least
 *     (cadence − tolerance) ago;
 *   • a job whose newest row is `running` and younger than the in-flight window
 *     is NOT due — the overlap guard: two wakes never execute one job twice;
 *   • a continuation is due only when its primary's newest run reported
 *     deferred work, enough time has passed, and it has not run since.
 *
 * The decision is pure (selectDueJobs); only the facts are read here. Every
 * wake returns what it considered and why it skipped — counts and job names,
 * never user content.
 */

import { runJob, summarizeError, type JobTrigger } from "@/lib/jobs/run";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";
import { systemDb } from "@/lib/db";
import { loadJobCadencePolicies, type JobCadencePolicies } from "@/lib/jobs/cadence-policy";
import {
  decideJobDue, type JobDueDecision, type JobLedgerFact,
} from "@/lib/jobs/cadence-policy.core";

/** Per-job outcome of one dispatch wake. */
export interface DispatchOutcome {
  job: string;
  ok: boolean;
  /** Truncated message when ok = false (details live in the JobRun row). */
  error?: string;
}

export interface DispatchSkip {
  job: string;
  reason: Extract<JobDueDecision, { due: false }>["reason"];
  nextDueAt: string | null;
}

export interface DispatchResult {
  /** The wake instant, e.g. "06:15 UTC". */
  slot: string;
  /** Every registered job was considered; these were not due. */
  skipped: DispatchSkip[];
  dispatched: DispatchOutcome[];
  failures: number;
}

/** The ledger facts the selection needs, per job name. */
export type JobLedgerFacts = ReadonlyMap<string, JobLedgerFact>;

export interface DueSelection {
  due: ScheduledJob[];
  skipped: DispatchSkip[];
}

/** Pure selection: the registry entries due at `now`, given the ledger facts and cadence policies. */
export function selectDueJobs(
  now: Date,
  jobs: readonly ScheduledJob[],
  facts: JobLedgerFacts,
  policies: JobCadencePolicies,
): DueSelection {
  const due: ScheduledJob[] = [];
  const skipped: DispatchSkip[] = [];
  for (const job of jobs) {
    const policy = policies.get(job.name);
    if (!policy) { skipped.push({ job: job.name, reason: "NOT_YET_DUE", nextDueAt: null }); continue; }
    const decision = decideJobDue(job, policy, facts.get(job.name), now, job.continuationOf ? facts.get(job.continuationOf) : null);
    if (decision.due) due.push(job);
    else skipped.push({ job: job.name, reason: decision.reason, nextDueAt: decision.nextDueAt?.toISOString() ?? null });
  }
  return { due, skipped };
}

// ── Facts ─────────────────────────────────────────────────────────────────────

export interface JobLedgerReadClient {
  jobRun: {
    findMany(args: {
      where: { jobName: { in: string[] } };
      orderBy: { startedAt: "desc" };
      distinct: ["jobName"];
      select: { jobName: true; startedAt: true; status: true; summary: true };
    }): Promise<{ jobName: string; startedAt: Date; status: string; summary: unknown }[]>;
  };
}

/**
 * One query: the newest JobRun per registered job. A `running` newest row is
 * kept as such (the in-flight guard reads it); its summary is null, so a
 * continuation reads deferred work from the newest COMPLETED primary run only
 * when that is the newest row.
 */
export async function loadJobLedgerFacts(
  client: JobLedgerReadClient,
  jobs: readonly Pick<ScheduledJob, "name">[],
): Promise<JobLedgerFacts> {
  const rows = await client.jobRun.findMany({
    where: { jobName: { in: jobs.map((j) => j.name) } },
    orderBy: { startedAt: "desc" },
    distinct: ["jobName"],
    select: { jobName: true, startedAt: true, status: true, summary: true },
  });
  const facts = new Map<string, JobLedgerFact>();
  for (const r of rows) facts.set(r.jobName, { lastStartedAt: r.startedAt, lastStatus: r.status, lastSummary: r.summary });
  return facts;
}

// ── Execution ─────────────────────────────────────────────────────────────────

/** Test injection seam — production callers never pass `runner`. */
export type JobRunner = (
  name: string,
  fn: () => Promise<unknown>,
  options: { trigger: JobTrigger },
) => Promise<unknown>;

export interface DispatchDeps {
  jobs?: readonly ScheduledJob[];
  runner?: JobRunner;
  /** Injected facts/policies (tests). Production reads both. */
  facts?: JobLedgerFacts;
  policies?: JobCadencePolicies;
}

const wakeLabel = (now: Date) =>
  `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;

/**
 * Run every job due at `now`, sequentially in registry order, each through
 * runJob() (individually ledgered), each isolated. Never throws: failures
 * are returned in the outcome.
 */
export async function dispatchDueJobs(now: Date, opts?: DispatchDeps): Promise<DispatchResult> {
  const runner: JobRunner = opts?.runner ?? runJob;
  const jobs = opts?.jobs ?? SCHEDULED_JOBS;
  const facts = opts?.facts ?? await loadJobLedgerFacts(systemDb as unknown as JobLedgerReadClient, jobs);
  const policies = opts?.policies ?? await loadJobCadencePolicies(systemDb, jobs);
  const { due, skipped } = selectDueJobs(now, jobs, facts, policies);
  const slot = wakeLabel(now);

  if (due.length === 0) {
    console.log(`[dispatch] ${slot}: no jobs due — no-op wake (${skipped.length} considered)`);
    return { slot, skipped, dispatched: [], failures: 0 };
  }

  const dispatched: DispatchOutcome[] = [];
  let failures = 0;

  for (const job of due) {
    try {
      await runner(job.name, job.run, { trigger: "cron" });
      dispatched.push({ job: job.name, ok: true });
    } catch (err) {
      // Isolation: the failure is already ledgered by runJob; record and
      // continue — one job can never block a sibling.
      failures++;
      dispatched.push({ job: job.name, ok: false, error: summarizeError(err) });
      console.error(`[dispatch] ${slot}: job "${job.name}" failed (siblings continue):`, err);
    }
  }

  console.log(`[dispatch] ${slot}: ${dispatched.length} job(s) run, ${failures} failed, ${skipped.length} not due`);
  return { slot, skipped, dispatched, failures };
}
