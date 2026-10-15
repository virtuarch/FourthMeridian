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
 * AI COST CONTROLS — `aiDailyUsdAllowance` has TWO more sources and ONE
 * precedence function (lib/entitlements/ai-allowance.ts, used by enforcement
 * and every operator view): USER_OVERRIDE (the assignment row's
 * `aiDailyUsdAllowanceOverride`) > OVERLAY > PLATFORM_SETTING (PlatformSetting
 * `ai_daily_allowance_usd`, handed in by the loader) > POLICY, ceiling last.
 * Every other dimension is unchanged.
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
import { parseAllowanceSettingValue, resolveAiDailyAllowance } from "./ai-allowance";

export type EntitlementSource = "POLICY" | "POLICY_DEFAULT" | "OVERLAY" | "CEILING" | "USER_OVERRIDE" | "PLATFORM_SETTING";

/** The PlatformSetting key the loader reads for the platform allowance value (registered in lib/platform-settings.ts). */
export const AI_DAILY_ALLOWANCE_SETTING_KEY = "ai_daily_allowance_usd";

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
  /** AI COST CONTROLS — the platform setting's candidate for this dimension (only `aiDailyUsdAllowance` has one); absent elsewhere. */
  platformValue?: number | null;
  /** AI COST CONTROLS — the per-customer override for this dimension (only `aiDailyUsdAllowance` has one); absent elsewhere. */
  overrideValue?: number | null;
}

export interface AssignmentFacts {
  policyGroup: string;
  overlay: string | null;
  assignedAt: Date;
  assignedById: string | null;
  /** AI COST CONTROLS — the per-customer daily AI allowance override (whole USD), or null/absent. */
  aiDailyUsdAllowanceOverride?: number | null;
}

/** Platform-level inputs the loader hands the resolver (the setting rows a tenant may read). */
export interface PlatformEntitlementInputs {
  /** `ai_daily_allowance_usd` as a candidate, or null when absent/invalid. */
  aiDailyUsdAllowanceUsd: number | null;
}

const NO_PLATFORM_INPUTS: PlatformEntitlementInputs = { aiDailyUsdAllowanceUsd: null };

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
  /** AI COST CONTROLS — the per-customer override as stored (null when none). */
  aiDailyUsdAllowanceOverride: number | null;
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

/** PURE — the effective entitlements for one customer's assignment facts (null = no row) and the platform inputs. */
export function resolveEffectiveEntitlements(
  facts: AssignmentFacts | null,
  platform: PlatformEntitlementInputs = NO_PLATFORM_INPUTS,
): EffectiveEntitlements {
  const assigned = facts !== null;
  const known = assigned && facts.policyGroup in POLICY_GROUPS;
  const groupKey = known ? facts!.policyGroup : DEFAULT_POLICY_GROUP;
  const group = POLICY_GROUPS[groupKey];
  const overlayKey = facts?.overlay ?? null;
  const overlayKnown = overlayKey !== null && overlayKey in OVERLAYS;
  const overlay = overlayKnown ? OVERLAYS[overlayKey!] : null;

  const override = typeof facts?.aiDailyUsdAllowanceOverride === "number" ? facts.aiDailyUsdAllowanceOverride : null;

  const dimensions = {} as Record<EntitlementDimensionKey, EffectiveDimension>;
  for (const key of DIMENSION_KEYS) {
    const policyValue = (group.values as EntitlementValues)[key];
    const overlayValue = overlay && key in overlay.values ? (overlay.values[key] as EntitlementValue) : null;
    if (key === "aiDailyUsdAllowance") {
      // The ONE precedence function — enforcement and every operator view agree.
      const r = resolveAiDailyAllowance({
        policyUsd: Number(policyValue),
        overlayUsd: overlayValue === null ? null : Number(overlayValue),
        platformUsd: platform.aiDailyUsdAllowanceUsd,
        userOverrideUsd: override,
        ceilingUsd: ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling,
      });
      const source: EntitlementSource = r.source === "POLICY" && !known ? "POLICY_DEFAULT" : r.source;
      dimensions[key] = {
        key, value: r.usd, source, ceiling: ENTITLEMENT_DIMENSIONS[key].ceiling, policyValue, overlayValue, clamped: r.clamped,
        platformValue: platform.aiDailyUsdAllowanceUsd, overrideValue: override,
      };
      continue;
    }
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
    aiDailyUsdAllowanceOverride: override,
  };
}

/** One human sentence per dimension — the "where did this come from" an operator or a refusal shows. */
export function explainEntitlement(d: EffectiveDimension): string {
  const label = ENTITLEMENT_DIMENSIONS[d.key].label;
  const v = String(d.value);
  switch (d.source) {
    case "CEILING":          return `${label}: ${v} — platform ceiling (asked ${String(d.overrideValue ?? d.overlayValue ?? d.platformValue ?? d.policyValue)}).`;
    case "USER_OVERRIDE":    return `${label}: ${v} — per-customer override (policy ${String(d.policyValue)}).`;
    case "OVERLAY":          return `${label}: ${v} — overlay (policy ${String(d.policyValue)}).`;
    case "PLATFORM_SETTING": return `${label}: ${v} — platform setting (policy ${String(d.policyValue)}).`;
    case "POLICY":           return `${label}: ${v} — policy group.`;
    case "POLICY_DEFAULT":   return `${label}: ${v} — default policy group (no assignment recorded).`;
  }
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * The one read. Satisfied by a tenant transaction, systemDb, or a test fake.
 *
 * AI COST CONTROLS — two additive facts ride the same client:
 *   · `aiDailyUsdAllowanceOverride` on the assignment row (OPTIONAL in the type
 *     so a client generated before migration 20261016000000 still satisfies it;
 *     an old client simply never selects the column and the override reads null);
 *   · `platformSetting` (OPTIONAL): the tenant role may SELECT PlatformSetting
 *     (migration 20261002000300), so the ONE tenant phase of consume.ts reads
 *     `ai_daily_allowance_usd` beside the assignment. A client without the
 *     delegate (a narrow fake) resolves with no platform value.
 */
export interface EntitlementReadClient {
  customerPolicyAssignment: {
    findUnique(args: { where: { userId: string } }): Promise<{
      policyGroup: string; overlay: string | null; assignedAt: Date; assignedById: string | null;
      aiDailyUsdAllowanceOverride?: number | null;
    } | null>;
  };
  platformSetting?: {
    findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null>;
  };
}

/** The platform inputs from the same client — one row, parsed by the descriptor's rule. */
export async function loadPlatformEntitlementInputs(client: EntitlementReadClient): Promise<PlatformEntitlementInputs> {
  if (!client.platformSetting) return NO_PLATFORM_INPUTS;
  const row = await client.platformSetting.findUnique({ where: { key: AI_DAILY_ALLOWANCE_SETTING_KEY }, select: { value: true } });
  return { aiDailyUsdAllowanceUsd: parseAllowanceSettingValue(row?.value ?? null, ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling) };
}

export async function loadEffectiveEntitlements(client: EntitlementReadClient, userId: string): Promise<EffectiveEntitlements> {
  const [row, platform] = await Promise.all([
    client.customerPolicyAssignment.findUnique({ where: { userId } }),
    loadPlatformEntitlementInputs(client),
  ]);
  return resolveEffectiveEntitlements(row ? {
    policyGroup: row.policyGroup, overlay: row.overlay, assignedAt: row.assignedAt, assignedById: row.assignedById,
    aiDailyUsdAllowanceOverride: row.aiDailyUsdAllowanceOverride ?? null,
  } : null, platform);
}
