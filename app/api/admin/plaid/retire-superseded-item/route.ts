/**
 * POST /api/admin/plaid/retire-superseded-item
 *
 * Retires the old PlaidItem after a successful Expand History relink.
 *
 * Auth: SYSTEM_ADMIN only.
 *
 * Body: { oldPlaidItemId: string }
 *
 * Call this AFTER /api/plaid/exchange-token has completed for the new Item.
 * By that point:
 *   - A new PlaidItem row exists for the same (userId, institutionId) with a
 *     new externalItemId and cursor (exchange-token triggers syncTransactions).
 *   - The old PlaidItem is still ACTIVE — it must be explicitly retired here.
 *
 * Retirement sequence (mirrors what the account-delete flow does):
 *   1. Soft-delete all AccountConnection rows pointing at oldPlaidItemId.
 *   2. Call disconnectPlaidItemIfOrphaned(oldPlaidItemId) — which confirms zero
 *      remaining connections, calls Plaid /item/remove, and sets status=REVOKED.
 *
 * IMPORTANT: do not duplicate the orphan-check / itemRemove / status-update
 * logic that already lives in disconnectPlaidItemIfOrphaned. Always call that
 * function rather than inline the logic. If the Plaid API call fails inside
 * disconnectPlaidItemIfOrphaned it logs and continues; the DB status is still
 * set to REVOKED so the item stops syncing.
 *
 * Returns: { retired: true, oldPlaidItemId, newPlaidItemId }
 *
 * Idempotency note: if called twice, the second call finds status=REVOKED on the
 * old item but still returns success (the AccountConnections are already deleted).
 * disconnectPlaidItemIfOrphaned is also idempotent (if item.status is already
 * REVOKED, the Plaid itemRemove call is a no-op from Plaid's perspective).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { AuditAction } from "@/lib/audit-actions";
import { PlaidItemStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  // Capture the acting admin so the retirement is attributable. requireSystemAdmin
  // returns BEFORE any state mutation, so a rejected caller can never reach the
  // audit write below (no misleading record for a failed authorization).
  const [admin, err] = await requireSystemAdmin();
  if (err) return err;

  // ── Parse body ────────────────────────────────────────────────────────────
  let oldPlaidItemId: string;
  try {
    const body = await req.json();
    if (!body?.oldPlaidItemId || typeof body.oldPlaidItemId !== "string") {
      return NextResponse.json({ error: "oldPlaidItemId is required" }, { status: 400 });
    }
    oldPlaidItemId = body.oldPlaidItemId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Look up old PlaidItem ─────────────────────────────────────────────────
  const oldItem = await db.plaidItem.findUnique({
    where:  { id: oldPlaidItemId },
    select: { id: true, userId: true, institutionId: true, status: true },
  });

  if (!oldItem) {
    return NextResponse.json({ error: "PlaidItem not found" }, { status: 404 });
  }

  // ── Find the new PlaidItem that replaced it ───────────────────────────────
  // After a fresh link + exchange-token, a new PlaidItem exists for the same
  // (userId, institutionId) with a different id. We require it to be ACTIVE
  // with a cursor (set by syncTransactions inside exchange-token) to confirm
  // the exchange-token flow actually completed before we retire the old item.
  const newItem = await db.plaidItem.findFirst({
    where: {
      userId:        oldItem.userId,
      institutionId: oldItem.institutionId,
      status:        PlaidItemStatus.ACTIVE,
      cursor:        { not: null },
      id:            { not: oldPlaidItemId },
    },
    select:  { id: true },
    orderBy: { createdAt: "desc" },
  });

  if (!newItem) {
    return NextResponse.json(
      {
        error:
          "No replacement PlaidItem found for this institution. " +
          "Ensure the new link has been completed and exchange-token has run before retiring the old item.",
      },
      { status: 422 },
    );
  }

  // ── Retire the old item ───────────────────────────────────────────────────
  // Step 1: soft-delete all live AccountConnections on the old item.
  // This is required before calling disconnectPlaidItemIfOrphaned, which
  // gates on remaining-connection count === 0.
  const { count: deletedConnections } = await db.accountConnection.updateMany({
    where: { plaidItemDbId: oldPlaidItemId, deletedAt: null },
    data:  { deletedAt: new Date() },
  });

  console.log(
    `[admin][retire-superseded-item] soft-deleted ${deletedConnections} AccountConnection(s) for old item ${oldPlaidItemId}`,
  );

  // Step 2: orphan check → Plaid itemRemove → set status=REVOKED.
  // disconnectPlaidItemIfOrphaned is the single approved retirement function.
  // Do NOT inline this logic. It already handles: remaining-connection guard,
  // Plaid API error tolerance (logs + continues), and DB status update.
  await disconnectPlaidItemIfOrphaned(oldPlaidItemId);

  console.log(
    `[admin][retire-superseded-item] retired ${oldPlaidItemId} → superseded by ${newItem.id}`,
  );

  // Forensic record (V25-CLOSE-3 Part 3). Operational metadata only — item ids,
  // the institution, and the connection count. No tokens, no financial values.
  await db.auditLog.create({
    data: {
      performedByAdminId: admin.id,
      action:             AuditAction.ADMIN_PLAID_ITEM_RETIRED,
      metadata: {
        oldPlaidItemId,
        newPlaidItemId:     newItem.id,
        ownerUserId:        oldItem.userId,
        institutionId:      oldItem.institutionId,
        deletedConnections,
        result:             "SUCCESS",
      },
    },
  });

  return NextResponse.json({
    retired:        true,
    oldPlaidItemId,
    newPlaidItemId: newItem.id,
  });
}
