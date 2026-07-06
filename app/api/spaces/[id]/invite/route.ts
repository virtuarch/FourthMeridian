/**
 * POST /api/spaces/[id]/invite
 * Invite a user by username. Caller must be an ACTIVE OWNER or ADMIN.
 * Body: { username: string, role?: SpaceMemberRole }
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { env }                                    from "@/lib/env";
import { requireSpaceRole }                   from "@/lib/session";
import { SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";
import { getClientIp }                            from "@/lib/api";
import { emitDomainEvent }                        from "@/lib/events/emit";
import { sendEmail }                              from "@/lib/email/send";
import { buildInviteUrl }                         from "@/lib/email/invite-url";

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
    select: { id: true, name: true, username: true, email: true },
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
      space:       { select: { name: true } },
    },
  });

  // ── Invitation notification email (OPS-1 S3) ──────────────────────────────
  // Notify the (existing-account) invitee. NON-THROWING: a delivery failure is
  // logged and recorded in the event, but never fails invite creation. The
  // email carries NO token — acceptance stays identity-gated in-app; the CTA is
  // a trusted-base pointer to /dashboard/spaces (built from env, not the Host).
  const inviterName = user.username ? `@${user.username}` : "A Fourth Meridian member";
  const spaceName   = invite.space?.name ?? "a Space";
  const emailResult = await sendEmail("space-invite", targetUser.email, {
    spaceName,
    inviterName,
    role,
    inviteUrl: buildInviteUrl(env.NEXT_PUBLIC_APP_URL),
  });
  if (emailResult.status === "error") {
    console.error("[spaces/invite] invitation email failed to send:", emailResult.error);
  }

  // Timeline T-1 — MemberInvited (audit-only, no handler). Net-new
  // Timeline-visible row. `invitedEmail` carries a safe display handle
  // (name or @username), never a real email, because the activity consumer
  // currently reads meta.invitedEmail (key rename is deferred debt).
  // `emailStatus` (S3) records the notification outcome on this same event.
  await emitDomainEvent({
    type:        "MemberInvited",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload: {
      invitedUserId: targetUser.id,
      role,
      invitedEmail:  targetUser.name ?? `@${targetUser.username}`,
      emailStatus:   emailResult.status,
    },
  });

  return NextResponse.json(invite, { status: 201 });
}
