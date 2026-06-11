/**
 * POST /api/workspaces/[id]/invite
 * Invite a user by username. Caller must be OWNER or ADMIN.
 * Body: { username: string, role?: WorkspaceMemberRole }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Caller must be OWNER or ADMIN
  const callerMembership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
  });
  if (!callerMembership || !["OWNER", "ADMIN"].includes(callerMembership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { username, role = "MEMBER" } = body as { username: string; role?: string };

  if (!username?.trim()) {
    return NextResponse.json({ error: "Username is required" }, { status: 400 });
  }

  // Look up target user by username
  const targetUser = await db.user.findUnique({
    where:  { username: username.trim().replace(/^@/, "") },
    select: { id: true, name: true, username: true },
  });
  if (!targetUser) {
    return NextResponse.json({ error: "No user found with that username" }, { status: 404 });
  }

  // Can't invite yourself
  if (targetUser.id === session.user.id) {
    return NextResponse.json({ error: "You're already in this workspace" }, { status: 400 });
  }

  // Already a member?
  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUser.id } },
  });
  if (existing) {
    return NextResponse.json({ error: "User is already a member" }, { status: 409 });
  }

  // Already has a pending invite?
  const existingInvite = await db.workspaceInvite.findUnique({
    where: { workspaceId_invitedUserId: { workspaceId, invitedUserId: targetUser.id } },
  });
  if (existingInvite?.status === "PENDING") {
    return NextResponse.json({ error: "An invite is already pending for this user" }, { status: 409 });
  }

  // Upsert invite (re-invite if previously declined/rescinded)
  const invite = await db.workspaceInvite.upsert({
    where: { workspaceId_invitedUserId: { workspaceId, invitedUserId: targetUser.id } },
    create: {
      workspaceId,
      invitedById:   session.user.id,
      invitedUserId: targetUser.id,
      role:          role as never,
      status:        "PENDING",
    },
    update: {
      invitedById: session.user.id,
      role:        role as never,
      status:      "PENDING",
      createdAt:   new Date(),
    },
    include: {
      invitedUser: { select: { id: true, name: true, username: true } },
    },
  });

  return NextResponse.json(invite, { status: 201 });
}
