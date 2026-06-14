/**
 * DELETE /api/accounts/manual/[id]/permanent
 *
 * Permanently and irreversibly hard-deletes a soft-deleted manually-entered
 * asset account and all its associated rows.
 *
 * Only allowed on accounts that are already soft-deleted (deletedAt != null).
 * Plaid-synced accounts are explicitly rejected.
 *
 * Deletion order (FK-safe):
 *   1. WorkspaceAccountShare rows
 *   2. AccountConnection rows
 *   3. FinancialAccount
 *
 * Returns: { ok: true, accountId }
 */

import { NextRequest, NextResponse }   from "next/server";
import { db }                          from "@/lib/db";
import { requireUser }                 from "@/lib/session";
import { withApiHandler, getClientIp } from "@/lib/api";

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
    select: { id: true, ownerUserId: true, type: true, syncStatus: true, deletedAt: true, name: true },
  });

  if (!fa) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!fa.deletedAt) {
    return NextResponse.json(
      { error: "Account must be archived before it can be permanently deleted." },
      { status: 400 }
    );
  }
  if (fa.ownerUserId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (fa.type !== "other" || fa.syncStatus !== "manual") {
    return NextResponse.json(
      { error: "Only manually-entered asset accounts can be permanently deleted." },
      { status: 400 }
    );
  }

  // ── Audit log BEFORE deletion (so we still have the name) ─────────────────
  await db.auditLog.create({
    data: {
      userId,
      action:    "MANUAL_ASSET_PERMANENT_DELETE",
      metadata:  { accountId: id, name: fa.name },
      ipAddress: getClientIp(req),
    },
  });

  // ── Hard delete in FK-safe order ──────────────────────────────────────────
  await db.workspaceAccountShare.deleteMany({ where: { financialAccountId: id } });
  await db.accountConnection.deleteMany({ where: { financialAccountId: id } });
  await db.financialAccount.delete({ where: { id } });

  return NextResponse.json({ ok: true, accountId: id });
}, "DELETE /api/accounts/manual/[id]/permanent");
