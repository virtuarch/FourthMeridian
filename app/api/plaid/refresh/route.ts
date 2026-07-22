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
import { refreshPlaidItem, refreshAllActiveItemsForUser, type RefreshSummary, type RefreshItemResult } from "@/lib/plaid/refresh";
import { classifyPlaidErrorForHealth, redactedErrorForLog } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { checkManualRefreshCooldown, markManualRefreshed, markManyManualRefreshed } from "@/lib/plaid/refreshCooldown";
import { limitByUser } from "@/lib/rate-limit";

interface RefreshBody {
  plaidItemId?: string;
}

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  // OPS-1 S4 — coarse per-user backstop over the per-item cooldown below
  // (the cooldown is per PlaidItem; many items would otherwise multiply it).
  const limited = await limitByUser(user.id, "plaid-refresh", { limit: 20, windowSec: 3600 });
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as RefreshBody;

  let summary: RefreshSummary;

  if (body.plaidItemId) {
    const item = await db.plaidItem.findFirst({
      where:  { id: body.plaidItemId, userId: user.id, status: PlaidItemStatus.ACTIVE },
      select: { id: true, lastManualRefreshAt: true },
    });
    if (!item) {
      return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
    }

    // D2 Step 7B — manual-refresh cooldown, checked before calling Plaid.
    const cooldown = checkManualRefreshCooldown(item.lastManualRefreshAt);
    if (cooldown.onCooldown) {
      return NextResponse.json(
        { error: "cooldown", retryAfterSeconds: cooldown.retryAfterSeconds },
        { status: 429 }
      );
    }

    // Marked on every attempt (success or failure) — see D2-7B checklist §5.
    await markManualRefreshed(item.id);

    // F1 (2026-07-14) — same shared syncLockedAt guard the webhook/connect
    // pipeline uses, so a manual "Refresh" can never race a webhook/cron/other
    // manual trigger against this item's cursor. See the connections-weirdness
    // investigation §4.1(d) — a freshly-connected item is off-cooldown, so a
    // user who connects and immediately hits Refresh used to race their own
    // background import.
    try {
      const lockResult = await withPlaidItemSyncLock(item.id, () => refreshPlaidItem(item.id));
      if (!lockResult.ok) {
        return NextResponse.json({ error: "in-flight" }, { status: 409 });
      }
      const r = lockResult.result;
      summary = {
        results:                   [r],
        itemCount:                 1,
        totalAccountsUpdated:      r.accountsUpdated,
        totalHoldingsUpdated:      r.holdingsUpdated,
        totalTransactionsAdded:    r.transactionsAdded,
        totalTransactionsModified: r.transactionsModified,
        totalTransactionsRemoved:  r.transactionsRemoved,
        spacesSnapshotted:     r.spacesSnapshotted,
      };
    } catch (e) {
      console.error(`[POST /api/plaid/refresh] refresh failed for PlaidItem ${item.id}:`, redactedErrorForLog(e));
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        // CH-2 — live columns (unchanged) + durable transition row only on change.
        await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(item.id);
      }
      return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
    }
  } else {
    // D2 Step 7B — partition active items into on-cooldown (skipped, no
    // Plaid call) vs. eligible before refreshing. Cooldown is marked on
    // every eligible item up front (every attempt counts, success or
    // failure — see D2-7B checklist §5), then refreshAllActiveItemsForUser
    // excludes the on-cooldown ids so it never calls Plaid for them.
    const items = await db.plaidItem.findMany({
      where:  { userId: user.id, status: PlaidItemStatus.ACTIVE },
      select: { id: true, institutionName: true, lastManualRefreshAt: true },
    });

    const skippedResults: RefreshItemResult[] = [];
    const onCooldownIds: string[] = [];
    const eligibleIds: string[] = [];

    for (const item of items) {
      const cooldown = checkManualRefreshCooldown(item.lastManualRefreshAt);
      if (cooldown.onCooldown) {
        onCooldownIds.push(item.id);
        skippedResults.push({
          plaidItemId:          item.id,
          institution:          item.institutionName,
          ok:                   false,
          accountsUpdated:      0,
          holdingsUpdated:      0,
          transactionsAdded:    0,
          transactionsModified: 0,
          transactionsRemoved:  0,
          spacesSnapshotted:    [],
          skipped:              "cooldown",
          retryAfterSeconds:    cooldown.retryAfterSeconds,
        });
      } else {
        eligibleIds.push(item.id);
      }
    }

    await markManyManualRefreshed(eligibleIds);

    summary = await refreshAllActiveItemsForUser(user.id, { excludeItemIds: onCooldownIds });
    summary.results   = [...summary.results, ...skippedResults];
    summary.itemCount = summary.itemCount + skippedResults.length;
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
        spacesSnapshotted:     summary.spacesSnapshotted.length,
      },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, ...summary });
}, "POST /api/plaid/refresh");
