/**
 * lib/entitlements/restriction-messages.ts  (BETA LIFECYCLE — the one wording)
 *
 * What a customer is told when NEW paid work is refused because of a lifecycle
 * restriction (lib/entitlements/lifecycle.ts). Owner decision 2026-10-31: these
 * replace "isn't available on your plan" wherever the refusal comes from a
 * lifecycle restriction — the plan is unchanged, the paid work is on hold.
 *
 * ONE helper, so every route, the refresh report and Conversations' refusal
 * recogniser (lib/ai/conversation/refusal-sentences.ts) say the same words.
 * Pure and client-safe: no server import, no I/O.
 */

export type RestrictionKind = "BETA_PAUSED" | "BETA_ENDED" | "COST_FREEZE" | "POLICY_UNAVAILABLE";
export const RESTRICTION_KINDS: readonly RestrictionKind[] = ["BETA_PAUSED", "BETA_ENDED", "COST_FREEZE", "POLICY_UNAVAILABLE"];

export const RESTRICTION_MESSAGES: Readonly<Record<RestrictionKind, string>> = Object.freeze({
  BETA_PAUSED: "Beta is paused — paid features are temporarily unavailable.",
  BETA_ENDED: "Beta has ended — your account is read-only.",
  COST_FREEZE: "Paid features are temporarily frozen.",
  POLICY_UNAVAILABLE: "We couldn't verify your plan right now — paid features are paused for safety.",
});

/** The customer-facing sentence for a restriction. */
export function restrictionMessage(kind: RestrictionKind): string {
  return RESTRICTION_MESSAGES[kind];
}

/** The machine code a refusal carries (clients and operators map it; the customer reads the message). */
export const RESTRICTION_CODES: Readonly<Record<RestrictionKind, string>> = Object.freeze({
  BETA_PAUSED: "PLAN_PAUSED",
  BETA_ENDED: "PLAN_ENDED",
  COST_FREEZE: "PLAN_COST_FROZEN",
  POLICY_UNAVAILABLE: "PLAN_UNAVAILABLE",
});

/** HTTP status: a group state is a 403; an unreadable policy is a transient 503. */
export function restrictionStatus(kind: RestrictionKind): 403 | 503 {
  return kind === "POLICY_UNAVAILABLE" ? 503 : 403;
}
