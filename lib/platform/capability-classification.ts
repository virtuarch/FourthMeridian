/**
 * lib/platform/capability-classification.ts  (OPS-2D-2)
 *
 * A CLASSIFICATION TABLE, NOT AN AUTHORIZATION SYSTEM.
 * ---------------------------------------------------
 * This module answers "which capability *should* a mutation family require?".
 * It never answers "may this caller proceed?" — that question has exactly one
 * authority, `hasPlatformAccess` / `requirePlatformAccess`, and this file must
 * never become a second one.
 *
 * The boundary is kept STRUCTURAL rather than promised: nothing outside tests
 * imports this module, and `capability-control.test.ts` fails if anything ever
 * does. So a reader who wonders "is this enforced?" can settle it by grep, not
 * by trusting a comment.
 *
 * WHY IT EXISTS
 * -------------
 * OPS-2D-2 added CONTROL to `PlatformAccessLevel` with no consumers. A rank with
 * no consumers and no written intent decays into a coin flip: the first person
 * to ship a scheduler hold picks WRITE or CONTROL by mood, and after two or
 * three such choices the distinction is gone and WRITE is the umbrella again —
 * exactly the outcome CONTROL was introduced to prevent. This table is the
 * intent, recorded while it is still fresh and before anything depends on it.
 *
 * THE DISTINCTION, IN ONE LINE
 * ----------------------------
 *   WRITE   — do operational work WITHIN the platform's current behaviour.
 *   CONTROL — change what the platform's behaviour IS.
 *
 * "Resync this connection now" is WRITE: it asks for work the platform already
 * performs on a schedule, one occurrence earlier. "Stop syncing this connection"
 * is CONTROL: afterwards the platform behaves differently until someone changes
 * it back. The test is not blast radius and not reversibility — it is whether
 * the platform's steady-state behaviour is the same after the action as before.
 *
 * NOTHING HERE IS ENFORCED YET. Every `SHIPPED` row records the gate the route
 * carries TODAY, verified against source. Every `PLANNED` row records intent for
 * work that does not exist. Rows marked `UNRESOLVED` are genuine open questions
 * and are deliberately not guessed — see `OPEN_CLASSIFICATIONS`.
 */

import type { PlatformAccessLevel } from "@prisma/client";

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * What a family requires. `SYSTEM_ADMIN` is NOT a `PlatformAccessLevel` — it is
 * the Emergency axis (UserRole + break-glass bypass in authorize.ts), a
 * different authority entirely, and it is spelled out here only so the table can
 * state that some families are deliberately not reachable by any grant.
 */
export type ClassifiedCapability = PlatformAccessLevel | "SYSTEM_ADMIN";

/**
 * SHIPPED    — the family exists; `capability` is the gate the code carries now.
 * PLANNED    — the family does not exist; `capability` is the intended gate.
 * UNRESOLVED — the family exists but its classification is genuinely contested.
 *              `capability` is what it carries TODAY, and `tension` says why
 *              that may be wrong. Never silently "resolved" by this slice.
 */
export type ClassificationStatus = "SHIPPED" | "PLANNED" | "UNRESOLVED";

export interface MutationFamily {
  /** Stable identifier for the family (kebab-case). */
  key: string;
  /** What the family does, in the operator's words. */
  label: string;
  status: ClassificationStatus;
  /**
   * SHIPPED/UNRESOLVED: the gate the code carries today.
   * PLANNED: the gate the family is intended to carry when built.
   */
  capability: ClassifiedCapability;
  /** Why this capability and not the neighbouring one. */
  rationale: string;
  /**
   * SHIPPED/UNRESOLVED only — the route files that carry the gate. Verified
   * against source by capability-control.test.ts, so a route that changes its
   * gate without updating this table fails the build.
   */
  routes?: readonly string[];
  /** UNRESOLVED only — the argument for a different classification. */
  tension?: string;
}

// ── The table ─────────────────────────────────────────────────────────────────

export const MUTATION_FAMILIES: readonly MutationFamily[] = [
  // ── READ ────────────────────────────────────────────────────────────────────
  {
    key: "observation",
    label: "Observation & read models",
    status: "SHIPPED",
    capability: "READ",
    rationale:
      "Dashboards, projections, execution history, coverage, health, inspection " +
      "panels, audit evidence. Observation never changes anything, so it never " +
      "needs more than READ — and a control-plane surface that is merely LOOKED " +
      "at must not require CONTROL, or operators will be over-granted just to " +
      "see the state they are responsible for.",
    // Representative, not exhaustive — every /api/platform read route is in this
    // family. These four are pinned so the claim stays checkable at a glance.
    routes: [
      "app/api/platform/platform-ops/refresh/summary/route.ts",
      "app/api/platform/platform-ops/scheduler/route.ts",
      "app/api/platform/platform-ops/connection-health/route.ts",
      "app/api/platform/customer-success/sync-issues/route.ts",
    ],
  },

  // ── WRITE ───────────────────────────────────────────────────────────────────
  {
    key: "refresh-request",
    label: "Refresh / resync requests",
    status: "SHIPPED",
    capability: "WRITE",
    rationale:
      "Asks for an occurrence of work the platform already performs on its own " +
      "schedule — one execution, now, under the existing policy. Steady-state " +
      "behaviour after the action is identical to before it. Bounded by the " +
      "per-item lock and the manual cooldown, and it leaves a RefreshExecution " +
      "row (OPS-2D-1), so it is observable rather than quiet. Stays WRITE.",
    routes: [
      "app/api/platform/platform-ops/connections/[id]/resync/route.ts",
      "app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts",
    ],
  },
  {
    key: "beta-access-decisions",
    label: "Beta access requests — approve / deny / resend / revoke, invitations",
    status: "SHIPPED",
    capability: "WRITE",
    rationale:
      "Per-subject decisions taken WITHIN the registration policy in force. " +
      "Approving one request does not change who else may register; it applies " +
      "the existing rule to one person. Ordinary operational work.",
    routes: [
      "app/api/platform/growth-revenue/requests/[id]/approve/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/deny/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/resend/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/revoke/route.ts",
      "app/api/platform/growth-revenue/invitations/route.ts",
    ],
  },
  {
    key: "account-lifecycle",
    label: "Customer account lifecycle — deactivate / reactivate one user",
    status: "SHIPPED",
    capability: "WRITE",
    rationale:
      "Scoped to a single subject and reversible by the same surface. It changes " +
      "one account's state, not the platform's behaviour — the next user signs up, " +
      "syncs and is served exactly as before. Note this is deliberately NOT the " +
      "same family as 'lifecycle changes' in the control-plane sense: the axis is " +
      "whose lifecycle, not the word.",
    routes: ["app/api/platform/growth-revenue/users/[userId]/route.ts"],
  },

  // ── CONTROL (all PLANNED — nothing here exists) ─────────────────────────────
  {
    key: "ingestion-hold",
    label: "Pause / resume ingestion for a connection, provider, or the platform",
    status: "PLANNED",
    capability: "CONTROL",
    rationale:
      "The platform behaves differently until someone changes it back. A paused " +
      "connection silently stops producing the freshness the rest of the product " +
      "asserts, which is precisely the class of change that must not be reachable " +
      "by the same grant that triggers a resync.",
  },
  {
    key: "scheduler-hold",
    label: "Hold / release scheduled work",
    status: "PLANNED",
    capability: "CONTROL",
    rationale:
      "Holding a job suppresses every future occurrence, not one. It also makes " +
      "the dead-job detector's 'overdue' a lie unless the hold is a first-class " +
      "observable fact — so this family owes an operational record, not just a gate.",
  },
  {
    key: "provider-enablement",
    label: "Enable / disable a provider integration",
    status: "PLANNED",
    capability: "CONTROL",
    rationale:
      "Changes which providers the platform will call at all. Every downstream " +
      "freshness and coverage claim is conditioned on it.",
  },
  {
    key: "admission-override",
    label: "Override admission for an execution the policy would refuse",
    status: "PLANNED",
    capability: "CONTROL",
    rationale:
      "Deliberately defeats a declared policy for one execution. Whatever else " +
      "CONTROL means, it means this: the authority to act against the rule is " +
      "categorically above the authority to act under it.",
  },
  {
    key: "control-plane-policy",
    label: "Edit declared operational policy (cadence, admission rules, recovery policy)",
    status: "PLANNED",
    capability: "CONTROL",
    rationale:
      "Editing the rule outranks any single action the rule permits. This is the " +
      "family CONTROL exists for; if it were WRITE, WRITE would be the umbrella.",
  },

  // ── SYSTEM_ADMIN-only ───────────────────────────────────────────────────────
  {
    key: "grant-administration",
    label: "Mint / revoke platform grants",
    status: "SHIPPED",
    capability: "SYSTEM_ADMIN",
    rationale:
      "No platform capability may mint platform capabilities — that closes the " +
      "self-escalation class (SECURITY_MODEL.md). CONTROL does not change this and " +
      "must never be allowed to: a CONTROL holder who could issue grants would be " +
      "a SYSTEM_ADMIN by another name.",
    routes: [
      "app/api/admin/platform-grants/route.ts",
      "app/api/admin/platform-grants/[grantId]/route.ts",
    ],
  },
  {
    key: "emergency-administration",
    label: "Emergency administration — the DISABLE_SYSTEM_ADMIN kill switch, break-glass",
    status: "SHIPPED",
    capability: "SYSTEM_ADMIN",
    rationale:
      "The Emergency axis. Separate from the Operator axis by construction and " +
      "unchanged by OPS-2D-2 (SECURITY_MODEL.md §three axes).",
  },
];

// ── Open questions ────────────────────────────────────────────────────────────

/**
 * Families whose classification is genuinely unresolved. They are listed here
 * rather than guessed, because a wrong guess recorded confidently is worse than
 * a gap recorded honestly — the next slice would inherit it as settled.
 *
 * Each carries the gate it has TODAY. OPS-2D-2 reclassifies nothing.
 */
export const OPEN_CLASSIFICATIONS: readonly MutationFamily[] = [
  {
    key: "platform-wide-settings",
    label: "Platform-wide settings — registration mode, product status",
    status: "UNRESOLVED",
    capability: "WRITE",
    rationale:
      "Ships today as GROWTH_REVENUE / WRITE (PO-3C, lib/registration-policy.ts).",
    tension:
      "By the stated line these ARE control-plane: flipping registration_mode to " +
      "invite_only changes who may enter the platform until someone changes it " +
      "back — the platform's steady-state behaviour differs. But they predate " +
      "CONTROL, live on the GROWTH_REVENUE axis rather than PLATFORM_OPS, and " +
      "reclassifying them would revoke a capability a live operator currently has. " +
      "Resolve deliberately with the grant migration, not as a side effect.",
    routes: [
      "app/api/platform/growth-revenue/registration-mode/route.ts",
      "app/api/platform/growth-revenue/product-status/route.ts",
    ],
  },
  {
    key: "manual-operations",
    label: "Manual operations — Run Now / Dry Run over the command registry",
    status: "UNRESOLVED",
    capability: "WRITE",
    rationale:
      "Ships today as PLATFORM_OPS / WRITE (OPS-5 S4).",
    tension:
      "Running a registered job early is a refresh-request in spirit — an " +
      "occurrence of existing behaviour — which argues WRITE. But the registry is " +
      "open-ended and already includes process-deletions, an irreversible purge; " +
      "'apply an approved operational command' scales with whatever is registered, " +
      "so one classification for the whole surface may be the wrong shape. The " +
      "resolution may be per-command rather than per-route, which is a design " +
      "question OPS-2D-2 does not settle.",
    routes: ["app/api/platform/platform-ops/operations/route.ts"],
  },
];
