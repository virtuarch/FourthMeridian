/**
 * PATCH  /api/workspaces/[id]/members/[userId]  — change a member's role
 * DELETE /api/workspaces/[id]/members/[userId]  — remove a member
 *
 * PATCH rules:
 *   - Only the active OWNER can change roles
 *   - Cannot demote the OWNER (transfer ownership is a separate flow)
 *   - Cannot promote anyone to OWNER via this endpoint
 *   - Valid target roles: ADMIN, MEMBER, VIEWER
 *
 * DELETE rules:
 *   - Active OWNER/ADMIN can remove anyone except the OWNER (transfer ownership first)
 *   - An active member can remove themselves (leave the workspace)
 *
 * Soft-removal model (no row delete):
 *   1. WorkspaceMember.status → REMOVED (kicked) or LEFT (self)
 *   2. WorkspaceMember.revokedAt / revokedById populated
 *   3. WorkspaceAccountShare rows added by that user in this workspace → REVOKED
 *
 * The member row and their share records are preserved for audit history.
 */

import { NextRequest, NextResponse }              from "next/server";
import { db }                                     from "@/lib/db";
import { WorkspaceMemberStatus, ShareStatus, WorkspaceMemberRole } from "@prisma/client";
import { requireWorkspaceRole }                   from "@/lib/session";
import { withApiHandler, getClientIp }            from "@/lib/api";

const PROMOTABLE_ROLES: WorkspaceMemberRole[] = [
  WorkspaceMemberRole.ADMIN,
  WorkspaceMemberRole.MEMBER,
  WorkspaceMemberRole.VIEWER,
];

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) => {
  const { id: workspaceId, userId: targetUserId } = await params;

  // requireWorkspaceRole enforces ACTIVE status + OWNER role —
  // a REMOVED or LEFT owner cannot change member roles.
  const [auth, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const targetMembership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });

  if (!targetMembership || targetMembership.status !== WorkspaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (targetMembership.role === WorkspaceMemberRole.OWNER) {
    return NextResponse.json(
      { error: "Cannot change the owner's role. Transfer ownership first." },
      { status: 400 }
    );
  }

  const { role } = (await req.json()) as { role?: string };

  if (!role || !PROMOTABLE_ROLES.includes(role as WorkspaceMemberRole)) {
    return NextResponse.json(
      { error: `Invalid role. Must be one of: ${PROMOTABLE_ROLES.join(", ")}` },
      { status: 400 }
    );
  }

  const updated = await db.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: { role: role as WorkspaceMemberRole },
  });

  const tu = targetMembership.user;
  const targetName = [tu.firstName, tu.lastName].filter(Boolean).join(" ").trim() || tu.email || targetUserId;

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId,
      action:      "MEMBER_ROLE_CHANGE",
      metadata:    { targetUserId, targetName, oldRole: targetMembership.role, newRole: role },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(updated);
}, "PATCH /api/workspaces/[id]/members/[userId]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) => {
  const { id: workspaceId, userId: targetUserId } = await params;

  // requireWorkspaceRole(VIEWER) gates on ACTIVE status — REMOVED/LEFT members
  // cannot call this endpoint, not even for self-removal (they're already gone).
  // Role-specific checks (self vs. privileged) happen after.
  const [auth, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.VIEWER);
  if (err) return err;
  const { user, membership: callerMembership } = auth;

  const targetMembership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });

  if (!targetMembership || targetMembership.status !== WorkspaceMemberStatus.ACTIVE) {
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
  const newStatus = isSelf ? WorkspaceMemberStatus.LEFT : WorkspaceMemberStatus.REMOVED;

  // ── 1. Soft-update WorkspaceMember ────────────────────────────────────────
  await db.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: {
      status:      newStatus,
      revokedAt:   now,
      revokedById: isSelf ? null : user.id,
    },
  });

  // ── 2. Revoke all active WorkspaceAccountShare rows the member added ───────
  await db.workspaceAccountShare.updateMany({
    where: {
      workspaceId,
      addedByUserId: targetUserId,
      status:        ShareStatus.ACTIVE,
    },
    data: {
      status:          ShareStatus.REVOKED,
      revokedAt:       now,
      revokedByUserId: isSelf ? targetUserId : user.id,
    },
  });

  // ── 3. Audit log ──────────────────────────────────────────────────────────
  const ru = targetMembership.user;
  const removedName = [ru.firstName, ru.lastName].filter(Boolean).join(" ").trim() || ru.email || targetUserId;

  await db.auditLog.create({
    data: {
      userId:    user.id,
      workspaceId,
      action:    isSelf ? "WORKSPACE_LEAVE" : "WORKSPACE_REMOVE_MEMBER",
      metadata:  { removedUserId: targetUserId, removedName, newStatus },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/workspaces/[id]/members/[userId]");
