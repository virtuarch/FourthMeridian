/**
 * lib/spaces/policy.ts
 *
 * SP-2a — Centralized Space authorization policy.
 *
 * The single, pure home for Space role + lifecycle authorization decisions.
 * `can(action, ctx)` answers "may a member with this role / status, in a Space
 * of this type, perform this action?" — decided entirely from
 * { role, status, spaceType } with no I/O, no session, and no DB access.
 *
 * SCOPE (SP-2a): additive, ZERO callers. No route imports this yet; the route
 * migration and the session-aware `requireSpaceAction(spaceId, action)` adapter
 * land in a later slice (SP-2b). This file is the pure predicate only.
 *
 * BOUNDARY — what `can()` does NOT decide:
 * Some route gates carry a resource-relationship predicate that cannot be
 * derived from { role, status, spaceType } alone. `can()` returns the
 * ROLE/LIFECYCLE portion only; the residuals below are applied by the route
 * (in SP-2b), OR-ed / AND-ed with `can()`:
 *   - account:share      AND caller owns the FinancialAccount
 *   - account:revoke     OR  caller is the link's addedByUserId
 *   - member:manageRoles AND target !== OWNER; target ACTIVE; new role in {ADMIN,MEMBER,VIEWER}
 *   - member:remove      OR  isSelf (self-leave); AND cannot remove OWNER unless self
 *   - space:archive/delete AND data-state guards (not-trashed / not-already-trashed)
 *   - space:read         OR  space.isPublic (non-member path — has no membership ctx)
 *
 * Grounded 1:1 in the current route gates; this module mirrors existing
 * behavior and introduces no new rule. See
 * docs/initiatives/sp2/SP-2A_IMPLEMENTATION_CHECKLIST.md.
 */

import type {
  SpaceMemberRole,
  SpaceMemberStatus,
  SpaceType,
} from "@prisma/client";

// ── Action space ──────────────────────────────────────────────────────────────

/**
 * Every Space-scoped operation the policy module knows about. Kept
 * semantically distinct (not collapsed by shared gate) so authorization stays
 * auditable per real route operation.
 */
export type SpaceAction =
  // Space lifecycle
  | "space:read"
  | "space:edit"            // name / description / isPublic / category
  | "space:archive"         // set / clear archivedAt
  | "space:delete"          // move to trash (deletedAt)
  | "space:deletePermanent" // permanent removal
  // Membership
  | "member:invite"
  | "member:manageRoles"    // change another member's role
  | "member:remove"         // remove another member (self-leave is a route residual)
  // Sections
  | "section:read"
  | "section:edit"
  // Goals
  | "goal:read"
  | "goal:edit"             // create / update / delete goal
  | "goal:checkIn"          // HABIT check-in
  // Accounts (Space-account links)
  | "account:read"
  | "account:share"         // + ownership residual (route)
  | "account:revoke"        // + adder residual (route)
  // Read surfaces
  | "snapshot:read"
  | "transaction:read"
  | "activity:read"
  | "perspective:read";

// ── Policy context ────────────────────────────────────────────────────────────

/** The minimal, pure input required to decide a role/lifecycle action. */
export interface SpacePolicyContext {
  role:      SpaceMemberRole;   // OWNER | ADMIN | MEMBER | VIEWER
  status:    SpaceMemberStatus; // ACTIVE | REMOVED | LEFT
  spaceType: SpaceType;         // PERSONAL | SHARED
}

// ── Role rank ─────────────────────────────────────────────────────────────────

/**
 * Canonical role precedence for min-role comparisons. This module is the
 * intended long-term home for the ranking; consolidating
 * `lib/session.ts` (ROLE_ORDER) and `lib/space.ts` (derivePermissions) onto
 * this is deferred to a later slice — not touched here.
 */
const ROLE_RANK: Record<SpaceMemberRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN:  2,
  OWNER:  3,
};

// ── Action → rule table ───────────────────────────────────────────────────────

interface ActionRule {
  /** Minimum role required (when ACTIVE). */
  minRole: SpaceMemberRole;
  /**
   * When true, the action is denied on a PERSONAL Space regardless of role
   * (the lifecycle trio). Mirrors the API-layer PERSONAL guards.
   */
  sharedOnly: boolean;
}

/**
 * Complete rule map. Typed as `Record<SpaceAction, ActionRule>` so the
 * compiler REQUIRES every union member to be present — a missing action is a
 * type error. This is the exhaustiveness guarantee for `can()`.
 */
const ACTION_POLICY: Record<SpaceAction, ActionRule> = {
  // Space lifecycle
  "space:read":            { minRole: "VIEWER", sharedOnly: false },
  "space:edit":            { minRole: "ADMIN",  sharedOnly: false },
  "space:archive":         { minRole: "OWNER",  sharedOnly: true  },
  "space:delete":          { minRole: "OWNER",  sharedOnly: true  },
  "space:deletePermanent": { minRole: "OWNER",  sharedOnly: true  },
  // Membership
  "member:invite":         { minRole: "ADMIN",  sharedOnly: false },
  "member:manageRoles":    { minRole: "OWNER",  sharedOnly: false },
  "member:remove":         { minRole: "ADMIN",  sharedOnly: false },
  // Sections
  "section:read":          { minRole: "VIEWER", sharedOnly: false },
  "section:edit":          { minRole: "ADMIN",  sharedOnly: false },
  // Goals
  "goal:read":             { minRole: "VIEWER", sharedOnly: false },
  "goal:edit":             { minRole: "ADMIN",  sharedOnly: false },
  "goal:checkIn":          { minRole: "VIEWER", sharedOnly: false },
  // Accounts
  "account:read":          { minRole: "VIEWER", sharedOnly: false },
  "account:share":         { minRole: "VIEWER", sharedOnly: false },
  "account:revoke":        { minRole: "ADMIN",  sharedOnly: false },
  // Read surfaces
  "snapshot:read":         { minRole: "VIEWER", sharedOnly: false },
  "transaction:read":      { minRole: "VIEWER", sharedOnly: false },
  "activity:read":         { minRole: "VIEWER", sharedOnly: false },
  "perspective:read":      { minRole: "VIEWER", sharedOnly: false },
};

/** Every known action, derived from the rule map (stays in sync with the union). */
export const ALL_SPACE_ACTIONS = Object.keys(ACTION_POLICY) as SpaceAction[];

// ── Decision ──────────────────────────────────────────────────────────────────

/**
 * Pure role/lifecycle authorization decision.
 *
 *   1. A non-ACTIVE member (REMOVED / LEFT) is denied EVERY action, including
 *      reads — no residual access for a departed member.
 *   2. The lifecycle trio (archive / delete / deletePermanent) is denied on a
 *      PERSONAL Space regardless of role.
 *   3. Otherwise, allow iff the member's role meets the action's minimum.
 *
 * Deterministic; same arguments always yield the same result.
 */
export function can(action: SpaceAction, ctx: SpacePolicyContext): boolean {
  // 1. Membership must be live.
  if (ctx.status !== "ACTIVE") return false;

  const rule = ACTION_POLICY[action];

  // 2. PERSONAL Spaces cannot be archived, trashed, or permanently deleted.
  if (rule.sharedOnly && ctx.spaceType === "PERSONAL") return false;

  // 3. Min-role gate.
  return ROLE_RANK[ctx.role] >= ROLE_RANK[rule.minRole];
}
