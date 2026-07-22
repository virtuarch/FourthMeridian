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
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { SpaceMemberStatus, ShareStatus, SpaceMemberRole, SpaceType } from "@prisma/client";
import { requireSpaceRole }                   from "@/lib/session";
import { withApiHandler, getClientIp }            from "@/lib/api";
import { emitDomainEvent }                        from "@/lib/events/emit";
import type { DomainEvent }                       from "@/lib/events/types";

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
  const pspace = await db.space.findUnique({ where: { id: spaceId }, select: { type: true } });
  if (pspace?.type === SpaceType.PERSONAL) {
    return NextResponse.json({ error: "Personal Spaces have no additional members to manage." }, { status: 400 });
  }

  const targetMembership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: targetUserId } },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });

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

  const updated = await db.spaceMember.update({
    where: { spaceId_userId: { spaceId, userId: targetUserId } },
    data: { role: role as SpaceMemberRole },
  });

  const tu = targetMembership.user;
  const targetName = [tu.firstName, tu.lastName].filter(Boolean).join(" ").trim() || tu.email || targetUserId;

  // EV-1 Slice 5B — MemberRoleChanged (audit-only, no handler). No transaction
  // and no side effect here today; the no-tx emit persists the canonical
  // MEMBER_ROLE_CHANGED row with byte-identical metadata.
  await emitDomainEvent({
    type:        "MemberRoleChanged",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { targetUserId, targetName, oldRole: targetMembership.role, newRole: role },
  });

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

  const targetMembership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: targetUserId } },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });

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
  await db.$transaction([
    // 1. Soft-update SpaceMember
    db.spaceMember.update({
      where: { spaceId_userId: { spaceId, userId: targetUserId } },
      data: {
        status:      newStatus,
        revokedAt:   now,
        revokedById: isSelf ? null : user.id,
      },
    }),
    // 2. D3 Stage B4 — Revoke all active SpaceAccountLink rows the member added
    db.spaceAccountLink.updateMany({
      where: {
        spaceId,
        addedByUserId: targetUserId,
        status:        ShareStatus.ACTIVE,
      },
      data: {
        status:          ShareStatus.REVOKED,
        revokedAt:       now,
        revokedByUserId: isSelf ? targetUserId : user.id,
      },
    }),
  ]);

  // ── 2a/3. EV-1 Slice 3 — persist the audit row and regenerate the snapshot
  //   behind the event seam. The array-form transaction above (member flip +
  //   SAL revoke) is untouched and already committed; audit stays OUTSIDE it,
  //   exactly as before. The no-tx emit persists the AuditLog row and then
  //   dispatches the snapshot handler inline (post-commit, best-effort — a
  //   handler failure is warned and swallowed, so the removal still succeeds).
  //   Self-leave → MemberLeft (SPACE_LEAVE); admin removal → MemberRemoved
  //   (MEMBER_REMOVED). Timeline renders both exactly as before.
  const ru = targetMembership.user;
  const removedName = [ru.firstName, ru.lastName].filter(Boolean).join(" ").trim() || ru.email || targetUserId;

  const event: DomainEvent = {
    type:        isSelf ? "MemberLeft" : "MemberRemoved",
    spaceId,
    actorUserId: user.id,
    ipAddress:   getClientIp(req),
    payload:     { removedUserId: targetUserId, removedName, newStatus },
  };

  await emitDomainEvent(event);

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/members/[userId]");
