/**
 * DELETE /api/workspaces/[id]/members/[userId]
 * Remove a member. OWNER/ADMIN can remove anyone except the OWNER.
 * A user can remove themselves (leave workspace).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: workspaceId, userId: targetUserId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const callerMembership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
  });
  const targetMembership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  });

  if (!targetMembership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const isSelf    = session.user.id === targetUserId;
  const isPriv    = callerMembership && ["OWNER", "ADMIN"].includes(callerMembership.role);

  // Can't remove the OWNER (transfer ownership first)
  if (targetMembership.role === "OWNER" && !isSelf) {
    return NextResponse.json({ error: "Cannot remove the workspace owner" }, { status: 403 });
  }

  // Must be self or an admin/owner
  if (!isSelf && !isPriv) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.workspaceMember.delete({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      workspaceId,
      action: isSelf ? "WORKSPACE_LEAVE" : "WORKSPACE_REMOVE_MEMBER",
      metadata: { removedUserId: targetUserId },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    },
  });

  return NextResponse.json({ ok: true });
}
