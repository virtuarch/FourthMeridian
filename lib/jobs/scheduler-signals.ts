/**
 * lib/jobs/scheduler-signals.ts  (OBS-001 / OPS-002)
 *
 * The reader behind the public health route's `scheduler` block. Three small
 * indexed reads, all over the JobRun ledger and PlatformSetting:
 *
 *   1. the newest row per job name (DISTINCT ON jobName, index [jobName, startedAt])
 *      for the registered jobs plus the backstop cron;
 *   2. the newest SUCCEEDED evaluate-alerts row (same index);
 *   3. the resolved execution cadences (two PK lookups on PlatformSetting,
 *      through the ONE cadence loader the dispatcher uses — never throws).
 *
 * The derivation is pure (scheduler-signals-core.ts). Imports the registry
 * FACTS only (lib/jobs/registry.core.ts), never the executable registry.
 */

import "server-only";
// fm_system, not the migration principal: JobRun is revoked from fm_app and every
// other JobRun reader lives here in lib/jobs/ on systemDb (audit-db-authority).
import { systemDb } from "@/lib/db";
import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import { loadJobCadencePolicies } from "@/lib/jobs/cadence-policy";
import { buildSchedulerSignals, type SchedulerSignals } from "./scheduler-signals-core";

export const ALERT_EVALUATOR_JOB = "evaluate-alerts";
/** The five-minute first-run-import backstop: its own vercel.json cron, outside the registry. */
export const BACKSTOP_CRON_JOB = "resume-stale-imports";
const DEFAULT_CADENCE_HOURS = 24;

export async function readSchedulerSignals(now: Date = new Date()): Promise<SchedulerSignals> {
  const registered = SCHEDULED_JOB_FACTS.map((j) => j.name);
  const names = [...registered, BACKSTOP_CRON_JOB];
  const [newestPerJob, alertNewest, policies] = await Promise.all([
    systemDb.jobRun.findMany({
      where: { jobName: { in: names } },
      orderBy: { startedAt: "desc" },
      distinct: ["jobName"],
      select: { jobName: true, startedAt: true },
    }),
    systemDb.jobRun.findFirst({
      where: { jobName: ALERT_EVALUATOR_JOB, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
    loadJobCadencePolicies(systemDb),
  ]);
  const cadenceHours = new Map<string, number>();
  for (const [name, p] of policies) cadenceHours.set(name, p.hours);
  return buildSchedulerSignals({
    now,
    newestPerJob,
    alertNewestSucceededAt: alertNewest?.startedAt ?? null,
    registered,
    cadenceHours,
    defaultCadenceHours: DEFAULT_CADENCE_HOURS,
    alertJobName: ALERT_EVALUATOR_JOB,
    backstopJobName: BACKSTOP_CRON_JOB,
  });
}
