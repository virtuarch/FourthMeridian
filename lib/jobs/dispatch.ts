/**
 * lib/jobs/dispatch.ts  (OPS-4 S2)
 *
 * The dispatcher: selects the registry entries due at the current half-hour
 * slot and executes each through runJob() with per-job isolation. Invoked by
 * the single Vercel cron endpoint (app/api/jobs/dispatch/route.ts).
 *
 * RESPONSIBILITIES (frozen S2 scope): dispatch · sequencing (registry
 * order) · runJob wrapping · isolation (one failing job can never block a
 * sibling) · logging. NOTHING ELSE — no retries, no dead-job detection, no
 * digests, no metrics (S3+/PO1 by the S0 rulings).
 *
 * SLOT MATCHING: a job is due when the invocation time falls in its
 * half-hour UTC slot (hourUTC + minuteUTC..minuteUTC+29). Deliberately NOT
 * exact-minute matching: Vercel may fire a cron a few minutes late, and a
 * late tick must not silently skip the slot's job. The single cron fires
 * only at registered slots (vercel.json), so slots without entries are
 * no-op ticks, logged and cheap.
 *
 * ISOLATION & OUTCOME: each job runs in its own try/catch; a failure is
 * ledgered by runJob (status "failed"), logged here, recorded in the
 * outcome, and the loop continues. The route maps any failure to a 500 so
 * a failed slot stays visible in Vercel's cron dashboard — the same signal
 * the three pre-S2 per-job crons produced.
 */

import { runJob, summarizeError, type JobTrigger } from "@/lib/jobs/run";
import { SCHEDULED_JOBS, type ScheduledJob } from "@/lib/jobs/registry";

/** Per-job outcome of one dispatch tick. */
export interface DispatchOutcome {
  job: string;
  ok: boolean;
  /** Truncated message when ok = false (details live in the JobRun row). */
  error?: string;
}

export interface DispatchResult {
  /** The matched slot, e.g. "06:30 UTC". */
  slot: string;
  dispatched: DispatchOutcome[];
  failures: number;
}

/** The half-hour slot (0 or 30) a date falls in. */
function slotMinute(date: Date): 0 | 30 {
  return date.getUTCMinutes() < 30 ? 0 : 30;
}

/** Pure selection: the registry entries due at `now`'s half-hour UTC slot. */
export function dueJobs(
  now: Date,
  jobs: readonly ScheduledJob[] = SCHEDULED_JOBS,
): ScheduledJob[] {
  const hour = now.getUTCHours();
  const minute = slotMinute(now);
  return jobs.filter((j) => j.hourUTC === hour && j.minuteUTC === minute);
}

/** Test injection seam — production callers never pass `runner`. */
export type JobRunner = (
  name: string,
  fn: () => Promise<unknown>,
  options: { trigger: JobTrigger },
) => Promise<unknown>;

/**
 * Run every job due at `now`, sequentially in registry order, each through
 * runJob() (individually ledgered), each isolated. Never throws: failures
 * are returned in the outcome.
 */
export async function dispatchDueJobs(
  now: Date,
  opts?: { jobs?: readonly ScheduledJob[]; runner?: JobRunner },
): Promise<DispatchResult> {
  const runner: JobRunner = opts?.runner ?? runJob;
  const due = dueJobs(now, opts?.jobs);
  const slot = `${String(now.getUTCHours()).padStart(2, "0")}:${String(slotMinute(now)).padStart(2, "0")} UTC`;

  if (due.length === 0) {
    console.log(`[dispatch] ${slot}: no jobs due — no-op tick`);
    return { slot, dispatched: [], failures: 0 };
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

  console.log(`[dispatch] ${slot}: ${dispatched.length} job(s) run, ${failures} failed`);
  return { slot, dispatched, failures };
}
