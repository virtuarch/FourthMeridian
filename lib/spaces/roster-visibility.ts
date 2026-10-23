/**
 * lib/spaces/roster-visibility.ts
 *
 * W1-D3 — pure member-roster serialization for GET /api/spaces/[id].
 * Pure module (no DB, no side effects) in the lib/spaces house style
 * (policy.ts / reporting-currency.ts precedent), so the disclosure rule is
 * unit-tested without route/DB machinery.
 *
 * WHY THIS EXISTS
 * ---------------
 * GET /api/spaces/[id] on a PUBLIC Space is readable by ANY authenticated
 * user (the documented SP-2b public-read exception), and it used to return
 * the full member roster — raw SpaceMember rows including
 * user.email — to non-members. Any signed-up user could harvest every
 * member's email address from any public Space.
 *
 * WHAT A NON-MEMBER MAY SEE
 * -------------------------
 * Exactly the shape the product already intentionally publishes for public
 * Spaces: app/(shell)/dashboard/spaces/page.tsx serializeMembers() serves
 * public-Space rosters to non-members as
 *   { id, role, joinedAt, user: { id, name, username } }
 * and the public surfaces (PublicSpaceCard / PublicSpaceDetailModal in
 * components/dashboard/SpacesClient.tsx) render only the owner's display name
 * and the member COUNT from it. This module mirrors that shape — never email,
 * never the SpaceMember scalars (userId/spaceId/status/revokedAt/revokedById).
 *
 * FAIL CLOSED: the public shape is built by PICKING allowlisted fields onto a
 * fresh object — never by deleting known-bad fields — so a future column on
 * SpaceMember or User can never leak to non-members by default.
 *
 * Members' own view is UNCHANGED: the input rows are returned as-is
 * (same references), so the member-facing JSON stays byte-identical.
 */

/** What a non-member of a public Space receives per roster row. */
export interface PublicRosterMember {
  id:       string;
  role:     string;
  joinedAt: Date | string;
  user: {
    id:       string;
    name:     string | null;
    username: string | null;
  };
}

/** Minimum input shape — the route's included rows carry more (email,
 *  userId, status, …); everything beyond this is dropped for non-members. */
export interface RosterMemberInput {
  id:       string;
  role:     string;
  joinedAt: Date | string;
  user: {
    id:       string;
    name:     string | null;
    username: string | null;
  };
}

/**
 * Serialize a Space's ACTIVE member roster for a viewer.
 *
 *  - ACTIVE member  → the rows pass through untouched (byte-identical view).
 *  - non-member (public-Space read) → each row is rebuilt from the public
 *    allowlist only: { id, role, joinedAt, user: { id, name, username } }.
 *    Order and length are preserved (the member count and the OWNER row are
 *    what the public surfaces render).
 */
export function rosterForViewer<M extends RosterMemberInput>(
  members: M[],
  isActiveMember: boolean,
): M[] | PublicRosterMember[] {
  if (isActiveMember) return members;

  return members.map((m): PublicRosterMember => ({
    id:       m.id,
    role:     m.role,
    joinedAt: m.joinedAt,
    user: {
      id:       m.user.id,
      name:     m.user.name,
      username: m.user.username,
    },
  }));
}
