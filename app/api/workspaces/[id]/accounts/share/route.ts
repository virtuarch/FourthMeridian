/**
 * POST   /api/workspaces/[id]/accounts/share
 *   Share a FinancialAccount into this workspace.
 *   Body: { financialAccountId: string, visibilityLevel: "BALANCE_ONLY" | "FULL" }
 *
 * DELETE /api/workspaces/[id]/accounts/share
 *   Revoke an active share.
 *   Body: { financialAccountId: string }
 *
 * Security:
 *  - Caller must be an ACTIVE member of the workspace.
 *  - The FinancialAccount must be owned by the caller (ownerUserId).
 *  - Only the user who added the share (addedByUserId) can revoke it, or an OWNER/ADMIN.
 */

import { NextRequest, NextResponse }                    from "next/server";
import { db }                                           from "@/lib/db";
import { ShareStatus, VisibilityLevel, WorkspaceMemberStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";

// ─── POST ─────────────────────────────────────────────────────────────────────

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: workspaceId } = await params;
  const userId = user.id;

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== WorkspaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as {
    financialAccountId: string;
    visibilityLevel?:   string;
  };

  const { financialAccountId, visibilityLevel = "FULL" } = body;

  if (!financialAccountId) {
    return NextResponse.json({ error: "financialAccountId is required" }, { status: 400 });
  }

  // Validate visibility level
  const allowedLevels: string[] = [VisibilityLevel.BALANCE_ONLY, VisibilityLevel.FULL];
  if (!allowedLevels.includes(visibilityLevel)) {
    return NextResponse.json({ error: "Invalid visibilityLevel" }, { status: 400 });
  }

  // Verify the caller owns this FinancialAccount
  const fa = await db.financialAccount.findUnique({
    where: { id: financialAccountId },
    select: { ownerUserId: true, deletedAt: true, name: true },
  });

  if (!fa || fa.deletedAt) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "You do not own this account" }, { status: 403 });
  }

  // Upsert the share — if one exists (even REVOKED), re-activate it
  const share = await db.workspaceAccountShare.upsert({
    where: {
      workspaceId_financialAccountId: { workspaceId, financialAccountId },
    },
    create: {
      workspaceId,
      financialAccountId,
      addedByUserId:   userId,
      visibilityLevel: visibilityLevel as VisibilityLevel,
      status:          ShareStatus.ACTIVE,
    },
    update: {
      status:          ShareStatus.ACTIVE,
      visibilityLevel: visibilityLevel as VisibilityLevel,
      addedByUserId:   userId,
      revokedAt:       null,
      revokedByUserId: null,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      workspaceId,
      action:    "ACCOUNT_SHARE",
      metadata:  { financialAccountId, accountName: fa.name, visibilityLevel },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json(share, { status: 201 });
}, "POST /api/workspaces/[id]/accounts/share");

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: workspaceId } = await params;
  const userId = user.id;

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== WorkspaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { financialAccountId: string };
  const { financialAccountId } = body;

  if (!financialAccountId) {
    return NextResponse.json({ error: "financialAccountId is required" }, { status: 400 });
  }

  const share = await db.workspaceAccountShare.findUnique({
    where: { workspaceId_financialAccountId: { workspaceId, financialAccountId } },
    select: {
      id:           true,
      status:       true,
      addedByUserId: true,
      financialAccount: { select: { name: true } },
    },
  });

  if (!share || share.status !== ShareStatus.ACTIVE) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  const isPrivileged = ["OWNER", "ADMIN"].includes(membership.role);
  if (share.addedByUserId !== userId && !isPrivileged) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.workspaceAccountShare.update({
    where: { id: share.id },
    data: {
      status:          ShareStatus.REVOKED,
      revokedAt:       new Date(),
      revokedByUserId: userId,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      workspaceId,
      action:    "ACCOUNT_SHARE_REVOKE",
      metadata:  { financialAccountId, accountName: share.financialAccount?.name ?? null },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/workspaces/[id]/accounts/share");
