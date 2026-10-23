/**
 * lib/spaces/invite-role.ts
 *
 * W1-D3 — pure invite-role validation for the Space membership routes.
 * Pure module (no DB, no side effects) in the lib/spaces house style
 * (policy.ts / reporting-currency.ts precedent), so the allowlist is
 * unit-tested without route/DB machinery.
 *
 * WHY THIS EXISTS
 * ---------------
 * POST /api/spaces/[id]/invite used to persist the client-sent `role` with
 * `role as never` — no validation at all. Because SpaceInvite.role is the
 * SpaceMemberRole enum, any of its four values passed the DB constraint,
 * including OWNER: an ADMIN could invite a user as OWNER and the acceptance
 * route would mint a second OWNER (every OWNER-only gate — archive, delete,
 * role management — trusts `role === OWNER`, so this was privilege escalation).
 *
 * THE ALLOWLIST
 * -------------
 * The roles the product legitimately grants by invite are exactly the ones the
 * invite UI offers (components/space/widgets/members/MembersInvite.tsx
 * ROLE_OPTIONS) and the ones the role-change route already allowlists
 * (PROMOTABLE_ROLES in app/api/spaces/[id]/members/[userId]/route.ts):
 * ADMIN, MEMBER, VIEWER. OWNER is NEVER invitable — a Space has exactly one
 * OWNER, born at creation; changing it is a future ownership-transfer flow,
 * not an invite.
 *
 * Enforced at BOTH boundaries:
 *   - invite creation  (parseInviteRoleInput — rejects before the row exists)
 *   - invite acceptance (isInvitableSpaceRole — the point where the
 *     SpaceMember row is written, so a pre-existing bad invite row can never
 *     mint an OWNER either)
 */

/**
 * Roles an invite may carry. Mirrors SpaceMemberRole minus OWNER — kept as
 * string literals (not the Prisma enum import) so the module stays pure and
 * client-safe; the literal values are identical to what Prisma generates.
 */
export const INVITABLE_SPACE_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const;

export type InvitableSpaceRole = (typeof INVITABLE_SPACE_ROLES)[number];

/** Type-guard form, for validating a role that already exists (e.g. a
 *  persisted SpaceInvite.role at acceptance time). OWNER fails. */
export function isInvitableSpaceRole(role: string): role is InvitableSpaceRole {
  return (INVITABLE_SPACE_ROLES as readonly string[]).includes(role);
}

export interface ParsedInviteRole {
  ok:   true;
  role: InvitableSpaceRole;
}
export interface RejectedInviteRole {
  ok:    false;
  error: string;
}

/**
 * Validate a POST-body `role` input. An absent role defaults to MEMBER
 * (the pre-existing route default, unchanged); anything else must be one of
 * INVITABLE_SPACE_ROLES exactly — OWNER, unknown strings, and non-strings are
 * all rejected. The route maps a rejection to HTTP 400.
 */
export function parseInviteRoleInput(
  input: unknown,
): ParsedInviteRole | RejectedInviteRole {
  if (input === undefined) {
    return { ok: true, role: "MEMBER" };
  }
  if (typeof input !== "string" || !isInvitableSpaceRole(input)) {
    return {
      ok:    false,
      error: `Invalid role. Must be one of: ${INVITABLE_SPACE_ROLES.join(", ")}`,
    };
  }
  return { ok: true, role: input };
}
