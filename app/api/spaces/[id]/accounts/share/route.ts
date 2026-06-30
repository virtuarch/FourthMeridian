/**
 * POST   /api/spaces/[id]/accounts/share
 *   Share a FinancialAccount into this space.
 *   Body: { financialAccountId: string, visibilityLevel: "BALANCE_ONLY" | "FULL" }
 *
 * DELETE /api/spaces/[id]/accounts/share
 *   Revoke an active share.
 *   Body: { financialAccountId: string }
 *
 * Security:
 *  - Caller must be an ACTIVE member of the space.
 *  - The FinancialAccount must be owned by the caller (ownerUserId).
 *  - Only the user who added the share (addedByUserId) can revoke it, or an OWNER/ADMIN.
 */

import { NextRequest, NextResponse }                    from "next/server";
import { db }                                           from "@/lib/db";
import { ShareStatus, VisibilityLevel, SpaceMemberStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";
import { dualWriteSpaceAccountLink } from "@/lib/accounts/space-account-link";
import { regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";

// ─── POST ─────────────────────────────────────────────────────────────────────

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: spaceId } = await params;
  const userId = user.id;

  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
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
      // WorkspaceAccountShare keeps its own pre-Phase-1 field/key names.
      workspaceId_financialAccountId: { workspaceId: spaceId, financialAccountId },
    },
    create: {
      workspaceId: spaceId,
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

  // ── D3 Step 3 — mirror onto SpaceAccountLink (best-effort, non-fatal).
  // No creatorUserId passed: fa here is selected without createdByUserId, so
  // dualWriteSpaceAccountLink resolves the creator itself.
  await dualWriteSpaceAccountLink({
    spaceId,
    financialAccountId,
    create: {
      addedByUserId:   userId,
      visibilityLevel: visibilityLevel as VisibilityLevel,
      status:          ShareStatus.ACTIVE,
    },
    update: {
      addedByUserId:   userId,
      visibilityLevel: visibilityLevel as VisibilityLevel,
      status:          ShareStatus.ACTIVE,
      revokedAt:       null,
      revokedByUserId: null,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      spaceId,
      action:    "ACCOUNT_SHARE",
      metadata:  { financialAccountId, accountName: fa.name, visibilityLevel },
      ipAddress: getClientIp(req),
    },
  });

  // Regenerate SpaceSnapshot now that this space has a new active share —
  // see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md for the established
  // pattern. Best-effort/non-fatal: the share itself has already succeeded.
  try {
    await regenerateSpaceSnapshot(spaceId);
  } catch (snapshotErr) {
    console.warn(`[POST /api/spaces/:id/accounts/share] snapshot regen failed for space ${spaceId} (non-fatal):`, snapshotErr);
  }

  return NextResponse.json(share, { status: 201 });
}, "POST /api/spaces/[id]/accounts/share");

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: spaceId } = await params;
  const userId = user.id;

  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== SpaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { financialAccountId: string };
  const { financialAccountId } = body;

  if (!financialAccountId) {
    return NextResponse.json({ error: "financialAccountId is required" }, { status: 400 });
  }

  // D3 Stage B1 — authorization and revoke write migrated from
  // WorkspaceAccountShare to SpaceAccountLink. SpaceAccountLink is kept
  // fully in sync with WorkspaceAccountShare by the D3 Step 3 dual-write
  // (lib/accounts/space-account-link.ts), so status, addedByUserId, and
  // visibilityLevel read here reflect the same values the previous
  // workspaceAccountShare.findUnique returned. The POST handler above still
  // writes WorkspaceAccountShare (not retired yet — see
  // docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md §7 Stage B sequence).
  const link = await db.spaceAccountLink.findUnique({
    where: { spaceId_financialAccountId: { spaceId, financialAccountId } },
    select: {
      status:          true,
      addedByUserId:   true,
      visibilityLevel: true,
      financialAccount: { select: { name: true } },
    },
  });

  if (!link || link.status !== ShareStatus.ACTIVE) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  const isPrivileged = ["OWNER", "ADMIN"].includes(membership.role);
  if (link.addedByUserId !== userId && !isPrivileged) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const revokedAt = new Date();

  await db.spaceAccountLink.update({
    where: { spaceId_financialAccountId: { spaceId, financialAccountId } },
    data: {
      status:          ShareStatus.REVOKED,
      revokedAt,
      revokedByUserId: userId,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      spaceId,
      action:    "ACCOUNT_SHARE_REVOKE",
      metadata:  { financialAccountId, accountName: link.financialAccount?.name ?? null },
      ipAddress: getClientIp(req),
    },
  });

  // Regenerate SpaceSnapshot now that this space lost an active share —
  // see docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md for the established
  // pattern. Best-effort/non-fatal: the revoke itself has already succeeded.
  try {
    await regenerateSpaceSnapshot(spaceId);
  } catch (snapshotErr) {
    console.warn(`[DELETE /api/spaces/:id/accounts/share] snapshot regen failed for space ${spaceId} (non-fatal):`, snapshotErr);
  }

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/accounts/share");
