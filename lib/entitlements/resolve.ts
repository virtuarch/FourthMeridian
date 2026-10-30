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
 * FAIL CLOSED (owner ruling, 2026-10-30) — when the caller passes
 * `{ failClosed: true }` (the loaders pass env.isPolicyAssignmentFailClosed, the
 * POLICY_ASSIGNMENT_FAIL_CLOSED=enforce rollout switch) AND the assignment is
 * missing or names an unknown policy group, every dimension resolves from the
 * catalogue's FAIL_CLOSED_VALUES with source FAIL_CLOSED. The overlay and the
 * per-customer AI override are IGNORED in that state (an overlay must never
 * resurrect paid access on a broken assignment); the platform ceilings still
 * clamp. With `failClosed` false or absent the result is byte-for-byte what it
 * was before the ruling (POLICY_DEFAULT fallback) — pinned by resolve.test.ts.
 * Pure and per-request: nothing is written, so a corrected assignment restores
 * normal entitlements on the next request.
 *
 * POLICY EDITOR (Phase 2) — the policy GROUP values come from a
 * PolicyGroupCatalogue handed in through `options.catalogue` (the DB's current
 * versions over the code catalogue, lib/entitlements/policy-groups.ts; loaded,
 * cached and never-throwing in lib/platform/policies/policy-group-catalogue.ts).
 * Absent ⇒ CODE_CATALOGUE ⇒ exactly the pre-editor resolution. Effective is
 * still clamp(ceiling, overlay ∘ group): the editor changes group values only,
 * never a ceiling, the Founder overlay or FAIL_CLOSED_VALUES. A group whose
 * stored definition is invalid resolves FAIL CLOSED (INVALID_POLICY_GROUP)
 * whether or not the rollout switch is on.
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
  DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, FAIL_CLOSED_VALUES, OVERLAYS,
  type EntitlementDimensionKey, type EntitlementValue, type EntitlementValues,
} from "./catalogue";
import { parseAllowanceSettingValue, resolveAiDailyAllowance } from "./ai-allowance";
import { CODE_CATALOGUE, type PolicyGroupCatalogue } from "./policy-groups";

export type EntitlementSource = "POLICY" | "POLICY_DEFAULT" | "OVERLAY" | "CEILING" | "USER_OVERRIDE" | "PLATFORM_SETTING" | "FAIL_CLOSED";

/**
 * Why an assignment failed closed: no row at all, a row naming a key the
 * catalogue does not define, or (POLICY EDITOR) a row naming a group whose
 * STORED definition is invalid — the last fails closed regardless of the
 * rollout switch, because no valid plan exists to fall back to honestly.
 */
export type FailClosedReason = "UNASSIGNED" | "UNKNOWN_POLICY_GROUP" | "INVALID_POLICY_GROUP" | "CATALOGUE_UNAVAILABLE";

/** Resolver options. `failClosed` is the rollout switch's value, handed in by the loader (the resolver stays pure). */
export interface ResolveOptions {
  failClosed?: boolean;
  /**
   * POLICY EDITOR — the policy-group definitions in force (DB versions over the
   * code catalogue). Absent ⇒ CODE_CATALOGUE, i.e. exactly the pre-editor
   * resolution. The resolver never reads a database; a loader hands this in.
   */
  catalogue?: PolicyGroupCatalogue;
  /** Loader-only: fetch the catalogue (cached, never throws) when `catalogue` is not given. */
  loadCatalogue?: () => Promise<PolicyGroupCatalogue>;
}

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
  /**
   * FAIL CLOSED — true when the rollout switch is on AND the assignment is
   * missing or unknown: every dimension then comes from FAIL_CLOSED_VALUES and
   * NO policy group is in force (`policyGroup` still names the catalogue
   * default only so the shape is unchanged — read this flag first).
   */
  failClosed: boolean;
  /** Why it failed closed; null when it did not. */
  failClosedReason: FailClosedReason | null;
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
  options: ResolveOptions = {},
): EffectiveEntitlements {
  const catalogue = options.catalogue ?? CODE_CATALOGUE;
  const assigned = facts !== null;
  const assignedGroup = facts ? catalogue.groups[facts.policyGroup] : undefined;
  // POLICY EDITOR — a DEFINED group whose stored definition failed validation.
  const invalidAssigned = assignedGroup !== undefined && !assignedGroup.valid;
  const known = assignedGroup !== undefined && assignedGroup.valid;
  const groupKey = assigned && assignedGroup !== undefined ? facts!.policyGroup : catalogue.defaultKey;
  const group = catalogue.groups[groupKey];
  // The plan that would be in force — null when there is none that validates
  // (an invalid assigned group, or an invalid / missing default).
  const planValues: EntitlementValues | null = group?.valid ? group.values : null;
  const overlayKey = facts?.overlay ?? null;
  const overlayKnown = overlayKey !== null && overlayKey in OVERLAYS;
  const overlay = overlayKnown ? OVERLAYS[overlayKey!] : null;

  const override = typeof facts?.aiDailyUsdAllowanceOverride === "number" ? facts.aiDailyUsdAllowanceOverride : null;

  const dimensions = {} as Record<EntitlementDimensionKey, EffectiveDimension>;

  // FAIL CLOSED — a missing or unknown assignment under the rollout switch. The
  // restricted set replaces the policy; the overlay, the per-customer override
  // and the platform allowance setting are NOT candidates (none may resurrect
  // paid access on a broken assignment). The ceiling still clamps last.
  //
  // POLICY EDITOR — and ALWAYS (switch or not) when there is no valid plan to
  // resolve to: an assigned group whose stored version is invalid, or an
  // unassigned / unknown customer whose DEFAULT group is invalid. Never
  // "unlimited", never silently Beta.
  //
  // REVIEW FIX 2 — a catalogue READ FAILURE is never more permissive: when the
  // definitions in force are the CODE FALLBACK (the DB read failed, no recent
  // good read), an ASSIGNED key the fallback does not hold (a DB-only group)
  // FAILS CLOSED whatever the rollout switch says — it must not silently
  // become Beta. (Unassigned customers keep today's switch-governed path.)
  const fallbackUnknown = catalogue.source === "CODE_FALLBACK" && assigned && assignedGroup === undefined;
  if ((options.failClosed === true && !known) || planValues === null || fallbackUnknown) {
    for (const key of DIMENSION_KEYS) {
      const asked = (FAIL_CLOSED_VALUES as EntitlementValues)[key];
      const { value, clamped } = clamp(key, asked);
      const dim: EffectiveDimension = {
        key, value, source: clamped ? "CEILING" : "FAIL_CLOSED", ceiling: ENTITLEMENT_DIMENSIONS[key].ceiling,
        policyValue: asked, overlayValue: null, clamped,
      };
      if (key === "aiDailyUsdAllowance") { dim.platformValue = null; dim.overrideValue = null; }
      dimensions[key] = dim;
    }
    const reason: FailClosedReason = invalidAssigned || (planValues === null && (known || !(options.failClosed === true)))
      ? "INVALID_POLICY_GROUP"
      : fallbackUnknown ? "CATALOGUE_UNAVAILABLE"
      : assigned ? "UNKNOWN_POLICY_GROUP" : "UNASSIGNED";
    return {
      policyGroup: groupKey,
      assigned,
      policyGroupKnown: !assigned || assignedGroup !== undefined,
      unknownPolicyGroup: assigned && assignedGroup === undefined ? facts!.policyGroup : null,
      overlay: overlayKnown ? overlayKey : null,
      overlayKnown: overlayKey === null || overlayKnown,
      dimensions,
      assignedAt: facts?.assignedAt.toISOString() ?? null,
      assignedById: facts?.assignedById ?? null,
      aiDailyUsdAllowanceOverride: override,
      failClosed: true,
      failClosedReason: reason,
    };
  }
  for (const key of DIMENSION_KEYS) {
    const policyValue = planValues[key];
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
    failClosed: false,
    failClosedReason: null,
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
    case "FAIL_CLOSED":      return `${label}: ${v} — restricted (fail closed): the customer's policy-group assignment is missing or invalid, or the group's stored definition is invalid; correct it in Customer Success (or the group in Policies) to restore the plan.`;
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

/**
 * FAIL CLOSED — `options.failClosed` is the rollout switch's value. This module
 * imports no environment (it stays pure and reachable from every surface), so
 * every production caller hands in env.isPolicyAssignmentFailClosed — through
 * `entitlementLoadOptions()` (lib/entitlements/consume.ts). Absent ⇒ false ⇒
 * exactly the pre-ruling resolution.
 */
export async function loadEffectiveEntitlements(client: EntitlementReadClient, userId: string, options: ResolveOptions = {}): Promise<EffectiveEntitlements> {
  const [row, platform, catalogue] = await Promise.all([
    client.customerPolicyAssignment.findUnique({ where: { userId } }),
    loadPlatformEntitlementInputs(client),
    options.catalogue ?? (options.loadCatalogue ? options.loadCatalogue() : CODE_CATALOGUE),
  ]);
  return resolveEffectiveEntitlements(row ? {
    policyGroup: row.policyGroup, overlay: row.overlay, assignedAt: row.assignedAt, assignedById: row.assignedById,
    aiDailyUsdAllowanceOverride: row.aiDailyUsdAllowanceOverride ?? null,
  } : null, platform, { failClosed: options.failClosed, catalogue });
}
