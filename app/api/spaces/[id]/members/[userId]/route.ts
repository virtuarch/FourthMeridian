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
import { SpaceMemberStatus, ShareStatus, SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole }                   from "@/lib/session";
import { withApiHandler, getClientIp }            from "@/lib/api";
import { regenerateSpaceSnapshot }                from "@/lib/snapshots/regenerate";

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

  await db.auditLog.create({
    data: {
      userId:      user.id,
      spaceId,
      action:      "MEMBER_ROLE_CHANGE",
      metadata:    { targetUserId, targetName, oldRole: targetMembership.role, newRole: role },
      ipAddress:   getClientIp(req),
    },
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

  // ── 2a. Regenerate SpaceSnapshot now that this space's active shares have
  //       changed (the departing/removed member's shares were just revoked
  //       above) — see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md and
  //       the share/revoke route fix for the established pattern.
  //       Best-effort/non-fatal: the removal itself has already succeeded.
  try {
    await regenerateSpaceSnapshot(spaceId);
  } catch (snapshotErr) {
    console.warn(`[DELETE /api/spaces/:id/members/:userId] snapshot regen failed for space ${spaceId} (non-fatal):`, snapshotErr);
  }

  // ── 3. Audit log ──────────────────────────────────────────────────────────
  const ru = targetMembership.user;
  const removedName = [ru.firstName, ru.lastName].filter(Boolean).join(" ").trim() || ru.email || targetUserId;

  await db.auditLog.create({
    data: {
      userId:    user.id,
      spaceId,
      action:    isSelf ? "SPACE_LEAVE" : "SPACE_REMOVE_MEMBER",
      metadata:  { removedUserId: targetUserId, removedName, newStatus },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/members/[userId]");
