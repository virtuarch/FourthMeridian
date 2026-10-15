/**
 * lib/entitlements/ai-allowance.ts  (AI COST CONTROLS — the ONE precedence function)
 *
 * WHAT A CUSTOMER'S DAILY AI ALLOWANCE IS, AND WHY. Enforcement (lib/ai/allowance.ts
 * through the resolver), the Customer Success policy view (projectPolicy), the
 * Platform Ops cost-controls read model and the Economics budget all call THIS
 * function and nothing else, so no surface can disagree with the refusal about
 * what the allowance is.
 *
 * Precedence (coordination doc §1, frozen in cost-controls.types.ts):
 *
 *   USER_OVERRIDE    CustomerPolicyAssignment.aiDailyUsdAllowanceOverride — the
 *                    one additive migration of the milestone; set by Customer
 *                    Success with a reason, refused above the ceiling at write
 *   > OVERLAY        the catalogue overlay (FOUNDER_INTERNAL_V1 $20)
 *   > PLATFORM       PlatformSetting ai_daily_allowance_usd — the Platform Ops
 *                    control; absent/invalid ⇒ not a candidate
 *   > POLICY         the catalogue policy-group value (BETA $5)
 *   then the CEILING clamps LAST: nothing exceeds the catalogue ceiling ($20),
 *   so no override can escalate past code. A value the ceiling changed reports
 *   source CEILING with `askedUsd` kept beside it.
 *
 * A candidate is a whole, finite, non-negative number; anything else (null,
 * NaN, negative, a non-integer) is NOT a candidate and the next source wins.
 * Zero is a candidate — an allowance of 0 refuses every turn (never "unlimited").
 *
 * PURE — no I/O, no clock, no catalogue import: the caller hands in the policy,
 * overlay and ceiling it already resolved, so this module is reachable from the
 * tenant loader, fm_system readers and tests alike without widening anything.
 */

export type AiAllowanceSource = "USER_OVERRIDE" | "OVERLAY" | "PLATFORM_SETTING" | "POLICY" | "CEILING";

export interface AiAllowanceInputs {
  /** The policy group's value (always present — the catalogue default at worst). */
  policyUsd: number;
  /** The assigned overlay's value for this dimension, or null when none applies. */
  overlayUsd: number | null;
  /** The platform setting's value, or null when the row is absent or invalid. */
  platformUsd: number | null;
  /** The per-customer override, or null when none is set. */
  userOverrideUsd: number | null;
  /** The catalogue ceiling. */
  ceilingUsd: number;
}

export interface AiAllowanceResolution {
  /** The allowance in force, whole USD, after the ceiling. */
  usd: number;
  source: AiAllowanceSource;
  /** The value the winning source asked for, before the ceiling. */
  askedUsd: number;
  /** The source that won BEFORE the ceiling (equals `source` unless clamped). */
  askedSource: Exclude<AiAllowanceSource, "CEILING">;
  clamped: boolean;
}

/** A whole, finite, non-negative number is a candidate; anything else is not. */
export function isAllowanceCandidate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/** PURE — the one precedence. */
export function resolveAiDailyAllowance(input: AiAllowanceInputs): AiAllowanceResolution {
  const ordered: [Exclude<AiAllowanceSource, "CEILING">, number | null][] = [
    ["USER_OVERRIDE", input.userOverrideUsd],
    ["OVERLAY", input.overlayUsd],
    ["PLATFORM_SETTING", input.platformUsd],
    ["POLICY", input.policyUsd],
  ];
  let askedSource: Exclude<AiAllowanceSource, "CEILING"> = "POLICY";
  let askedUsd = isAllowanceCandidate(input.policyUsd) ? input.policyUsd : 0;
  for (const [source, value] of ordered) {
    if (isAllowanceCandidate(value)) { askedSource = source; askedUsd = value; break; }
  }
  const ceiling = isAllowanceCandidate(input.ceilingUsd) ? input.ceilingUsd : 0;
  const usd = Math.min(askedUsd, ceiling);
  const clamped = usd !== askedUsd;
  return { usd, source: clamped ? "CEILING" : askedSource, askedUsd, askedSource, clamped };
}

/**
 * The stored platform value as a candidate, or null. Mirrors the descriptor of
 * `ai_daily_allowance_usd` (integer, 1 … ceiling) without importing the
 * registry (which imports the database): a row outside that rule is INVALID
 * and falls back to "no platform value", exactly as the descriptor's
 * FALLBACK_TO_DEFAULT says. A test pins the two rules against each other.
 */
export function parseAllowanceSettingValue(raw: string | null | undefined, ceilingUsd: number): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return n >= 1 && n <= ceilingUsd ? n : null;
}
