/**
 * lib/entitlements/lifecycle.ts  (BETA LIFECYCLE L1 — pure)
 *
 * POLICY-GROUP LIFECYCLE AND COST FREEZE, AS DATA THE RESOLVER AND THE BILLABLE
 * GATE BOTH READ. Owner decisions (2026-10-31):
 *
 *   · BETA_FULL_ACCESS_V1 is the authoritative Beta entitlement group (the
 *     CLOSED_BETA_2026 cohort is rollout history only and grants nothing).
 *   · Lifecycle states ACTIVE / PAUSED / ENDED, stored on the PolicyGroup row.
 *       PAUSED  sign-in and existing-data reads stay; beta-only capabilities are
 *               suspended; NEW billable operations are denied; background work
 *               for the group stops initiating; reversible.
 *       ENDED   the group grants nothing. It transitions to Free once a Free
 *               group is defined; until then a SAFE TEMPORARY READ-ONLY state
 *               (login, existing data and account-security functions preserved;
 *               no billable operation).
 *   · COST FREEZE is an independent per-group flag: it disables every NEW
 *     billable AI, Plaid, crypto-provider and other metered operation and
 *     overrides EVERY allowance — the Founder overlay and the per-customer AI
 *     override included. Reversible without changing membership.
 *
 * RESOLUTION PRECEDENCE (resolve.ts; pinned by lifecycle.test.ts) — first match
 * decides the RESTRICTION reported; the VALUES are the most restrictive that apply:
 *
 *   0. FAIL CLOSED (unchanged: missing / unknown / invalid assignment) — no
 *      group is in force, so no group lifecycle applies; FAIL_CLOSED_VALUES.
 *   1. costFrozen        → restriction COST_FREEZE; billable dimensions take
 *                          READ_ONLY_VALUES (values from ENDED below if ENDED too).
 *   2. lifecycle ENDED   → restriction BETA_ENDED; EVERY dimension READ_ONLY_VALUES.
 *   3. lifecycle PAUSED  → restriction BETA_PAUSED; billable dimensions READ_ONLY_VALUES.
 *   4. otherwise the existing resolution (group → overlay → override → ceiling).
 *
 *   Before 1–3: when the catalogue's lifecycle facts are UNREADABLE (the code
 *   fallback, the served last-good copy, or a failed lifecycle read) the
 *   restriction is POLICY_UNAVAILABLE and the billable dimensions take
 *   READ_ONLY_VALUES — a group's freeze / pause / end can then not be seen, so
 *   new billable work is denied; read dimensions (Brief reading, exports) keep
 *   their plan values.
 *
 * In 1–3 the overlay, the per-customer AI override and the platform allowance
 * setting are NOT candidates: nothing user-level can bypass a freeze, a pause or
 * an end. The platform ceiling still clamps last (the restricted values are all
 * within it).
 *
 * Pure: no I/O, no clock.
 */

import { DIMENSION_KEYS, type EntitlementDimensionKey, type EntitlementValues } from "./catalogue";
import type { RestrictionKind } from "./restriction-messages";

export const POLICY_GROUP_LIFECYCLES = ["ACTIVE", "PAUSED", "ENDED"] as const;
export type PolicyGroupLifecycleState = (typeof POLICY_GROUP_LIFECYCLES)[number];
export type PolicyGroupEndedTransitionKind = "READ_ONLY" | "FREE";
export type PolicyGroupTransitionKindName = "PAUSE" | "RESUME" | "END" | "FREEZE" | "UNFREEZE";

/**
 * Why a customer's billable entitlements are restricted (the resolver's and the gate's vocabulary).
 * POLICY_UNAVAILABLE is not a group state: the resolver reports it when the lifecycle facts
 * could not be read (see resolve.ts) — the owner's "deny new billable work when policy
 * evaluation is unavailable", applied to every resolver-driven route.
 */
export type LifecycleRestriction = RestrictionKind;

/** The authoritative Beta entitlement group (owner decision 2026-10-31). */
export const BETA_POLICY_GROUP_KEY = "BETA_FULL_ACCESS_V1";

export function isLifecycleState(v: unknown): v is PolicyGroupLifecycleState {
  return typeof v === "string" && (POLICY_GROUP_LIFECYCLES as readonly string[]).includes(v);
}

/**
 * THE READ-ONLY ENTITLEMENT SET — what an ENDED group's members resolve to (and
 * what the billable dimensions of a PAUSED / cost-frozen group resolve to).
 *
 * Owner rule: booleans off, counts 0, cooldowns at the maximum — EXCEPT where a
 * dimension gates READING EXISTING DATA, which the owner preserved:
 *   conversations            false  — a new conversation turn is paid generation.
 *   dailyBrief               true   — this boolean gates GET /api/brief, i.e.
 *                                     READING an existing Brief. Generation is
 *                                     denied by the allowance (0) here and by the
 *                                     billable gate ("daily_brief").
 *   aiTurnsPerMinute / Hour  0      — no paid model turns.
 *   aiDailyUsdAllowance      0      — every allowance check refuses.
 *   manualBankRefreshCooldownMinutes 10080 (7 days, the editor maximum) — no
 *                                     manual refresh (a paid provider call).
 *   manualWalletRefreshPerHour 0    — no manual wallet syncs.
 *   exportsPerDay            1      — an export is a read of the customer's OWN
 *                                     existing data (data portability), kept at one.
 *   maxConnections           0      — no NEW connection; existing ones untouched.
 *
 * Deliberately equal to FAIL_CLOSED_VALUES today (both mean "safe read-only"),
 * declared separately so a future change to one is a decision about one.
 */
export const READ_ONLY_VALUES: EntitlementValues = Object.freeze({
  conversations: false,
  dailyBrief: true,
  aiTurnsPerMinute: 0,
  aiTurnsPerHour: 0,
  manualBankRefreshCooldownMinutes: 10_080,
  manualWalletRefreshPerHour: 0,
  exportsPerDay: 1,
  aiDailyUsdAllowance: 0,
  maxConnections: 0,
});

/**
 * The dimensions that grant NEW billable / metered work — restricted by PAUSED
 * and by a cost freeze. `exportsPerDay` is the only one that is not: an export
 * reads the customer's own data and calls no metered provider. (`dailyBrief`
 * is listed: its READ_ONLY value stays `true` — reading — and generation is
 * denied by the allowance.)
 */
export const BILLABLE_DIMENSIONS: ReadonlySet<EntitlementDimensionKey> = new Set(
  DIMENSION_KEYS.filter((k) => k !== "exportsPerDay"),
);

export interface GroupLifecycleFacts {
  lifecycle: PolicyGroupLifecycleState;
  costFrozen: boolean;
}

/** PURE — the restriction a group in force imposes, by the documented precedence (null = none). */
export function lifecycleRestrictionOf(g: GroupLifecycleFacts | null | undefined): LifecycleRestriction | null {
  if (!g) return null;
  if (g.costFrozen) return "COST_FREEZE";
  if (g.lifecycle === "ENDED") return "BETA_ENDED";
  if (g.lifecycle === "PAUSED") return "BETA_PAUSED";
  return null;
}

/**
 * PURE — the restricted value for one dimension, or null when the plan's value
 * stands. ENDED restricts EVERY dimension (whatever else applies); PAUSED and
 * a cost freeze restrict the billable ones.
 */
export function restrictedValue(g: GroupLifecycleFacts, key: EntitlementDimensionKey): EntitlementValues[EntitlementDimensionKey] | null {
  if (g.lifecycle === "ENDED") return READ_ONLY_VALUES[key];
  if ((g.costFrozen || g.lifecycle === "PAUSED") && BILLABLE_DIMENSIONS.has(key)) return READ_ONLY_VALUES[key];
  return null;
}

// ── Transitions ───────────────────────────────────────────────────────────────

export type LifecycleAction = "pause" | "resume" | "end" | "freeze" | "unfreeze";
export const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ["pause", "resume", "end", "freeze", "unfreeze"];
export function isLifecycleAction(v: unknown): v is LifecycleAction {
  return typeof v === "string" && (LIFECYCLE_ACTIONS as readonly string[]).includes(v);
}

export interface LifecycleState extends GroupLifecycleFacts {
  endedTransition: PolicyGroupEndedTransitionKind | null;
}

export type TransitionPlan =
  | { ok: true; kind: PolicyGroupTransitionKindName; from: LifecycleState; to: LifecycleState }
  | { ok: false; error: string; needsNote?: true };

/**
 * PURE — the ONE transition table.
 *
 *   pause     ACTIVE → PAUSED                      (refused when PAUSED or ENDED)
 *   resume    PAUSED → ACTIVE
 *             ENDED  → ACTIVE  — "reopen": allowed, but ONLY with a reason NOTE
 *                                (a reopened Beta re-grants paid access to every
 *                                member, so the why must be written down)
 *                                (refused when ACTIVE)
 *   end       ACTIVE | PAUSED → ENDED, endedTransition READ_ONLY (FREE reserved)
 *                                (refused when ENDED)
 *   freeze    costFrozen false → true, any lifecycle (refused when frozen)
 *   unfreeze  costFrozen true → false, any lifecycle (refused when not frozen)
 *
 * The lifecycle and the freeze are independent: a freeze never changes the
 * lifecycle and a lifecycle move never changes the freeze.
 */
export function planLifecycleTransition(from: LifecycleState, action: LifecycleAction, hasNote: boolean): TransitionPlan {
  const to = (p: Partial<LifecycleState>): LifecycleState => ({ ...from, ...p });
  switch (action) {
    case "pause":
      if (from.lifecycle === "PAUSED") return { ok: false, error: "The group is already paused." };
      if (from.lifecycle === "ENDED") return { ok: false, error: "The group has ended — resume (reopen) it first; an ended group cannot be paused." };
      return { ok: true, kind: "PAUSE", from, to: to({ lifecycle: "PAUSED" }) };
    case "resume":
      if (from.lifecycle === "ACTIVE") return { ok: false, error: "The group is already active." };
      if (from.lifecycle === "ENDED" && !hasNote) {
        return { ok: false, needsNote: true, error: "Reopening an ended group re-grants its plan to every member — a reason note is required." };
      }
      return { ok: true, kind: "RESUME", from, to: to({ lifecycle: "ACTIVE", endedTransition: null }) };
    case "end":
      if (from.lifecycle === "ENDED") return { ok: false, error: "The group has already ended." };
      return { ok: true, kind: "END", from, to: to({ lifecycle: "ENDED", endedTransition: "READ_ONLY" }) };
    case "freeze":
      if (from.costFrozen) return { ok: false, error: "The group's costs are already frozen." };
      return { ok: true, kind: "FREEZE", from, to: to({ costFrozen: true }) };
    case "unfreeze":
      if (!from.costFrozen) return { ok: false, error: "The group's costs are not frozen." };
      return { ok: true, kind: "UNFREEZE", from, to: to({ costFrozen: false }) };
  }
}
