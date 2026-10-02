/**
 * PATCH  /api/spaces/[id]/members/[userId]  — change a member's role
 * DELETE /api/spaces/[id]/members/[userId]  — remove a member
 *
 * PATCH rules:
 *   - Only the active OWNER can change roles
 *   - Cannot demote the OWNER (transfer ownership is a separate flow)
 *   - Cannot promote anyone to OWNER via this endpoint
 *   - Valid target roles: ADMIN, MEMBER, VIEWER
 *
 * DELETE rules:
 *   - Active OWNER/ADMIN can remove anyone except the OWNER (transfer ownership first)
 *   - An active member can remove themselves (leave the space)
 *
 * Soft-removal model (no row delete):
 *   1. SpaceMember.status → REMOVED (kicked) or LEFT (self)
 *   2. SpaceMember.revokedAt / revokedById populated
 *   3. WorkspaceAccountShare rows added by that user in this space → REVOKED
 *
 * The member row and their share records are preserved for audit history.
 *
 * ── RLS SLICE B — THE SELF-LEAVE PAIR, AND WHY IT IS NOW IN THE OTHER ORDER ──
 * The DELETE handler's two writes commit together to close a privacy gap: a
 * departed member's shared accounts must stop being visible in the same instant
 * their membership ends. Under RLS the ORDER inside that transaction became
 * load-bearing, and the order it had was the broken one.
 *
 *   `fm_visible_space_ids()` reads SpaceMember and is STABLE — evaluated against
 *   the SNAPSHOT OF THE STATEMENT that calls it. So within one transaction:
 *     · statement 1 flips the ACTING user's own membership to LEFT. Its own
 *       USING/WITH CHECK still see the pre-update ACTIVE row, so it succeeds.
 *     · statement 2 is a NEW statement. It sees the uncommitted LEFT row, the
 *       Space drops out of fm_visible_space_ids(), and
 *       `SpaceAccountLink.fm_app_upd` — `spaceId IN fm_visible_space_ids()` —
 *       matches NOTHING. updateMany returns `{count: 0}`. No error. The links
 *       stay ACTIVE and the privacy gap this transaction exists to close
 *       reopens, silently, for exactly the self-leave case.
 *
 * The fix needed no policy, no systemDb and no weakening: the two writes are
 * ORDER-INDEPENDENT, so the link revoke now runs FIRST, while the acting user is
 * still ACTIVE and the Space still visible, and the membership flip runs second,
 * where its own statement snapshot still shows it as ACTIVE. Both are
 * admissible, they are still in ONE transaction, and they still commit together
 * or not at all. Admin removal was never affected — the actor stays ACTIVE —
 * and is unchanged by the reorder.
 *
 * ⚠️ AND THE TARGET'S NAME IS NOT THE CALLER'S TO READ. Both handlers joined
 * `user: { firstName, lastName, email }` onto the target's SpaceMember row to
 * build a display name for the audit payload. fm_app's `User` policy is
 * `id = current_fm_user_id()` (§10), the relation is REQUIRED, and Prisma raises
 * "Inconsistent query result" rather than returning null — so the include would
 * have 500'd every role change and every removal. It is now a separate,
 * explicitly-named read on the deployment-wide client, of the same three
 * display columns, producing the identical `targetName` / `removedName`.
 *
 * ── RLS-T2 — THE REORDER FIXED THE CAUSE AND LEFT NO DETECTOR ────────────────
 * The link revoke in DELETE is a BULK conditional write whose `count` was thrown
 * away. The slice-B reorder above makes the shipped order the admissible one, but
 * a count nobody compares cannot tell a COMPLETE revoke from a PARTIAL one — and
 * a partial one leaves a departed member's shared accounts visible to the
 * remaining members while reporting success. The rows are now counted in the same
 * phase and `assertEveryObservedRowWasWritten` compares; a shortfall rolls the
 * pair back and raises instead of returning `{ ok: true }`.
 *
 * ⚠️ IT SHOULD NEVER FIRE, AND THAT IS THE POINT. On both paths the actor is
 * still ACTIVE when these two statements run, so the Space is visible and every
 * eligible row is writable. The guard exists to make that reasoning CHECKED at
 * runtime rather than argued in a comment.
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { SpaceMemberStatus, ShareStatus, SpaceMemberRole, SpaceType } from "@prisma/client";
import { withTenantDb }                            from "@/lib/db/tenant-context";
import { assertEveryObservedRowWasWritten }        from "@/lib/db/conditional-write";
import { requireSpaceRole }                   from "@/lib/session";
import { withApiHandler, getClientIp }            from "@/lib/api";
import { emitDomainEvent, dispatchDomainEvent }   from "@/lib/events/emit";
import type { DomainEvent }                       from "@/lib/events/types";

/**
 * The target member's display name for an audit payload.
 *
 * ⚠️ DELIBERATELY NOT withTenantDb — see the header. This is a co-member's
 * identity, which fm_app's `User` policy does not serve by design; the three
 * columns are exactly the ones the old `include` selected, and the fallback
 * chain is byte-identical to the one it fed.
 */
async function displayNameOf(userId: string): Promise<string> {
  const u = await db.user.findUnique({
    where:  { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!u) return userId;
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || userId;
}

const PROMOTABLE_ROLES: SpaceMemberRole[] = [
  SpaceMemberRole.ADMIN,
  SpaceMemberRole.MEMBER,
  SpaceMemberRole.VIEWER,
];

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) => {
  const { id: spaceId, userId: targetUserId } = await params;

  // requireSpaceRole enforces ACTIVE status + OWNER role —
  // a REMOVED or LEFT owner cannot change member roles.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  // Personal Spaces are strictly single-user — their only member is the OWNER
  // (whose role is immutable below anyway), so there is never a non-owner member
  // to re-role. Reject defensively so a role change can never be the operation
  // that first gives a personal Space a non-owner member. SHARED unaffected.
  const pspace = await withTenantDb(user.id, (tx) => tx.space.findUnique({
    where: { id: spaceId }, select: { type: true },
  }));
  if (pspace?.type === SpaceType.PERSONAL) {
    return NextResponse.json({ error: "Personal Spaces have no additional members to manage." }, { status: 400 });
  }

  // RLS slice B — the membership row is this Space's, which the ACTIVE OWNER
  // guard has made visible. The `user` include moved out (see the header).
  const targetMembership = await withTenantDb(user.id, (tx) => tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: targetUserId } },
  }));

  if (!targetMembership || targetMembership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (targetMembership.role === SpaceMemberRole.OWNER) {
    return NextResponse.json(
      { error: "Cannot change the owner's role. Transfer ownership first." },
      { status: 400 }
    );
  }

  const { role } = (await req.json()) as { role?: string };

  if (!role || !PROMOTABLE_ROLES.includes(role as SpaceMemberRole)) {
    return NextResponse.json(
      { error: `Invalid role. Must be one of: ${PROMOTABLE_ROLES.join(", ")}` },
      { status: 400 }
    );
  }

  // `SpaceMember.fm_app_upd` is `spaceId IN fm_visible_space_ids()` on both
  // clauses, and the acting OWNER is ACTIVE, so an ordinary role change is
  // admissible. (The arm this policy LACKS — `userId = me` — is what the DELETE
  // handler's reorder below works around, and what the re-join path in
  // invites/[inviteId] cannot.)
  const updated = await withTenantDb(user.id, (tx) => tx.spaceMember.update({
    where: { spaceId_userId: { spaceId, userId: targetUserId } },
    data: { role: role as SpaceMemberRole },
  }));

  const targetName = await displayNameOf(targetUserId);

  // EV-1 Slice 5B — MemberRoleChanged. Persist as the caller; dispatch after.
  // The registered handler notifies the TARGET user, and `Notification.fm_app_ins`
  // is `userId = current_fm_user_id()` — the acting owner structurally cannot
  // write it, which is why the handler phase is outside the boundary.
  const event: DomainEvent = {
    type:        "MemberRoleChanged",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { targetUserId, targetName, oldRole: targetMembership.role, newRole: role },
  };
  await withTenantDb(user.id, (tx) => emitDomainEvent(tx, event));
  await dispatchDomainEvent(event);

  return NextResponse.json(updated);
}, "PATCH /api/spaces/[id]/members/[userId]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) => {
  const { id: spaceId, userId: targetUserId } = await params;

  // requireSpaceRole(VIEWER) gates on ACTIVE status — REMOVED/LEFT members
  // cannot call this endpoint, not even for self-removal (they're already gone).
  // Role-specific checks (self vs. privileged) happen after.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;
  const { user, membership: callerMembership } = auth;

  // RLS slice B — see the PATCH note; the `user` include moved out.
  const targetMembership = await withTenantDb(user.id, (tx) => tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: targetUserId } },
  }));

  if (!targetMembership || targetMembership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const isSelf = user.id === targetUserId;
  const isPriv = ["OWNER", "ADMIN"].includes(callerMembership.role);

  // Can't remove the OWNER (transfer ownership first)
  if (targetMembership.role === "OWNER" && !isSelf) {
    return NextResponse.json({ error: "Cannot remove the Space owner" }, { status: 403 });
  }

  // Must be self or an admin/owner
  if (!isSelf && !isPriv) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now       = new Date();
  const newStatus = isSelf ? SpaceMemberStatus.LEFT : SpaceMemberStatus.REMOVED;

  // ── KD-4 Phase 3 — the member soft-update and the revoke of the links they
  //    added commit together. Previously non-atomic: a failed SAL revoke after
  //    the member flip left a departed member's shared accounts visible to the
  //    remaining members (a privacy gap). Snapshot regen below stays OUTSIDE.
  //
  // ⚠️ RLS slice B — THE BATCH ARRAY BECAME THE INTERACTIVE TRANSACTION
  // withTenantDb ALREADY OPENS, AND THE TWO STATEMENTS SWAPPED PLACES. The array
  // form takes no callback, so there was nowhere to set `app.user_id` — the
  // identity and the writes could not have shared a transaction at all. The
  // swap is the self-leave fix explained in full in the file header: the link
  // revoke must run while the acting user is still ACTIVE, because the
  // membership flip would otherwise make the Space invisible to the NEXT
  // statement and the revoke would match zero rows in silence. Same two writes,
  // same transaction, same all-or-nothing.
  await withTenantDb(user.id, async (tx) => {
    // 1. D3 Stage B4 — Revoke all active SpaceAccountLink rows the member added.
    //    FIRST, deliberately: see above.
    //
    // ⚠️ RLS-T2 — AND THE REORDER REMOVED THE CAUSE WITHOUT LEAVING A DETECTOR.
    // This is a BULK conditional write whose count was discarded entirely, which
    // is the nastier half of the zero-row problem (lib/db/conditional-write.ts):
    // a zero at least looks like nothing happened, but 1-of-2 looks exactly like
    // success — the statement returned, nothing raised, and the count was never
    // compared to anything. The rows a policy hid would simply not be rows the
    // statement matched, and a departed member's shared accounts would stay
    // visible to the remaining members. That is the privacy gap the atomicity in
    // this block exists to prevent, so it must not be able to half-happen
    // quietly.
    //
    // ⚠️ THE `count` IS THE GUARD, NOT AN OPTIMISATION TO BE HOISTED AWAY. It is
    // issued through the SAME client, in the SAME phase, over the SAME predicate,
    // which is the one circumstance in which a shortfall is determinate. A future
    // edit that deletes it because "the updateMany's where clause already says
    // that" removes the only thing that can tell a partial revoke from a complete
    // one. A shortfall rolls the whole transaction back — the member is NOT
    // removed and nothing is reported — which is the loud failure the doctrine
    // asks for, not a calm one.
    const revokeScope = {
      spaceId,
      addedByUserId: targetUserId,
      status:        ShareStatus.ACTIVE,
    };
    const eligibleLinks = await tx.spaceAccountLink.count({ where: revokeScope });
    const { count: revokedLinks } = await tx.spaceAccountLink.updateMany({
      where: revokeScope,
      data: {
        status:          ShareStatus.REVOKED,
        revokedAt:       now,
        revokedByUserId: isSelf ? targetUserId : user.id,
      },
    });
    assertEveryObservedRowWasWritten(
      {
        table:     "SpaceAccountLink",
        operation: "update",
        scope:     "the departing member's ACTIVE links in this Space",
      },
      eligibleLinks,
      revokedLinks,
    );
    // 2. Soft-update SpaceMember
    await tx.spaceMember.update({
      where: { spaceId_userId: { spaceId, userId: targetUserId } },
      data: {
        status:      newStatus,
        revokedAt:   now,
        revokedById: isSelf ? null : user.id,
      },
    });
  });

  // ── 2a/3. EV-1 Slice 3 — persist the audit row and regenerate the snapshot
  //   behind the event seam. The array-form transaction above (member flip +
  //   SAL revoke) is untouched and already committed; audit stays OUTSIDE it,
  //   exactly as before. The no-tx emit persists the AuditLog row and then
  //   dispatches the snapshot handler inline (post-commit, best-effort — a
  //   handler failure is warned and swallowed, so the removal still succeeds).
  //   Self-leave → MemberLeft (SPACE_LEAVE); admin removal → MemberRemoved
  //   (MEMBER_REMOVED). Timeline renders both exactly as before.
  const removedName = await displayNameOf(targetUserId);

  const event: DomainEvent = {
    type:        isSelf ? "MemberLeft" : "MemberRemoved",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { removedUserId: targetUserId, removedName, newStatus },
  };

  // ⚠️ THE AUDIT ROW STAYS OUTSIDE THE PAIR, EXACTLY AS BEFORE, and the handler
  // phase stays outside the boundary: it regenerates the Space snapshot and (for
  // a removal) notifies the removed user, neither of which belongs inside a
  // transaction that carries the acting user's identity.
  //
  // ⚠️ AND ON A SELF-LEAVE THE ACTOR IS ALREADY `LEFT` BY NOW. That is fine for
  // this write and only this write: `AuditLog.fm_app_ins` is WITH CHECK (true)
  // (§18 — 90 independent writers, no spaceId parameter in the shared shape
  // helper), so the row lands even though its Space is no longer visible to its
  // author. Nothing else here writes after the flip.
  await withTenantDb(user.id, (tx) => emitDomainEvent(tx, event));
  await dispatchDomainEvent(event);

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/members/[userId]");
