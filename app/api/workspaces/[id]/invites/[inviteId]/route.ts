/**
 * PATCH  /api/workspaces/[id]/invites/[inviteId]
 * Accept or decline an invite. Only the invited user can call this.
 * Body: { action: "accept" | "decline" }
 *
 * DELETE /api/workspaces/[id]/invites/[inviteId]
 * Cancel a pending invite. Only OWNER/ADMIN of the workspace can call this.
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { requireUser, requireWorkspaceRole }      from "@/lib/session";
import { WorkspaceMemberRole, WorkspaceMemberStatus } from "@prisma/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const { id: workspaceId, inviteId } = await params;
  const [user, err] = await requireUser();
  if (err) return err;

  const invite = await db.workspaceInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.workspaceId !== workspaceId) {
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
    // a stale WorkspaceMember row (status REMOVED/LEFT) already exists with a
    // unique constraint on [workspaceId, userId]. A plain create() would fail.
    await db.$transaction([
      db.workspaceMember.upsert({
        where:  { workspaceId_userId: { workspaceId, userId: user.id } },
        create: { workspaceId, userId: user.id, role: invite.role as WorkspaceMemberRole },
        update: {
          role:        invite.role as WorkspaceMemberRole,
          status:      WorkspaceMemberStatus.ACTIVE,
          revokedAt:   null,
          revokedById: null,
          joinedAt:    new Date(),
        },
      }),
      db.workspaceInvite.update({
        where: { id: inviteId },
        data:  { status: "ACCEPTED" },
      }),
    ]);
    return NextResponse.json({ ok: true, joined: true });
  }

  if (action === "decline") {
    await db.workspaceInvite.update({
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
  const { id: workspaceId, inviteId } = await params;

  // requireWorkspaceRole enforces ACTIVE status — REMOVED/LEFT admins cannot cancel invites.
  const [, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.ADMIN);
  if (err) return err;

  await db.workspaceInvite.deleteMany({ where: { id: inviteId, workspaceId } });
  return NextResponse.json({ ok: true });
}
