/**
 * lib/platform/policies/refresh-policies.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * The loader behind the Policies read model: the few reads that feed
 * refresh-policies.core.ts, and nothing else.
 *
 *   1 × PlatformSetting.findMany   both cadence rows (value, updatedAt, updatedById)
 *   ≤1 × User.findMany             display names for the writers (never emails)
 *   2 × JobRun.findFirst           the newest completed run per source family,
 *                                  for the policy version it stamped
 *
 * ⚠️ NEVER A PROVIDER CALL, NEVER A JOB, NEVER AN AI CALL. Opening the Policies
 * workspace observes persisted and derived state only. Capability comes from
 * the registry in memory.
 *
 * ⚠️ NEVER THROWS ON THE SETTINGS READ — the same posture as
 * lib/platform/refresh-policy.ts: an unreadable settings table renders the
 * defaults, with origin DEFAULT, rather than a blank workspace.
 */

import "server-only";
import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { refreshFamily } from "@/lib/jobs/cadence";
import { REFRESH_CADENCE_SETTING_KEY, type RefreshSourceKind } from "@/lib/platform/refresh-policy.core";
import { schedulerCapability } from "@/lib/platform/scheduler-capability";
import { SETTING_DESCRIPTORS } from "@/lib/platform-settings";
import {
  composeRefreshPoliciesReadModel,
  type ComposeRefreshPolicyInput, type RefreshExecutionEvidence, type RefreshPoliciesReadModel, type RefreshSettingRowFacts,
} from "./refresh-policies.core";

export type { RefreshPoliciesReadModel, RefreshPolicyView } from "./refresh-policies.core";

type Client = Pick<PrismaClient, "platformSetting" | "jobRun" | "user">;

const KINDS: readonly RefreshSourceKind[] = ["BANK", "WALLET"];
const LABEL: Record<RefreshSourceKind, string> = { BANK: "Bank refresh", WALLET: "Wallet refresh" };

/** The policy version a sweep stamped into its summary, when present. */
function stampedVersion(summary: unknown): string | null {
  const v = (summary as { policy?: { version?: unknown } } | null)?.policy?.version;
  return typeof v === "string" ? v : null;
}

export async function loadRefreshPoliciesReadModel(
  client: Client = db,
  now: Date = new Date(),
): Promise<RefreshPoliciesReadModel> {
  let rows: (RefreshSettingRowFacts & { key: string })[] = [];
  try {
    rows = await client.platformSetting.findMany({
      where:  { key: { in: KINDS.map((k) => REFRESH_CADENCE_SETTING_KEY[k]) } },
      select: { key: true, value: true, updatedAt: true, updatedById: true },
    });
  } catch (err) {
    console.error("[refresh-policies] settings unreadable; presenting the default cadences:", err);
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const writerIds = [...new Set(rows.map((r) => r.updatedById).filter((id): id is string => !!id))];
  const names = new Map<string, string | null>();
  if (writerIds.length > 0) {
    const users = await client.user.findMany({ where: { id: { in: writerIds } }, select: { id: true, name: true } });
    for (const u of users) names.set(u.id, u.name ?? null);
  }

  const inputs: ComposeRefreshPolicyInput[] = [];
  for (const sourceKind of KINDS) {
    const capability = schedulerCapability(sourceKind, SCHEDULED_JOBS);
    const family = refreshFamily(SCHEDULED_JOBS, sourceKind);
    const jobNames = [...family.primary, ...family.continuations].map((j) => j.name);

    let evidence: RefreshExecutionEvidence | null = null;
    if (jobNames.length > 0) {
      const run = await client.jobRun.findFirst({
        where:   { jobName: { in: jobNames }, status: "succeeded" },
        orderBy: { startedAt: "desc" },
        select:  { jobName: true, startedAt: true, summary: true },
      });
      if (run) evidence = { job: run.jobName, startedAt: run.startedAt, policyVersion: stampedVersion(run.summary) };
    }

    const row = byKey.get(REFRESH_CADENCE_SETTING_KEY[sourceKind]) ?? null;
    const descriptor = SETTING_DESCRIPTORS[REFRESH_CADENCE_SETTING_KEY[sourceKind]];
    inputs.push({
      sourceKind,
      label: LABEL[sourceKind],
      description: descriptor.description,
      row: row ? { value: row.value, updatedAt: row.updatedAt, updatedById: row.updatedById } : null,
      updatedByName: row?.updatedById ? names.get(row.updatedById) ?? null : null,
      capability,
      evidence,
    });
  }

  return composeRefreshPoliciesReadModel(inputs, now);
}
