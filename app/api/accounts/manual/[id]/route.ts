/**
 * PATCH /api/accounts/manual/[id]
 *
 * Updates the balance of a manually-entered asset account (syncStatus='manual').
 * Plaid-synced accounts are explicitly rejected — they update via the sync job.
 *
 * Body: { balance: number }
 *
 * Returns: { accountId, balance, lastUpdated }
 */

import { NextRequest, NextResponse }   from "next/server";
import { db }                          from "@/lib/db";
import { requireUser }                 from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";
import { ShareStatus }                 from "@prisma/client";
import { dualWriteFromShares }         from "@/lib/accounts/space-account-link";

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const body = await req.json() as { balance?: number };
  const { balance } = body;

  if (balance === undefined || balance === null)
    return NextResponse.json({ error: "balance is required" }, { status: 400 });
  if (typeof balance !== "number" || isNaN(balance) || balance < 0)
    return NextResponse.json({ error: "balance must be a non-negative number" }, { status: 400 });

  // ── Fetch + validate the account ──────────────────────────────────────────
  const fa = await db.financialAccount.findUnique({
    where: { id },
    select: { id: true, ownerUserId: true, syncStatus: true, deletedAt: true },
  });

  if (!fa || fa.deletedAt) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (fa.syncStatus !== "manual") {
    return NextResponse.json(
      { error: "Only manually-entered accounts can have their balance updated this way." },
      { status: 400 }
    );
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  const updated = await db.financialAccount.update({
    where: { id },
    data:  { balance, lastUpdated: new Date() },
    select: { id: true, balance: true, lastUpdated: true },
  });

  await db.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_UPDATE",
      metadata:  { accountId: id, balance },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({
    accountId:   updated.id,
    balance:     updated.balance,
    lastUpdated: updated.lastUpdated,
  });
}, "PATCH /api/accounts/manual/[id]");

// ─── DELETE ───────────────────────────────────────────────────────────────────

/**
 * DELETE /api/accounts/manual/[id]
 *
 * Soft-deletes a manually-entered asset account (syncStatus='manual', type='other').
 * Plaid-synced accounts are explicitly rejected.
 *
 * Actions (in order):
 *   1. Verify caller owns the account
 *   2. Verify type === 'other' && syncStatus === 'manual'
 *   3. Revoke all WorkspaceAccountShare rows (status → REVOKED)
 *   4. Soft-delete all AccountConnection rows (deletedAt = now)
 *   5. Soft-delete the FinancialAccount (deletedAt = now)
 *   6. Audit log
 *
 * Returns: { ok: true, accountId }
 */
export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  // ── Fetch + validate ──────────────────────────────────────────────────────
  const fa = await db.financialAccount.findUnique({
    where:  { id },
    select: { id: true, name: true, ownerUserId: true, type: true, syncStatus: true, deletedAt: true },
  });

  if (!fa || fa.deletedAt) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (fa.type !== "other") {
    return NextResponse.json(
      { error: "Only asset accounts (type=other) can be deleted this way." },
      { status: 400 }
    );
  }
  if (fa.syncStatus !== "manual") {
    return NextResponse.json(
      { error: "Only manually-entered accounts can be deleted this way." },
      { status: 400 }
    );
  }

  const now = new Date();

  // Captured before the revoke below so the D3 Step 3 dual-write has the
  // pre-revocation rows to mirror (the updateMany itself returns only a count).
  const sharesBeforeRevoke = await db.workspaceAccountShare.findMany({ where: { financialAccountId: id } });

  // ── 1. Revoke WorkspaceAccountShare rows ─────────────────────────────────
  await db.workspaceAccountShare.updateMany({
    where: { financialAccountId: id },
    data:  {
      status:          "REVOKED",
      revokedAt:       now,
      revokedByUserId: userId,
    },
  });

  // ── 1a. D3 Step 3 — mirror the revocation onto SpaceAccountLink
  //       (best-effort/non-fatal, handled inside dualWriteFromShares).
  await dualWriteFromShares(
    sharesBeforeRevoke.map((s) => ({
      workspaceId:        s.workspaceId,
      financialAccountId: s.financialAccountId,
      addedByUserId:      s.addedByUserId,
      visibilityLevel:    s.visibilityLevel,
      status:             ShareStatus.REVOKED,
      revokedAt:          now,
      revokedByUserId:    userId,
    })),
    fa.ownerUserId
  );

  // ── 2. Soft-delete AccountConnection rows ─────────────────────────────────
  await db.accountConnection.updateMany({
    where: { financialAccountId: id, deletedAt: null },
    data:  { deletedAt: now },
  });

  // ── 3. Soft-delete the FinancialAccount ───────────────────────────────────
  await db.financialAccount.update({
    where: { id },
    data:  { deletedAt: now },
  });

  // ── 4. Audit log ──────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_DELETE",
      metadata:  { accountId: id, name: fa.name },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, accountId: id });
}, "DELETE /api/accounts/manual/[id]");
