/**
 * lib/entitlements/resolve.ts  (P1 HUMAN OPERABILITY — effective entitlements)
 *
 * THE ONE AUTHORITY PRODUCT CODE ASKS "WHAT MAY THIS CUSTOMER USE, AND WHY?"
 *
 * Precedence, deterministic and reported per dimension:
 *   1. the customer's Policy Group value (or the catalogue DEFAULT when no
 *      assignment row exists — reported as POLICY_DEFAULT, never hidden);
 *   2. an assigned OVERLAY value, when the overlay defines that dimension;
 *   3. the PLATFORM CEILING, applied LAST: a count is capped, a floor is raised,
 *      a boolean is AND-ed. A value the ceiling changed reports source CEILING.
 *
 * "Platform policy / safety constraint" (admission facts like maintenance_mode,
 * provider locks and cooldown floors) is enforced where work executes, not here:
 * this resolver says what the customer is ENTITLED to; the execution path says
 * whether the platform will do it right now. Both are explainable; neither can
 * exceed a ceiling.
 *
 * PURE CORE + NARROW LOADER. `resolveEffectiveEntitlements` is a pure function
 * over the assignment facts; `loadEffectiveEntitlements` does the one read
 * through whatever client the caller is entitled to (a tenant phase in a product
 * route — the customer may read their own row under RLS — or fm_system in an
 * operator reader). No import of any database client here, so the module is
 * reachable from every surface without widening any authority.
 */

import {
  DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, OVERLAYS, POLICY_GROUPS,
  type EntitlementDimensionKey, type EntitlementValue, type EntitlementValues,
} from "./catalogue";

export type EntitlementSource = "POLICY" | "POLICY_DEFAULT" | "OVERLAY" | "CEILING";

export interface EffectiveDimension {
  key: EntitlementDimensionKey;
  value: EntitlementValue;
  /** Where the EFFECTIVE value came from. */
  source: EntitlementSource;
  ceiling: EntitlementValue;
  policyValue: EntitlementValue;
  overlayValue: EntitlementValue | null;
  /** True when the ceiling changed the value a policy or overlay asked for. */
  clamped: boolean;
}

export interface AssignmentFacts {
  policyGroup: string;
  overlay: string | null;
  assignedAt: Date;
  assignedById: string | null;
}

export interface EffectiveEntitlements {
  /** The policy group in force (the default when unassigned or unknown). */
  policyGroup: string;
  /** False when no assignment row exists. */
  assigned: boolean;
  /** False when the assignment named a key the catalogue no longer defines. */
  policyGroupKnown: boolean;
  /** The assigned key when it was unknown (for the operator to see), else null. */
  unknownPolicyGroup: string | null;
  overlay: string | null;
  overlayKnown: boolean;
  dimensions: Readonly<Record<EntitlementDimensionKey, EffectiveDimension>>;
  assignedAt: string | null;
  assignedById: string | null;
}

function clamp(key: EntitlementDimensionKey, asked: EntitlementValue): { value: EntitlementValue; clamped: boolean } {
  const dim = ENTITLEMENT_DIMENSIONS[key];
  switch (dim.kind) {
    case "boolean": {
      const v = Boolean(asked) && (dim.ceiling as boolean);
      return { value: v, clamped: v !== Boolean(asked) };
    }
    case "count": {
      const n = Math.max(0, Math.floor(Number(asked)));
      const v = Math.min(n, dim.ceiling as number);
      return { value: v, clamped: v !== n };
    }
    case "minutes-floor": {
      const n = Math.max(0, Math.floor(Number(asked)));
      const v = Math.max(n, dim.ceiling as number);
      return { value: v, clamped: v !== n };
    }
  }
}

/** PURE — the effective entitlements for one customer's assignment facts (null = no row). */
export function resolveEffectiveEntitlements(facts: AssignmentFacts | null): EffectiveEntitlements {
  const assigned = facts !== null;
  const known = assigned && facts.policyGroup in POLICY_GROUPS;
  const groupKey = known ? facts!.policyGroup : DEFAULT_POLICY_GROUP;
  const group = POLICY_GROUPS[groupKey];
  const overlayKey = facts?.overlay ?? null;
  const overlayKnown = overlayKey !== null && overlayKey in OVERLAYS;
  const overlay = overlayKnown ? OVERLAYS[overlayKey!] : null;

  const dimensions = {} as Record<EntitlementDimensionKey, EffectiveDimension>;
  for (const key of DIMENSION_KEYS) {
    const policyValue = (group.values as EntitlementValues)[key];
    const overlayValue = overlay && key in overlay.values ? (overlay.values[key] as EntitlementValue) : null;
    const asked = overlayValue ?? policyValue;
    const { value, clamped } = clamp(key, asked);
    const source: EntitlementSource = clamped ? "CEILING"
      : overlayValue !== null ? "OVERLAY"
      : known ? "POLICY" : "POLICY_DEFAULT";
    dimensions[key] = { key, value, source, ceiling: ENTITLEMENT_DIMENSIONS[key].ceiling, policyValue, overlayValue, clamped };
  }

  return {
    policyGroup: groupKey,
    assigned,
    policyGroupKnown: !assigned || known,
    unknownPolicyGroup: assigned && !known ? facts!.policyGroup : null,
    overlay: overlayKnown ? overlayKey : null,
    overlayKnown: overlayKey === null || overlayKnown,
    dimensions,
    assignedAt: facts?.assignedAt.toISOString() ?? null,
    assignedById: facts?.assignedById ?? null,
  };
}

/** One human sentence per dimension — the "where did this come from" an operator or a refusal shows. */
export function explainEntitlement(d: EffectiveDimension): string {
  const label = ENTITLEMENT_DIMENSIONS[d.key].label;
  const v = String(d.value);
  switch (d.source) {
    case "CEILING":        return `${label}: ${v} — platform ceiling (asked ${String(d.overlayValue ?? d.policyValue)}).`;
    case "OVERLAY":        return `${label}: ${v} — overlay (policy ${String(d.policyValue)}).`;
    case "POLICY":         return `${label}: ${v} — policy group.`;
    case "POLICY_DEFAULT": return `${label}: ${v} — default policy group (no assignment recorded).`;
  }
}

// ── Loader ────────────────────────────────────────────────────────────────────

/** The one read. Satisfied by a tenant transaction, systemDb, or a test fake. */
export interface EntitlementReadClient {
  customerPolicyAssignment: {
    findUnique(args: { where: { userId: string } }): Promise<{
      policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null;
    } | null>;
  };
}

export async function loadEffectiveEntitlements(client: EntitlementReadClient, userId: string): Promise<EffectiveEntitlements> {
  const row = await client.customerPolicyAssignment.findUnique({ where: { userId } });
  return resolveEffectiveEntitlements(row ? {
    policyGroup: row.policyGroup, overlay: row.overlay, assignedAt: row.assignedAt, assignedById: row.assignedById,
  } : null);
}
