/**
 * lib/plaid/sync-notifications.ts  (OPS-3 S5 Wave 3)
 *
 * The SYNC_FAILED producer pair — domain-owned helpers the Plaid health
 * seams call in one line each:
 *
 *   notifyItemSyncFailed(itemId)   — after a health-CLASSIFIED failure (the
 *     classifyPlaidErrorForHealth → PlaidItem status update idiom). Transient
 *     errors (classify → null) never notify, exactly as they never change
 *     item status. Five call sites: the sync-banks cron, the interactive
 *     refresh/sync routes, refreshAllActiveItemsForUser, and the deferred
 *     background history sync. Dedupe (suppress-while-open, key
 *     "SYNC_FAILED:item:{id}:open") makes multi-site production idempotent —
 *     however many paths observe the same broken item, ONE notification is
 *     live.
 *
 *   retireItemSyncFailure(itemId)  — after the item PROVABLY works again
 *     (the status→ACTIVE writes: a completed transaction sync, a completed
 *     refresh, a Link relink/re-exchange). Releases the :open key and
 *     archives the stale "needs attention" row, so a FUTURE outage notifies
 *     again (frozen F3 retirement).
 *
 * Both are best-effort and non-throwing: sync/import/reconnect flows must
 * never fail over notification bookkeeping. Everything flows through the
 * chokepoint / resolve primitives — no direct Notification writes here.
 */

import { db } from "@/lib/db";
import { createNotification } from "@/lib/notifications/create";
import { retireOpenNotification } from "@/lib/notifications/resolve";

interface ItemOwnerRow {
  userId: string;
  institutionName: string | null;
}

/** Minimal read this module needs (injection seam for tests). */
export interface PlaidItemReadClient {
  plaidItem: {
    findUnique(args: {
      where: { id: string };
      select: { userId: true; institutionName: true };
    }): Promise<ItemOwnerRow | null>;
  };
}

function itemClient(ctx?: { itemClient?: PlaidItemReadClient }): PlaidItemReadClient {
  return ctx?.itemClient ?? (db as unknown as PlaidItemReadClient);
}

/** Ping the item's owner that the connection needs attention. Best-effort. */
export async function notifyItemSyncFailed(
  plaidItemId: string,
  ctx?: {
    itemClient?: PlaidItemReadClient;
    createFn?: typeof createNotification;
  },
): Promise<void> {
  try {
    const item = await itemClient(ctx).plaidItem.findUnique({
      where: { id: plaidItemId },
      select: { userId: true, institutionName: true },
    });
    if (!item) return;

    await (ctx?.createFn ?? createNotification)({
      type: "SYNC_FAILED",
      userId: item.userId,
      data: {
        plaidItemId,
        institutionName: item.institutionName ?? "",
      },
    });
  } catch (err) {
    console.warn(`[notifyItemSyncFailed] non-fatal failure for item ${plaidItemId}:`, err);
  }
}

/** Retire the open SYNC_FAILED condition after the item works again. Best-effort. */
export async function retireItemSyncFailure(
  plaidItemId: string,
  ctx?: {
    itemClient?: PlaidItemReadClient;
    retireFn?: typeof retireOpenNotification;
  },
): Promise<void> {
  try {
    const item = await itemClient(ctx).plaidItem.findUnique({
      where: { id: plaidItemId },
      select: { userId: true, institutionName: true },
    });
    if (!item) return;

    await (ctx?.retireFn ?? retireOpenNotification)(item.userId, "SYNC_FAILED", {
      plaidItemId,
    });
  } catch (err) {
    console.warn(`[retireItemSyncFailure] non-fatal failure for item ${plaidItemId}:`, err);
  }
}
