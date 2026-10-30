/**
 * lib/platform/policies/policy-group-detail.ts  (POLICY EDITOR — one group's read)
 *
 * GET /api/platform/platform-ops/policy-groups/[key] (PLATFORM_OPS READ): what
 * the editor needs to show one group honestly —
 *
 *   group        the current definition (version, values, built-in / archived /
 *                default / validity) from the same catalogue the resolver uses;
 *   versions     the immutable history, newest first (version, when, who — the
 *                operator's display label, never an email — reason code, the
 *                stored change summary), capped;
 *   assignments  COUNTS only: customers on the group, how many carry an overlay,
 *                and buckets by (overlay, allowance override) — what changes a
 *                customer's AI allowance — plus, for the default group while the
 *                fail-closed switch is off, the ACTIVE unassigned customers who
 *                resolve to it;
 *   effective    the effective values now, plain and with the Founder overlay
 *                (the resolver on this group's values);
 *   cost         the estimated AI spend CEILING per UTC day for these customers
 *                (customers × allowance, by the one precedence function), and
 *                the measured 30-day spend — NOT YET AVAILABLE: no existing
 *                reader attributes AI cost per policy group, and this read does
 *                not invent one.
 *
 * Read-only, fm_system, no customer identity.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { FOUNDER_INTERNAL_V1, type EntitlementValue } from "@/lib/entitlements/catalogue";
import { loadPlatformEntitlementInputs, type EntitlementReadClient } from "@/lib/entitlements/resolve";
import { validateEntitlementValues } from "@/lib/entitlements/policy-groups";
import { estimateAllowanceCeiling, previewEffective, type AllowanceBucket, type AllowanceExposure } from "@/lib/entitlements/policy-group-preview";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { loadPolicyGroupCatalogue } from "./policy-group-catalogue";

export const VERSION_HISTORY_CAP = 50;
export const MEASURED_SPEND_NOT_AVAILABLE = "Measured AI spend per policy group is not yet available.";

export interface PolicyGroupVersionView {
  version: number;
  createdAt: string;
  /** Operator display label (username → name → opaque); "Seeded from code" for a migration seed. */
  createdBy: string;
  label: string;
  reasonCode: string;
  /** The stored change summary (kind, changes [{key, before, after}], restoredVersion, …). */
  summary: Record<string, unknown>;
  /** False when this version's values fail today's validation (cannot be restored). */
  restorable: boolean;
  /** The version's values when they validate (the restore review diffs against them); null otherwise. */
  values: Record<string, EntitlementValue> | null;
  current: boolean;
}

export interface PolicyGroupDetailResponse {
  group: {
    key: string; label: string; description: string; version: number | null; builtIn: boolean; archived: boolean; archivedAt: string | null;
    isDefault: boolean; valid: boolean; invalidReasons: readonly string[]; source: "DB" | "CODE"; effectiveFrom: string;
    values: Record<string, EntitlementValue> | null;
  };
  versions: PolicyGroupVersionView[];
  versionsTruncated: boolean;
  assignments: {
    customers: number;
    withOverlay: number;
    /** Founder assignees on this group (the overlay the effective preview shows). */
    withFounder: number;
    buckets: AllowanceBucket[];
    /** Active customers with NO assignment who resolve to this group (default group, switch off); 0 otherwise. */
    unassignedResolvingHere: number;
  };
  effective: {
    plain: Record<string, { value: EntitlementValue; source: string; clamped: boolean }> | null;
    founder: Record<string, { value: EntitlementValue; source: string; clamped: boolean }> | null;
  };
  cost: {
    platformAllowanceUsd: number | null;
    /** Estimated ceiling for the CURRENT values (null when the definition is invalid). */
    current: AllowanceExposure | null;
    measured30dUsd: null;
    measuredNote: string;
  };
  defaultPolicyGroup: string;
  failClosedEnforced: boolean;
  checkedAt: string;
}

export async function readPolicyGroupDetail(key: string, now: Date = new Date()): Promise<PolicyGroupDetailResponse | null> {
  const catalogue = await loadPolicyGroupCatalogue();
  const g = catalogue.groups[key];
  if (!g) return null;
  const enforced = env.isPolicyAssignmentFailClosed;

  const [versionRows, bucketRows, platform, unassignedActive] = await Promise.all([
    g.source === "DB"
      ? systemDb.policyGroupVersion.findMany({
          where: { groupKey: key }, orderBy: { version: "desc" }, take: VERSION_HISTORY_CAP + 1,
          select: { version: true, createdAt: true, createdById: true, label: true, reasonCode: true, changeSummary: true, values: true },
        })
      : Promise.resolve([]),
    systemDb.customerPolicyAssignment.groupBy({ by: ["overlay", "aiDailyUsdAllowanceOverride"], where: { policyGroup: key }, _count: { _all: true } }),
    loadPlatformEntitlementInputs(systemDb as unknown as EntitlementReadClient),
    g.isDefault && !enforced
      ? systemDb.user.count({ where: { role: "USER", deactivatedAt: null, policyAssignment: { is: null } } })
      : Promise.resolve(0),
  ]);

  const truncated = versionRows.length > VERSION_HISTORY_CAP;
  const shown = versionRows.slice(0, VERSION_HISTORY_CAP);
  const authorIds = [...new Set(shown.map((v) => v.createdById).filter((id): id is string => typeof id === "string"))];
  const authors = authorIds.length
    ? await systemDb.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, username: true, name: true } })
    : [];
  const authorLabel = new Map(authors.map((a) => [a.id, operatorDisplayName(a)] as const));

  const buckets: AllowanceBucket[] = bucketRows.map((b) => ({ overlay: b.overlay, overrideUsd: b.aiDailyUsdAllowanceOverride ?? null, count: b._count._all }));
  if (unassignedActive > 0) buckets.push({ overlay: null, overrideUsd: null, count: unassignedActive });
  const customers = bucketRows.reduce((n, b) => n + b._count._all, 0);
  const withOverlay = bucketRows.filter((b) => b.overlay !== null).reduce((n, b) => n + b._count._all, 0);
  const withFounder = bucketRows.filter((b) => b.overlay === FOUNDER_INTERNAL_V1.key).reduce((n, b) => n + b._count._all, 0);

  const project = (values: NonNullable<typeof g.values>, overlay: string | null) =>
    Object.fromEntries(Object.values(previewEffective(values, overlay)).map((d) => [d.key, { value: d.value, source: d.source, clamped: d.clamped }]));

  return {
    group: {
      key: g.key, label: g.label, description: g.description, version: g.version, builtIn: g.builtIn, archived: g.archived, archivedAt: g.archivedAt,
      isDefault: g.isDefault, valid: g.valid, invalidReasons: g.invalidReasons, source: g.source, effectiveFrom: g.effectiveFrom,
      values: g.values ? { ...g.values } : null,
    },
    versions: shown.map((v) => { const check = validateEntitlementValues(v.values); return {
      version: v.version,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdById ? (authorLabel.get(v.createdById) ?? `user …${v.createdById.slice(-6)}`) : "Seeded from code",
      label: v.label,
      reasonCode: v.reasonCode,
      summary: (v.changeSummary && typeof v.changeSummary === "object" ? v.changeSummary : {}) as Record<string, unknown>,
      restorable: check.ok,
      values: check.ok ? { ...check.values } : null,
      current: v.version === g.version,
    }; }),
    versionsTruncated: truncated,
    assignments: { customers, withOverlay, withFounder, buckets, unassignedResolvingHere: unassignedActive },
    effective: {
      plain: g.values ? project(g.values, null) : null,
      founder: g.values ? project(g.values, FOUNDER_INTERNAL_V1.key) : null,
    },
    cost: {
      platformAllowanceUsd: platform.aiDailyUsdAllowanceUsd,
      current: g.values ? estimateAllowanceCeiling(buckets, Number(g.values.aiDailyUsdAllowance), platform.aiDailyUsdAllowanceUsd) : null,
      measured30dUsd: null,
      measuredNote: MEASURED_SPEND_NOT_AVAILABLE,
    },
    defaultPolicyGroup: catalogue.defaultKey,
    failClosedEnforced: enforced,
    checkedAt: now.toISOString(),
  };
}
