/**
 * lib/entitlements/billable-gate-core.ts  (BETA LIFECYCLE L1 — the pure decision)
 *
 * "MAY THIS CUSTOMER CAUSE THIS NEW BILLABLE OPERATION RIGHT NOW?" — one
 * function over facts, no I/O and no clock read (the caller hands in `nowMs`).
 * The I/O wrapper is lib/entitlements/billable-gate.ts.
 *
 * DECISION ORDER (first match wins; pinned by billable-gate.test.ts):
 *
 *   1. DATA_ACCESS operations (`export` — a read of the customer's OWN data,
 *      no metered provider) are never refused for lifecycle, freeze, missing
 *      owner or an unavailable policy: reads stay available (owner decision).
 *      Only a resolved `exportsPerDay` of 0 refuses them (NOT_ENTITLED).
 *   2. METERED, no customer to bill (no user, a Space with no single ACTIVE
 *      OWNER) ⇒ NO_OWNER.
 *   3. METERED, no FRESH catalogue (unreadable, older than 30 s, the last-good
 *      copy, the code fallback, or lifecycle facts unavailable) ⇒
 *      POLICY_UNAVAILABLE — fail closed.
 *   4. The effective entitlements (resolve.ts, which applies the lifecycle):
 *        failClosed (missing / unknown / invalid assignment) ⇒ NOT_ENTITLED;
 *        restriction COST_FREEZE ⇒ COST_FREEZE;
 *        restriction BETA_ENDED  ⇒ BETA_ENDED;
 *        restriction BETA_PAUSED ⇒ BETA_PAUSED.
 *      The overlay and the per-customer AI override are never consulted
 *      before these: nothing user-level bypasses a freeze, a pause or an end.
 *   5. The operation's own entitlement (OPERATION_REQUIREMENTS) is off ⇒
 *      NOT_ENTITLED (e.g. `ai_chat` with Conversations off).
 *   6. Allowed.
 *
 * This is a yes/no on POLICY STATE. Quotas (turns per hour, the daily AI
 * allowance amount, cooldowns, the connection count) stay with their existing
 * enforcement; platform admission (maintenance, ingestion paused) stays with
 * lib/platform/admission. The gate is an additional, earlier "no".
 */

import type { EntitlementDimensionKey } from "./catalogue";
import { resolveEffectiveEntitlements, type AssignmentFacts, type EffectiveEntitlements } from "./resolve";
import type { PolicyGroupCatalogue } from "./policy-groups";

export const BILLABLE_FRESHNESS_MS = 30_000;

export const BILLABLE_OPERATIONS = [
  "ai_chat", "daily_brief",
  "plaid_link", "plaid_exchange", "plaid_sync", "plaid_webhook_sync", "plaid_resume_sync",
  "wallet_capture", "wallet_sync", "crypto_backfill", "price_history",
  "export", "manual_refresh",
] as const;
export type BillableOperation = (typeof BILLABLE_OPERATIONS)[number];

export type BillableDenialReason = "COST_FREEZE" | "BETA_PAUSED" | "BETA_ENDED" | "POLICY_UNAVAILABLE" | "NOT_ENTITLED" | "NO_OWNER";
export type BillableDecision = { allowed: true } | { allowed: false; reason: BillableDenialReason };

export function isBillableOperation(v: unknown): v is BillableOperation {
  return typeof v === "string" && (BILLABLE_OPERATIONS as readonly string[]).includes(v);
}

/**
 * METERED = causes a paid / metered provider call (AI model, Plaid, crypto
 * explorers, price APIs). DATA_ACCESS = reads the customer's own data.
 */
export const OPERATION_CLASS: Readonly<Record<BillableOperation, "METERED" | "DATA_ACCESS">> = {
  ai_chat: "METERED", daily_brief: "METERED",
  plaid_link: "METERED", plaid_exchange: "METERED", plaid_sync: "METERED", plaid_webhook_sync: "METERED", plaid_resume_sync: "METERED",
  wallet_capture: "METERED", wallet_sync: "METERED", crypto_backfill: "METERED", price_history: "METERED",
  manual_refresh: "METERED",
  export: "DATA_ACCESS",
};

/** An operation's own entitlement: the dimensions that must be on (boolean) or above zero (count). */
export const OPERATION_REQUIREMENTS: Readonly<Partial<Record<BillableOperation, readonly EntitlementDimensionKey[]>>> = {
  ai_chat: ["conversations", "aiTurnsPerHour"],
  daily_brief: ["dailyBrief"],
  // Establishing a NEW connection (the cap gates creation only).
  plaid_link: ["maxConnections"],
  wallet_capture: ["maxConnections"],
  export: ["exportsPerDay"],
};

const ALLOWED: BillableDecision = Object.freeze({ allowed: true as const });
const deny = (reason: BillableDenialReason): BillableDecision => ({ allowed: false, reason });

/**
 * PURE — a catalogue a billable decision may use: a successful DB read (values
 * AND lifecycle) at most BILLABLE_FRESHNESS_MS old, not the last-good copy.
 * The code catalogue (by construction or as a fallback) never qualifies: it
 * carries no lifecycle state, so a pause or a freeze would be invisible.
 */
export function isCatalogueFreshForBillable(c: PolicyGroupCatalogue | null | undefined, nowMs: number, maxAgeMs = BILLABLE_FRESHNESS_MS): c is PolicyGroupCatalogue {
  if (!c || c.source !== "DB" || c.servedFromLastGood === true || c.lifecycleSource !== "DB" || c.loadedAt === null) return false;
  const at = Date.parse(c.loadedAt);
  return Number.isFinite(at) && nowMs - at <= maxAgeMs && nowMs - at >= -maxAgeMs;
}

function satisfies(e: EffectiveEntitlements, key: EntitlementDimensionKey): boolean {
  const v = e.dimensions[key].value;
  return typeof v === "boolean" ? v : Number(v) > 0;
}

export interface BillableFacts {
  operation: BillableOperation;
  /** The customer the operation bills to, or null when none could be determined (NO_OWNER). */
  billedUserId: string | null;
  /** That customer's assignment row (null = none). Ignored when billedUserId is null. */
  assignment: AssignmentFacts | null;
  /** The catalogue the caller read — null when the read failed. Freshness is checked HERE. */
  catalogue: PolicyGroupCatalogue | null;
  /** env.isPolicyAssignmentFailClosed (the rollout switch). */
  failClosed: boolean;
  nowMs: number;
}

/** PURE — the decision (see the header for the order). */
export function decideBillable(f: BillableFacts): BillableDecision {
  const cls = OPERATION_CLASS[f.operation];
  if (cls === "DATA_ACCESS") {
    if (f.billedUserId === null || !isCatalogueFreshForBillable(f.catalogue, f.nowMs)) return ALLOWED;
    const e = resolveEffectiveEntitlements(f.assignment, undefined, { failClosed: f.failClosed, catalogue: f.catalogue });
    return (OPERATION_REQUIREMENTS[f.operation] ?? []).every((k) => satisfies(e, k)) ? ALLOWED : deny("NOT_ENTITLED");
  }
  if (f.billedUserId === null) return deny("NO_OWNER");
  if (!isCatalogueFreshForBillable(f.catalogue, f.nowMs)) return deny("POLICY_UNAVAILABLE");
  const e = resolveEffectiveEntitlements(f.assignment, undefined, { failClosed: f.failClosed, catalogue: f.catalogue });
  if (e.failClosed) return deny("NOT_ENTITLED");
  switch (e.lifecycleRestriction) {
    case "COST_FREEZE": return deny("COST_FREEZE");
    case "BETA_ENDED":  return deny("BETA_ENDED");
    case "BETA_PAUSED": return deny("BETA_PAUSED");
    default: break;
  }
  return (OPERATION_REQUIREMENTS[f.operation] ?? []).every((k) => satisfies(e, k)) ? ALLOWED : deny("NOT_ENTITLED");
}

/**
 * PURE — the customer a Space-scoped operation bills to: the Space's single
 * ACTIVE OWNER. Spaces have no billing column; ownership is SpaceMember rows
 * with role OWNER, and a SHARED Space may have several (or, for a platform
 * Space, none). Exactly one ⇒ that user; zero or more than one ⇒ null
 * (ambiguous ⇒ NO_OWNER for metered work — never a guess).
 */
export function billedOwnerOf(activeOwnerIds: readonly string[]): string | null {
  const unique = [...new Set(activeOwnerIds)];
  return unique.length === 1 ? unique[0] : null;
}
