/**
 * lib/platform/policy-groups-read.ts  (P1 catalogue reader · PLATFORM OPS PHASE 1 UX)
 *
 * THE ONE READER of the Policy Group catalogue, shared by two routes that differ
 * only in their gate:
 *
 *   GET /api/platform/growth-revenue/policy-groups   GROWTH_REVENUE READ — the
 *       owner of the DEFINITIONS and rollout policy (GrowthPolicyGroupsWidget);
 *   GET /api/platform/platform-ops/policy-groups     PLATFORM_OPS READ — the
 *       Policies › Policy groups view (PolicyGroupsPanel), read-only.
 *
 * Every Policy Group with each dimension's value beside its platform ceiling,
 * the overlays, the cohorts, and how many customers sit on each — COUNTS only,
 * no identity (assignment happens in Customer Success, which may resolve
 * identity; neither of these areas may). Definitions come from code
 * (lib/entitlements/catalogue.ts); only the counts are read, through fm_system.
 *
 * Moved verbatim out of the Growth route so the two responses are the same
 * shape by construction (pinned in app/api/platform/policy-groups-routes.test.ts).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import {
  COHORTS, DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, OVERLAYS, POLICY_GROUPS,
  type EntitlementDimensionKey, type EntitlementValue,
} from "@/lib/entitlements/catalogue";

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
  /**
   * ACTIVE USER accounts (not deactivated / pending deletion) with no assignment
   * row — the same population the fail-closed Attention item and alert count, so
   * Policies and Attention always agree. Optional for readers built before it.
   */
  unassignedActiveCustomers?: number;
  /** Assignment rows naming a key the catalogue no longer defines (a retired group) — resolve to the default. */
  unknownAssignments: number;
  defaultPolicyGroup: string;
  checkedAt: string;
}

/** The catalogue with its customer counts. Counts only: groupBy + count, never findMany, no identity. */
export async function readPolicyGroups(): Promise<PolicyGroupsResponse> {
  const [byGroup, byOverlay, byCohort, users, unassignedActive] = await Promise.all([
    systemDb.customerPolicyAssignment.groupBy({ by: ["policyGroup"], _count: { _all: true } }),
    systemDb.customerPolicyAssignment.groupBy({ by: ["overlay"], where: { overlay: { not: null } }, _count: { _all: true } }),
    systemDb.customerCohort.groupBy({ by: ["cohort"], _count: { _all: true } }),
    systemDb.user.count({ where: { role: "USER" } }),
    systemDb.user.count({ where: { role: "USER", deactivatedAt: null, policyAssignment: { is: null } } }),
  ]);
  const groupCount = new Map(byGroup.map((g) => [g.policyGroup, g._count._all] as const));
  const overlayCount = new Map(byOverlay.map((g) => [g.overlay as string, g._count._all] as const));
  const cohortCount = new Map(byCohort.map((g) => [g.cohort, g._count._all] as const));
  const assigned = byGroup.reduce((n, g) => n + g._count._all, 0);
  const unknownAssignments = byGroup.filter((g) => !(g.policyGroup in POLICY_GROUPS)).reduce((n, g) => n + g._count._all, 0);

  return {
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
    unassignedActiveCustomers: unassignedActive,
    unknownAssignments,
    defaultPolicyGroup: DEFAULT_POLICY_GROUP,
    checkedAt: new Date().toISOString(),
  } satisfies PolicyGroupsResponse;
}
