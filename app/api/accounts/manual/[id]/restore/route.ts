/**
 * POST /api/accounts/manual/[id]/restore
 *
 * Restores a soft-deleted manually-entered asset account.
 *
 * Actions:
 *   1. Verify caller owns the account and it is currently soft-deleted
 *   2. Verify type === 'other' && syncStatus === 'manual'
 *   3. Restore FinancialAccount: deletedAt → null
 *   4. Restore AccountConnection rows: deletedAt → null
 *   5. Reactivate all WorkspaceAccountShare rows: status → ACTIVE, revokedAt → null
 *   6. Audit log
 *
 * Returns: { ok: true, accountId }
 */

import { NextRequest, NextResponse }   from "next/server";
import { db }                          from "@/lib/db";
import { requireUser }                 from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";

export const POST = withApiHandler(async (
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

  if (!fa) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!fa.deletedAt) {
    return NextResponse.json({ error: "Account is not archived." }, { status: 400 });
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (fa.type !== "other" || fa.syncStatus !== "manual") {
    return NextResponse.json({ error: "Only manually-entered asset accounts can be restored." }, { status: 400 });
  }

  // ── Restore in parallel ───────────────────────────────────────────────────
  await Promise.all([
    // 1. Restore FinancialAccount
    db.financialAccount.update({
      where: { id },
      data:  { deletedAt: null },
    }),
    // 2. Restore AccountConnection rows
    db.accountConnection.updateMany({
      where: { financialAccountId: id },
      data:  { deletedAt: null },
    }),
    // 3. Reactivate all WorkspaceAccountShare rows that were revoked
    db.workspaceAccountShare.updateMany({
      where: { financialAccountId: id, status: "REVOKED" },
      data:  {
        status:          "ACTIVE",
        revokedAt:       null,
        revokedByUserId: null,
      },
    }),
  ]);

  // ── Audit log ──────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_RESTORE",
      metadata:  { accountId: id, name: fa.name },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, accountId: id });
}, "POST /api/accounts/manual/[id]/restore");
