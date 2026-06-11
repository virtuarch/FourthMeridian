/**
 * PATCH  /api/workspaces/[id]/invites/[inviteId]
 * Accept or decline an invite. Only the invited user can call this.
 * Body: { action: "accept" | "decline" }
 *
 * DELETE /api/workspaces/[id]/invites/[inviteId]
 * Cancel a pending invite. Only OWNER/ADMIN of the workspace can call this.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const { id: workspaceId, inviteId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invite = await db.workspaceInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  if (invite.invitedUserId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (invite.status !== "PENDING") {
    return NextResponse.json({ error: "Invite is no longer pending" }, { status: 409 });
  }

  const { action } = (await req.json()) as { action: "accept" | "decline" };

  if (action === "accept") {
    await db.$transaction([
      db.workspaceMember.create({
        data: { workspaceId, userId: session.user.id, role: invite.role },
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
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
  });
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.workspaceInvite.deleteMany({ where: { id: inviteId, workspaceId } });
  return NextResponse.json({ ok: true });
}
