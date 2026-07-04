/**
 * PATCH  /api/spaces/[id]/invites/[inviteId]
 * Accept or decline an invite. Only the invited user can call this.
 * Body: { action: "accept" | "decline" }
 *
 * DELETE /api/spaces/[id]/invites/[inviteId]
 * Cancel a pending invite. Only OWNER/ADMIN of the space can call this.
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { requireUser, requireSpaceRole }      from "@/lib/session";
import { SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";
import { getClientIp }                            from "@/lib/api";
import { emitDomainEvent }                        from "@/lib/events/emit";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const { id: spaceId, inviteId } = await params;
  const [user, err] = await requireUser();
  if (err) return err;

  const invite = await db.spaceInvite.findUnique({ where: { id: inviteId } });
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
    // Use upsert to handle re-joins: if the user previously left or was removed,
    // a stale SpaceMember row (status REMOVED/LEFT) already exists with a
    // unique constraint on [spaceId, userId]. A plain create() would fail.
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
    await emitDomainEvent({
      type:        "MemberJoined",
      spaceId,
      actorUserId: user.id,
      ipAddress:   getClientIp(req),
      payload:     { userId: user.id, role: invite.role },
    });

    return NextResponse.json({ ok: true, joined: true });
  }

  if (action === "decline") {
    await db.spaceInvite.update({
      where: { id: inviteId },
      data:  { status: "DECLINED" },
    });
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
  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
  if (err) return err;

  await db.spaceInvite.deleteMany({ where: { id: inviteId, spaceId } });
  return NextResponse.json({ ok: true });
}
