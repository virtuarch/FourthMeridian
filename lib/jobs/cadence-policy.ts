/**
 * lib/jobs/cadence-policy.ts  (P1 — the loader behind cadence-policy.core.ts)
 *
 * Two reads, one resolution: the job-cadence setting rows and the refresh
 * policies (both PlatformSetting), folded by the pure resolver into one
 * JobCadencePolicy per registered job.
 *
 * ⚠️ NEVER THROWS. An unreadable settings table yields the defaults with origin
 * DEFAULT — the same posture as lib/platform/refresh-policy.ts: a cadence read
 * must never stop the dispatcher or blank a health surface. (Admission is
 * different on purpose: an unreadable PAUSE flag denies.)
 */

import "server-only";
import type { PrismaClient } from "@prisma/client";
import { SCHEDULED_JOB_FACTS, type ScheduledJobFacts } from "@/lib/jobs/registry.core";
import { loadRefreshPolicies, type RefreshPolicies } from "@/lib/platform/refresh-policy";
import { defaultRefreshPolicies } from "@/lib/platform/refresh-policy.core";
import {
  jobCadenceSettingKey, resolveJobCadences, type JobCadencePolicy, type JobCadenceSettingRow,
} from "@/lib/jobs/cadence-policy.core";

export type { JobCadencePolicy } from "@/lib/jobs/cadence-policy.core";

type Client = Pick<PrismaClient, "platformSetting">;

export type JobCadencePolicies = ReadonlyMap<string, JobCadencePolicy>;

export async function loadJobCadencePolicies(
  client: Client,
  jobs: readonly ScheduledJobFacts[] = SCHEDULED_JOB_FACTS,
  opts: { refreshPolicies?: RefreshPolicies } = {},
): Promise<JobCadencePolicies> {
  const keys = jobs.map(jobCadenceSettingKey).filter((k): k is string => k !== null);
  let rows: { key: string; value: string; updatedAt: Date }[] = [];
  try {
    if (keys.length > 0) {
      rows = await client.platformSetting.findMany({
        where:  { key: { in: keys } },
        select: { key: true, value: true, updatedAt: true },
      });
    }
  } catch (err) {
    console.error("[cadence-policy] settings unreadable; using the default cadences:", err);
  }
  let refresh: RefreshPolicies;
  try {
    refresh = opts.refreshPolicies ?? await loadRefreshPolicies(client);
  } catch {
    refresh = defaultRefreshPolicies();
  }
  const byKey = new Map<string, JobCadenceSettingRow>(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updatedAt }]));
  return resolveJobCadences(jobs, byKey, refresh);
}

/** The product defaults (no override rows), resolved — for callers with no settings client (pure tests). */
export function defaultJobCadencePolicies(
  jobs: readonly ScheduledJobFacts[] = SCHEDULED_JOB_FACTS,
  refreshPolicies: RefreshPolicies = defaultRefreshPolicies(),
): JobCadencePolicies {
  return resolveJobCadences(jobs, new Map(), refreshPolicies);
}
