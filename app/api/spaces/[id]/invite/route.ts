/**
 * POST /api/spaces/[id]/invite
 * Invite a user by username. Caller must be an ACTIVE OWNER or ADMIN.
 * Body: { username: string, role?: SpaceMemberRole }
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { requireSpaceRole }                   from "@/lib/session";
import { SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";
import { getClientIp }                            from "@/lib/api";
import { emitDomainEvent }                        from "@/lib/events/emit";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces both ACTIVE status and ADMIN min-role.
  // REMOVED or LEFT OWNER/ADMIN users cannot send invites.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
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
    return NextResponse.json({ error: "You're already in this Space" }, { status: 400 });
  }

  // Already an ACTIVE member? (H1 fix: REMOVED/LEFT rows don't count)
  const existing = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: targetUser.id } },
  });
  if (existing?.status === SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "User is already a member" }, { status: 409 });
  }

  // Already has a pending invite?
  const existingInvite = await db.spaceInvite.findUnique({
    where: { spaceId_invitedUserId: { spaceId, invitedUserId: targetUser.id } },
  });
  if (existingInvite?.status === "PENDING") {
    return NextResponse.json({ error: "An invite is already pending for this user" }, { status: 409 });
  }

  // Upsert invite (re-invite if previously declined/rescinded)
  const invite = await db.spaceInvite.upsert({
    where: { spaceId_invitedUserId: { spaceId, invitedUserId: targetUser.id } },
    create: {
      spaceId,
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

  // Timeline T-1 — MemberInvited (audit-only, no handler). Net-new
  // Timeline-visible row. `invitedEmail` carries a safe display handle
  // (name or @username), never a real email, because the activity consumer
  // currently reads meta.invitedEmail (key rename is deferred debt).
  await emitDomainEvent({
    type:        "MemberInvited",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload: {
      invitedUserId: targetUser.id,
      role,
      invitedEmail:  targetUser.name ?? `@${targetUser.username}`,
    },
  });

  return NextResponse.json(invite, { status: 201 });
}
