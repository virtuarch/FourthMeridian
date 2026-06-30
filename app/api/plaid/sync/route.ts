/**
 * POST /api/plaid/sync
 *
 * Manual "Sync Now" trigger. Calls the same syncTransactionsForItem()
 * function used for the initial post-Link sync and the jobs/sync-banks.ts
 * job — no UI is wired to this yet, but the endpoint exists so a future
 * button can call it without any new sync logic.
 *
 * Body (optional): { plaidItemId?: string }
 *   - plaidItemId provided: sync only that item (must belong to the caller).
 *   - omitted: sync every active PlaidItem owned by the caller.
 *
 * One item's failure (e.g. ITEM_LOGIN_REQUIRED) does not block the others —
 * each result is reported individually.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { PlaidItemStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth } from "@/lib/plaid/errors";

interface SyncBody {
  plaidItemId?: string;
}

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json().catch(() => ({})) as SyncBody;

  const items = await db.plaidItem.findMany({
    where: {
      userId: user.id,
      status: PlaidItemStatus.ACTIVE,
      ...(body.plaidItemId && { id: body.plaidItemId }),
    },
    select: { id: true, institutionName: true },
  });

  if (body.plaidItemId && items.length === 0) {
    return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
  }

  const results = [];
  let totalAdded = 0, totalModified = 0, totalRemoved = 0;

  for (const item of items) {
    try {
      const r = await syncTransactionsForItem(item.id);
      totalAdded    += r.added;
      totalModified += r.modified;
      totalRemoved  += r.removed;
      results.push({ plaidItemId: item.id, institution: item.institutionName, ok: true, ...r });
    } catch (e) {
      console.error(`[POST /api/plaid/sync] sync failed for PlaidItem ${item.id}:`, e);
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        await db.plaidItem.update({
          where: { id: item.id },
          data:  { status: health.status, errorCode: health.errorCode },
        });
      }
      results.push({ plaidItemId: item.id, institution: item.institutionName, ok: false });
    }
  }

  await db.auditLog.create({
    data: {
      userId:    user.id,
      action:    AuditAction.PLAID_SYNC,
      metadata:  { itemCount: items.length, totalAdded, totalModified, totalRemoved },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, results, totalAdded, totalModified, totalRemoved });
}, "POST /api/plaid/sync");
