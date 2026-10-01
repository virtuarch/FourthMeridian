/**
 * PATCH  /api/spaces/[id]/invites/[inviteId]
 * Accept or decline an invite. Only the invited user can call this.
 * Body: { action: "accept" | "decline" }
 *
 * DELETE /api/spaces/[id]/invites/[inviteId]
 * Cancel a pending invite. Only OWNER/ADMIN of the space can call this.
 *
 * ── RLS SLICE B — THE ACCEPT TRANSACTION IS THE ONE THING fm_app CANNOT DO ───
 * This route is CONVERTED IN PART. The invite read, the decline and the cancel
 * all run as the caller; the ACCEPT pair does not, and the reason is specific
 * enough to be worth stating rather than discovering.
 *
 *   ⚠️ THE TOKEN `spaceMember` + `.upsert` IS DELIBERATELY NOT SPELLED AS ONE
 *   WORD ANYWHERE IN THIS COMMENT. Two source-scan tests
 *   (lib/spaces/invite-role.test.ts, personal-single-user.test.ts) prove the
 *   PERSONAL and role guards fire BEFORE the membership write by comparing
 *   character offsets in the RAW file, so naming the write up here would put it
 *   "before" its own guard and fail a check about something else entirely.
 *
 *   The membership upsert has two arms. The INSERT arm is admissible —
 *   `SpaceMember.fm_app_ins` is `spaceId IN fm_visible_space_ids() OR
 *   "userId" = current_fm_user_id()`, and the invitee, who is NOT yet a member,
 *   is admitted by the second. The UPDATE arm — the RE-JOIN path, where a
 *   LEFT/REMOVED row already exists under the unique key — is NOT:
 *   `SpaceMember.fm_app_upd` is `spaceId IN fm_visible_space_ids()` on BOTH
 *   USING and WITH CHECK, with no `userId` arm, and a non-ACTIVE member's Space
 *   is by definition not in that set. Prisma issues the upsert as
 *   INSERT … ON CONFLICT DO UPDATE, for which Postgres evaluates the UPDATE
 *   policy's USING clause against the existing row and ERRORS when it fails.
 *   So re-joining a Space you once left would stop working — loudly, but
 *   wrongly.
 *
 *   The fix is one policy arm —
 *     ALTER POLICY fm_app_upd ON "SpaceMember" …
 *       USING ("spaceId" IN (SELECT fm_visible_space_ids())
 *              OR "userId" = current_fm_user_id())
 *   mirroring the SELECT and INSERT policies that already carry it — and that is
 *   a migration, so it is the owner's call, not a route's. Until then the accept
 *   pair stays on the deployment-wide client, atomic exactly as it was.
 *
 * ⚠️ AND THE PERSONAL GUARD WOULD HAVE FAILED SILENTLY. The `space.findUnique`
 * below is read by the INVITEE, who is not a member: as fm_app it returns null,
 * `space?.type === PERSONAL` is then false, and the guard that calls itself "the
 * last line of defense" would simply stop defending — no error, no log. A guard
 * that can only fail open must not be moved behind a policy that hides its
 * subject. It stays on `db`, named.
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { withTenantDb }                           from "@/lib/db/tenant-context";
import { requireUser, requireSpaceRole }      from "@/lib/session";
import { isInvitableSpaceRole }                   from "@/lib/spaces/invite-role";
import { SpaceMemberRole, SpaceMemberStatus, SpaceType } from "@prisma/client";
import { getClientIp }                            from "@/lib/api";
import { emitDomainEvent, dispatchDomainEvent }   from "@/lib/events/emit";
import type { DomainEvent }                       from "@/lib/events/types";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const { id: spaceId, inviteId } = await params;
  const [user, err] = await requireUser();
  if (err) return err;

  // RLS slice B — a bare-id fetch followed by an ownership check. As the tenant
  // the fetch simply returns nothing for an invite that is neither in a Space the
  // caller can see nor addressed to them (`SpaceInvite.fm_app_sel` =
  // `spaceId IN fm_visible_space_ids() OR "invitedUserId" = me`), so the row no
  // longer leaves the database before the check.
  //
  // ⚠️ THE TWO CHECKS BELOW ARE NOW REDUNDANT RATHER THAN LOAD-BEARING, AND THEY
  // STAY. The 403 in particular is not reachable for a foreign invite any more —
  // it would 404 first — but it is the application's own statement of who may act
  // on an invitation, and RLS is tenancy, not authorization. Both must hold.
  const invite = await withTenantDb(user.id, (tx) => tx.spaceInvite.findUnique({
    where: { id: inviteId },
  }));
  if (!invite || invite.spaceId !== spaceId) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  if (invite.invitedUserId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (invite.status !== "PENDING") {
    return NextResponse.json({ error: "Invite is no longer pending" }, { status: 409 });
  }

  const { action } = (await req.json()) as { action: "accept" | "decline" };

  if (action === "accept") {
    // Personal Spaces are strictly single-user — never materialize a second
    // membership, even from a pre-existing PENDING invite created before this
    // guard. This is the choke point where the SpaceMember row is actually
    // written, so it's the last line of defense behind the invite route.
    // Decline still works (below) so a stray invite can be cleared.
    // ⚠️ DELIBERATELY NOT withTenantDb — see the header. The invitee cannot see
    // this Space yet, and a null here reads as "not PERSONAL": the guard would
    // fail OPEN.
    const space = await db.space.findUnique({ where: { id: spaceId }, select: { type: true } });
    if (space?.type === SpaceType.PERSONAL) {
      return NextResponse.json({ error: "Personal Spaces can't have additional members." }, { status: 400 });
    }

    // W1-D3 — validation must hold at the point the SpaceMember row is
    // WRITTEN, not just where the invite was created: a pre-existing invite
    // row carrying OWNER (minted before the invite route validated roles)
    // must never materialize a second OWNER here. Same allowlist as the
    // invite route (ADMIN/MEMBER/VIEWER); decline still works so a bad
    // invite can be cleared.
    if (!isInvitableSpaceRole(invite.role)) {
      return NextResponse.json(
        { error: "This invite carries a role that can't be granted. Ask a Space admin to send a new invite." },
        { status: 400 }
      );
    }

    // Use upsert to handle re-joins: if the user previously left or was removed,
    // a stale SpaceMember row (status REMOVED/LEFT) already exists with a
    // unique constraint on [spaceId, userId]. A plain create() would fail.
    // ⚠️ DELIBERATELY NOT withTenantDb — see the header: the UPDATE arm
    // (re-join) has no `userId` arm in `SpaceMember.fm_app_upd`, and Postgres
    // errors on ON CONFLICT DO UPDATE when the UPDATE policy's USING clause
    // rejects the existing row. Left exactly as it was, atomic, pending the
    // policy arm named in the header.
    await db.$transaction([
      db.spaceMember.upsert({
        where:  { spaceId_userId: { spaceId, userId: user.id } },
        create: { spaceId, userId: user.id, role: invite.role as SpaceMemberRole },
        update: {
          role:        invite.role as SpaceMemberRole,
          status:      SpaceMemberStatus.ACTIVE,
          revokedAt:   null,
          revokedById: null,
          joinedAt:    new Date(),
        },
      }),
      db.spaceInvite.update({
        where: { id: inviteId },
        data:  { status: "ACCEPTED" },
      }),
    ]);

    // Timeline T-1 — MemberJoined (audit-only, no handler). Net-new
    // Timeline-visible row. Emitted post-commit (no-tx) so the array-form
    // transaction above is untouched; actorUserId is the joining user, from
    // which the activity consumer derives "{name} joined the space".
    // The joiner is now an ACTIVE member, so the audit row runs as them. The
    // handler phase stays outside: MemberJoined notifies the INVITER, and
    // `Notification.fm_app_ins` is `userId = current_fm_user_id()`.
    const event: DomainEvent = {
      type:        "MemberJoined",
      spaceId,
      actorUserId: user.id,
      ipAddress:   getClientIp(req),
      payload:     { userId: user.id, role: invite.role },
    };
    await withTenantDb(user.id, (tx) => emitDomainEvent(tx, event));
    await dispatchDomainEvent(event);

    return NextResponse.json({ ok: true, joined: true });
  }

  if (action === "decline") {
    // `SpaceInvite.fm_app_upd` carries `invitedUserId = me` on both clauses, so
    // a non-member declining their own invitation is admissible and nothing else
    // is.
    await withTenantDb(user.id, (tx) => tx.spaceInvite.update({
      where: { id: inviteId },
      data:  { status: "DECLINED" },
    }));
    return NextResponse.json({ ok: true, joined: false });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const { id: spaceId, inviteId } = await params;

  // requireSpaceRole enforces ACTIVE status — REMOVED/LEFT admins cannot cancel invites.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
  if (err) return err;

  // `SpaceInvite.fm_app_del` is `spaceId IN fm_visible_space_ids()`, which the
  // ACTIVE ADMIN guard has established.
  await withTenantDb(auth.user.id, (tx) => tx.spaceInvite.deleteMany({
    where: { id: inviteId, spaceId },
  }));
  return NextResponse.json({ ok: true });
}
