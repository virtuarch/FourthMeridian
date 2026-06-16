/**
 * POST /api/plaid/refresh
 *
 * Manual "Refresh" trigger — refreshes balances, investment holdings, and
 * transactions for every active PlaidItem owned by the caller. Wraps
 * lib/plaid/refresh.ts's refreshAllActiveItemsForUser()/refreshPlaidItem(),
 * the same functions intended for a future daily cron job and webhook
 * handler — no refresh logic is duplicated here.
 *
 * Body (optional): { plaidItemId?: string }
 *   - plaidItemId provided: refresh only that item (must belong to the caller).
 *   - omitted: refresh every active PlaidItem owned by the caller.
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
import { refreshPlaidItem, refreshAllActiveItemsForUser, type RefreshSummary } from "@/lib/plaid/refresh";

interface RefreshBody {
  plaidItemId?: string;
}

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = (await req.json().catch(() => ({}))) as RefreshBody;

  let summary: RefreshSummary;

  if (body.plaidItemId) {
    const item = await db.plaidItem.findFirst({
      where:  { id: body.plaidItemId, userId: user.id, status: PlaidItemStatus.ACTIVE },
      select: { id: true },
    });
    if (!item) {
      return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
    }

    try {
      const r = await refreshPlaidItem(item.id);
      summary = {
        results:                   [r],
        itemCount:                 1,
        totalAccountsUpdated:      r.accountsUpdated,
        totalHoldingsUpdated:      r.holdingsUpdated,
        totalTransactionsAdded:    r.transactionsAdded,
        totalTransactionsModified: r.transactionsModified,
        totalTransactionsRemoved:  r.transactionsRemoved,
      };
    } catch (e) {
      console.error(`[POST /api/plaid/refresh] refresh failed for PlaidItem ${item.id}:`, e);
      return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
    }
  } else {
    summary = await refreshAllActiveItemsForUser(user.id);
  }

  await db.auditLog.create({
    data: {
      userId:    user.id,
      action:    AuditAction.PLAID_REFRESH,
      metadata:  {
        itemCount:                 summary.itemCount,
        totalAccountsUpdated:      summary.totalAccountsUpdated,
        totalHoldingsUpdated:      summary.totalHoldingsUpdated,
        totalTransactionsAdded:    summary.totalTransactionsAdded,
        totalTransactionsModified: summary.totalTransactionsModified,
        totalTransactionsRemoved:  summary.totalTransactionsRemoved,
      },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, ...summary });
}, "POST /api/plaid/refresh");
