/**
 * POST /api/workspaces/[id]/invite
 * Invite a user by username. Caller must be an ACTIVE OWNER or ADMIN.
 * Body: { username: string, role?: WorkspaceMemberRole }
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { requireWorkspaceRole }                   from "@/lib/session";
import { WorkspaceMemberRole, WorkspaceMemberStatus } from "@prisma/client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  // requireWorkspaceRole enforces both ACTIVE status and ADMIN min-role.
  // REMOVED or LEFT OWNER/ADMIN users cannot send invites.
  const [auth, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.ADMIN);
  if (err) return err;
  const { user } = auth;

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
  if (targetUser.id === user.id) {
    return NextResponse.json({ error: "You're already in this workspace" }, { status: 400 });
  }

  // Already an ACTIVE member? (H1 fix: REMOVED/LEFT rows don't count)
  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUser.id } },
  });
  if (existing?.status === WorkspaceMemberStatus.ACTIVE) {
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
      invitedById:   user.id,
      invitedUserId: targetUser.id,
      role:          role as never,
      status:        "PENDING",
    },
    update: {
      invitedById: user.id,
      role:        role as never,
      status:      "PENDING",
      createdAt:   new Date(),
      seenAt:      null,  // reset so the New badge and sidebar count fire again
    },
    include: {
      invitedUser: { select: { id: true, name: true, username: true } },
    },
  });

  return NextResponse.json(invite, { status: 201 });
}
