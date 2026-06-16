/**
 * app/api/accounts/[id]/restore/route.ts
 *
 * id refers to a FinancialAccount.id.
 *
 * POST — restores a soft-deleted FinancialAccount, regardless of source
 *        (Plaid or manual). Companion to the generic DELETE in
 *        app/api/accounts/[id]/route.ts. The manual-only restore at
 *        app/api/accounts/manual/[id]/restore/route.ts is unchanged and
 *        keeps serving the Archived Assets UI for manually-entered assets;
 *        this route fills the equivalent gap for everything else
 *        (Plaid-linked accounts in particular).
 *
 * Actions:
 *   1. Verify caller owns the account (ownerUserId) and it is currently
 *      soft-deleted (deletedAt set).
 *   2. Restore FinancialAccount: deletedAt → null.
 *   3. Restore AccountConnection rows: deletedAt → null.
 *   4. Reactivate WorkspaceAccountShare rows: status → ACTIVE, revokedAt →
 *      null, revokedByUserId → null.
 *   5. Audit log.
 *
 * Does NOT re-establish a revoked PlaidItem at the provider — if the
 * PlaidItem itself was revoked (status REVOKED, itemRemove() already called),
 * the underlying Plaid credential is gone and the user must relink via Plaid
 * Link. app/api/plaid/exchange-token/route.ts now clears FinancialAccount/
 * AccountConnection deletedAt automatically when relinking the same
 * plaidAccountId, so that path and this route both lead to the same restored
 * state — this route just covers the case where only the account-level
 * removal happened and the user wants it back without relinking.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing account id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  try {
    const fa = await db.financialAccount.findUnique({
      where:  { id },
      select: { id: true, name: true, type: true, ownerUserId: true, deletedAt: true },
    });

    if (!fa) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    if (!fa.deletedAt) {
      return NextResponse.json({ error: "Account is not deleted." }, { status: 400 });
    }
    // Verify ownership: caller must own this account (same check PATCH uses)
    if (fa.ownerUserId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Restore in parallel ─────────────────────────────────────────────────
    await Promise.all([
      // 1. Restore FinancialAccount
      db.financialAccount.update({
        where: { id },
        data:  { deletedAt: null },
      }),
      // 2. Restore AccountConnection rows
      db.accountConnection.updateMany({
        where: { financialAccountId: id, deletedAt: { not: null } },
        data:  { deletedAt: null },
      }),
      // 3. Reactivate WorkspaceAccountShare rows that were revoked
      db.workspaceAccountShare.updateMany({
        where: { financialAccountId: id, status: ShareStatus.REVOKED },
        data:  { status: ShareStatus.ACTIVE, revokedAt: null, revokedByUserId: null },
      }),
    ]);

    // ── Audit log ────────────────────────────────────────────────────────────
    await db.auditLog.create({
      data: {
        userId:    user.id,
        action:    AuditAction.ACCOUNT_RESTORE,
        metadata:  { accountId: id, name: fa.name, accountType: fa.type },
        ipAddress: getClientIp(req),
      },
    });

    return NextResponse.json({ ok: true, accountId: id });
  } catch (err) {
    console.error("[POST /api/accounts/:id/restore]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}, "POST /api/accounts/[id]/restore");
