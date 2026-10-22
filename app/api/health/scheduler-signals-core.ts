/**
 * app/api/health/scheduler-signals-core.ts  (OBS-001 / OPS-002)
 *
 * PURE derivation of the non-sensitive `scheduler` block on GET /api/health —
 * the facts an EXTERNAL monitor needs to alert on a silent scheduler without
 * authenticating: when the dispatcher last executed anything, when the alert
 * evaluator last succeeded, whether Vercel's cron is firing at all (the
 * five-minute backstop route leaves a row on every fire), and how many
 * registered jobs are overdue.
 *
 * WHAT IS DELIBERATELY NOT HERE: job names, error summaries, counts of
 * anything user-shaped, the destination mailbox, the commit sha. Timestamps
 * and one integer. A reader of this block learns that the platform's scheduler
 * is alive or not, and nothing else.
 *
 * WHY THIS DUPLICATES ONE CONSTANT. lib/jobs/health.ts owns "overdue" (cadence +
 * GRACE_HOURS); importing it would pull the executable job registry — every
 * job body and the Plaid SDK — into a public, unauthenticated route (the
 * PERF-1 registry boundary). So `OVERDUE_GRACE_HOURS` is restated here and
 * PINNED EQUAL to job health's by route.test.ts; the overdue test itself is the
 * same inequality job health applies.
 */

/** Mirrors lib/jobs/health.ts GRACE_HOURS (pinned by test). */
export const OVERDUE_GRACE_HOURS = 2;

export interface SchedulerSignals {
  /** Newest JobRun.startedAt among REGISTERED jobs — the dispatcher last executed something then. Null: never. */
  lastDispatchAt: string | null;
  /** Newest SUCCEEDED evaluate-alerts run. Null: the evaluator has never completed a cycle. */
  lastAlertEvaluationAt: string | null;
  /** Newest run of the five-minute backstop cron (its own vercel.json entry). Proves Vercel cron fires. Null: never. */
  lastBackstopCronAt: string | null;
  /** Registered jobs whose newest run is older than their cadence + grace (never-ran jobs are not counted). */
  overdueJobs: number;
  /** True when `lastAlertEvaluationAt` is null or older than the evaluator's cadence + grace. */
  alertEvaluatorOverdue: boolean;
}

export interface SchedulerSignalInputs {
  now: Date;
  /** Newest row per job name (any status), from one distinct read. */
  newestPerJob: readonly { jobName: string; startedAt: Date }[];
  /** Newest SUCCEEDED alert-evaluator run, or null. */
  alertNewestSucceededAt: Date | null;
  /** Registered job names (the dispatcher's set). */
  registered: readonly string[];
  /** Resolved execution cadence per registered job, in hours. */
  cadenceHours: ReadonlyMap<string, number>;
  /** Fallback cadence for a registered job with no resolved policy. */
  defaultCadenceHours: number;
  alertJobName: string;
  backstopJobName: string;
}

const HOUR_MS = 3_600_000;

export function buildSchedulerSignals(i: SchedulerSignalInputs): SchedulerSignals {
  const newest = new Map<string, Date>();
  for (const r of i.newestPerJob) {
    const prev = newest.get(r.jobName);
    if (!prev || r.startedAt > prev) newest.set(r.jobName, r.startedAt);
  }
  const registered = new Set(i.registered);

  let lastDispatch: Date | null = null;
  let overdue = 0;
  for (const name of registered) {
    const at = newest.get(name);
    if (!at) continue; // never ran: an operator-decides state, not overdue
    if (!lastDispatch || at > lastDispatch) lastDispatch = at;
    const cadence = i.cadenceHours.get(name) ?? i.defaultCadenceHours;
    if (i.now.getTime() - at.getTime() > (cadence + OVERDUE_GRACE_HOURS) * HOUR_MS) overdue++;
  }

  const alertCadence = i.cadenceHours.get(i.alertJobName) ?? i.defaultCadenceHours;
  const alertAt = i.alertNewestSucceededAt;
  const alertEvaluatorOverdue =
    !alertAt || i.now.getTime() - alertAt.getTime() > (alertCadence + OVERDUE_GRACE_HOURS) * HOUR_MS;

  const backstop = newest.get(i.backstopJobName) ?? null;

  return {
    lastDispatchAt: lastDispatch ? lastDispatch.toISOString() : null,
    lastAlertEvaluationAt: alertAt ? alertAt.toISOString() : null,
    lastBackstopCronAt: backstop ? backstop.toISOString() : null,
    overdueJobs: overdue,
    alertEvaluatorOverdue,
  };
}
