/**
 * GET /api/platform/growth-revenue/policy-groups  (P1 — the Policy Group catalogue)
 *
 * GROWTH_REVENUE owns the DEFINITIONS and rollout policy; this is their read-only
 * view: every Policy Group with each dimension's value beside its platform
 * ceiling, the overlays, the cohorts, and how many customers sit on each —
 * counts only, no identity (assignment happens in Customer Success, which may
 * resolve identity; this area may not). Definitions come from code
 * (lib/entitlements/catalogue.ts); only the counts are read, through fm_system.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 */

import { NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import {
  COHORTS, DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, OVERLAYS, POLICY_GROUPS,
  type EntitlementDimensionKey, type EntitlementValue,
} from "@/lib/entitlements/catalogue";

export const runtime = "nodejs";

export interface PolicyDimensionRow { key: EntitlementDimensionKey; label: string; description: string; kind: string; ceiling: EntitlementValue }
export interface PolicyGroupRow { key: string; label: string; description: string; effectiveFrom: string; values: Record<string, EntitlementValue>; customers: number; isDefault: boolean }
export interface OverlayRow { key: string; label: string; description: string; effectiveFrom: string; values: Record<string, EntitlementValue>; customers: number }
export interface CohortRow { key: string; label: string; description: string; entry: string; customers: number }

export interface PolicyGroupsResponse {
  dimensions: PolicyDimensionRow[];
  policyGroups: PolicyGroupRow[];
  overlays: OverlayRow[];
  cohorts: CohortRow[];
  /** USER-role accounts with no assignment row — they resolve to the default and are reported as such. */
  unassignedCustomers: number;
  /** Assignment rows naming a key the catalogue no longer defines (a retired group) — resolve to the default. */
  unknownAssignments: number;
  defaultPolicyGroup: string;
  checkedAt: string;
}

export async function GET() {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;

  const [byGroup, byOverlay, byCohort, users] = await Promise.all([
    systemDb.customerPolicyAssignment.groupBy({ by: ["policyGroup"], _count: { _all: true } }),
    systemDb.customerPolicyAssignment.groupBy({ by: ["overlay"], where: { overlay: { not: null } }, _count: { _all: true } }),
    systemDb.customerCohort.groupBy({ by: ["cohort"], _count: { _all: true } }),
    systemDb.user.count({ where: { role: "USER" } }),
  ]);
  const groupCount = new Map(byGroup.map((g) => [g.policyGroup, g._count._all] as const));
  const overlayCount = new Map(byOverlay.map((g) => [g.overlay as string, g._count._all] as const));
  const cohortCount = new Map(byCohort.map((g) => [g.cohort, g._count._all] as const));
  const assigned = byGroup.reduce((n, g) => n + g._count._all, 0);
  const unknownAssignments = byGroup.filter((g) => !(g.policyGroup in POLICY_GROUPS)).reduce((n, g) => n + g._count._all, 0);

  return NextResponse.json({
    dimensions: DIMENSION_KEYS.map((key) => {
      const d = ENTITLEMENT_DIMENSIONS[key];
      return { key, label: d.label, description: d.description, kind: d.kind, ceiling: d.ceiling };
    }),
    policyGroups: Object.values(POLICY_GROUPS).map((g) => ({
      key: g.key, label: g.label, description: g.description, effectiveFrom: g.effectiveFrom,
      values: g.values as Record<string, EntitlementValue>, customers: groupCount.get(g.key) ?? 0, isDefault: g.key === DEFAULT_POLICY_GROUP,
    })),
    overlays: Object.values(OVERLAYS).map((o) => ({
      key: o.key, label: o.label, description: o.description, effectiveFrom: o.effectiveFrom,
      values: o.values as Record<string, EntitlementValue>, customers: overlayCount.get(o.key) ?? 0,
    })),
    cohorts: Object.values(COHORTS).map((c) => ({ key: c.key, label: c.label, description: c.description, entry: c.entry, customers: cohortCount.get(c.key) ?? 0 })),
    unassignedCustomers: Math.max(0, users - assigned),
    unknownAssignments,
    defaultPolicyGroup: DEFAULT_POLICY_GROUP,
    checkedAt: new Date().toISOString(),
  } satisfies PolicyGroupsResponse);
}
