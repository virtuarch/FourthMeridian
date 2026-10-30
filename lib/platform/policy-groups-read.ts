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
 *
 * POLICY EDITOR (Phase 2) — group DEFINITIONS now come from the policy-group
 * catalogue (DB current versions over the code catalogue, the same loader the
 * resolver uses), so each row adds its version, built-in / archived / validity
 * state and how many of its customers carry an overlay. `unknownAssignments`
 * counts rows naming a key that does not resolve to a valid plan (retired key
 * OR a group whose stored definition is invalid) — both fail closed / need an
 * operator. Still counts only, no identity.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import {
  COHORTS, DIMENSION_KEYS, ENTITLEMENT_CATEGORIES, ENTITLEMENT_DIMENSIONS, OVERLAYS,
  type EntitlementDimensionKey, type EntitlementValue,
} from "@/lib/entitlements/catalogue";
import { resolvableGroupKeys, type PolicyGroupCatalogue } from "@/lib/entitlements/policy-groups";
import { loadPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";

export interface PolicyDimensionRow {
  key: EntitlementDimensionKey; label: string; description: string; kind: string; ceiling: EntitlementValue;
  /** POLICY EDITOR — the editor section (catalogue category id) and its label. */
  category?: string; categoryLabel?: string;
}
export interface PolicyGroupRow {
  key: string; label: string; description: string; effectiveFrom: string; values: Record<string, EntitlementValue>; customers: number; isDefault: boolean;
  /** POLICY EDITOR — optional so readers built before the editor still type-check. */
  version?: number | null;
  builtIn?: boolean;
  archived?: boolean;
  /** False when the stored definition failed validation (its customers fail closed). */
  valid?: boolean;
  source?: "DB" | "CODE";
  /** Customers on this group that carry an overlay (Founder). */
  customersWithOverlay?: number;
}
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
  /** POLICY EDITOR — where the definitions came from (CODE_FALLBACK = the table read failed). */
  catalogueSource?: PolicyGroupCatalogue["source"];
  checkedAt: string;
}

/** The catalogue with its customer counts. Counts only: groupBy + count, never findMany, no identity. */
export async function readPolicyGroups(catalogue?: PolicyGroupCatalogue): Promise<PolicyGroupsResponse> {
  const [cat, byGroup, byGroupOverlay, byCohort, users, unassignedActive] = await Promise.all([
    catalogue ?? loadPolicyGroupCatalogue(),
    systemDb.customerPolicyAssignment.groupBy({ by: ["policyGroup"], _count: { _all: true } }),
    systemDb.customerPolicyAssignment.groupBy({ by: ["policyGroup", "overlay"], where: { overlay: { not: null } }, _count: { _all: true } }),
    systemDb.customerCohort.groupBy({ by: ["cohort"], _count: { _all: true } }),
    systemDb.user.count({ where: { role: "USER" } }),
    systemDb.user.count({ where: { role: "USER", deactivatedAt: null, policyAssignment: { is: null } } }),
  ]);
  const groupCount = new Map(byGroup.map((g) => [g.policyGroup, g._count._all] as const));
  const overlayCount = new Map<string, number>();
  const withOverlayByGroup = new Map<string, number>();
  for (const g of byGroupOverlay) {
    overlayCount.set(g.overlay as string, (overlayCount.get(g.overlay as string) ?? 0) + g._count._all);
    withOverlayByGroup.set(g.policyGroup, (withOverlayByGroup.get(g.policyGroup) ?? 0) + g._count._all);
  }
  const resolvable = new Set(resolvableGroupKeys(cat));
  const cohortCount = new Map(byCohort.map((g) => [g.cohort, g._count._all] as const));
  const assigned = byGroup.reduce((n, g) => n + g._count._all, 0);
  const unknownAssignments = byGroup.filter((g) => !resolvable.has(g.policyGroup)).reduce((n, g) => n + g._count._all, 0);
  // Active groups first (default leading), archived last; stable by label.
  const groups = Object.values(cat.groups).sort((a, b) =>
    Number(a.archived) - Number(b.archived) || Number(b.isDefault) - Number(a.isDefault) || Number(b.builtIn) - Number(a.builtIn) || a.label.localeCompare(b.label));

  return {
    dimensions: DIMENSION_KEYS.map((key) => {
      const d = ENTITLEMENT_DIMENSIONS[key];
      return { key, label: d.label, description: d.description, kind: d.kind, ceiling: d.ceiling, category: d.category, categoryLabel: ENTITLEMENT_CATEGORIES[d.category] };
    }),
    policyGroups: groups.map((g) => ({
      key: g.key, label: g.label, description: g.description, effectiveFrom: g.effectiveFrom,
      // An invalid stored definition shows NO values (never a guessed one); its customers fail closed.
      values: (g.values ?? {}) as Record<string, EntitlementValue>, customers: groupCount.get(g.key) ?? 0, isDefault: g.key === cat.defaultKey,
      version: g.version, builtIn: g.builtIn, archived: g.archived, valid: g.valid, source: g.source,
      customersWithOverlay: withOverlayByGroup.get(g.key) ?? 0,
    })),
    overlays: Object.values(OVERLAYS).map((o) => ({
      key: o.key, label: o.label, description: o.description, effectiveFrom: o.effectiveFrom,
      values: o.values as Record<string, EntitlementValue>, customers: overlayCount.get(o.key) ?? 0,
    })),
    cohorts: Object.values(COHORTS).map((c) => ({ key: c.key, label: c.label, description: c.description, entry: c.entry, customers: cohortCount.get(c.key) ?? 0 })),
    unassignedCustomers: Math.max(0, users - assigned),
    unassignedActiveCustomers: unassignedActive,
    unknownAssignments,
    defaultPolicyGroup: cat.defaultKey,
    catalogueSource: cat.source,
    checkedAt: new Date().toISOString(),
  } satisfies PolicyGroupsResponse;
}
