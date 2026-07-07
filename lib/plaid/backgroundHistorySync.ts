/**
 * lib/plaid/backgroundHistorySync.ts
 *
 * D2.x Slice 2 — background history continuation.
 *
 * Thin, best-effort wrapper that runs the full initial transaction history
 * import for a just-connected PlaidItem AFTER the fast Link response has
 * already been sent to the user (Slice 1 fast-path split). It is invoked from
 * app/api/plaid/exchange-token/route.ts via Next.js `after()`, so nothing here
 * runs on the request's critical path.
 *
 * Design rules (D2.x Slice 2):
 *  - Reuses the existing engine `syncTransactionsForItem()` UNCHANGED — no
 *    duplicated sync logic, no engine edits. The item's cursor is still null
 *    at this point (Slice 1 deferred the inline sync), so this is the ordinary
 *    "first sync ever = full available history" path.
 *  - Best-effort / non-fatal: this runs after the response, so a failure here
 *    can never affect Link success. It additionally never rethrows, so it can
 *    never surface as an unhandled rejection in the `after()` callback.
 *  - On failure, classifies the error via the SAME classifyPlaidErrorForHealth
 *    used by app/api/plaid/sync + refreshAllActiveItemsForUser and, when it
 *    returns health data (e.g. ITEM_LOGIN_REQUIRED → NEEDS_REAUTH), updates the
 *    existing PlaidItem.status / errorCode fields (no schema change). Transient
 *    / rate-limit errors classify to null and are left for the daily
 *    sync-banks cron to retry.
 *  - On success, syncTransactionsForItem itself already sets
 *    status = ACTIVE, errorCode = null, lastSyncedAt, and advances the cursor —
 *    so no extra success write is needed here beyond logging.
 */

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth, plaidErrorSummary } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { backfillSpaceSnapshots } from "@/lib/snapshots/backfill";

/**
 * D2.x Slice 4 — after first-run history has synced, reconstruct up to 30 days
 * of historical snapshots for every genuinely-new Space the item's accounts are
 * shared into. Best-effort / non-fatal: a backfill failure can never affect the
 * sync result or the already-sent Link response, and the new-Space gate inside
 * backfillSpaceSnapshots() makes existing Spaces no-ops. Runs only on a
 * successful sync (full transaction history is required first).
 */
async function backfillHistoryForItem(plaidItemId: string): Promise<void> {
  try {
    const conns = await db.accountConnection.findMany({
      where:  { plaidItemDbId: plaidItemId, deletedAt: null },
      select: { financialAccountId: true },
    });
    const faIds = conns.map((c) => c.financialAccountId);
    if (faIds.length === 0) return;

    const links = await db.spaceAccountLink.findMany({
      where:  { financialAccountId: { in: faIds }, status: ShareStatus.ACTIVE },
      select: { spaceId: true },
    });
    const spaceIds = [...new Set(links.map((l) => l.spaceId))];

    for (const spaceId of spaceIds) {
      try {
        const written = await backfillSpaceSnapshots(spaceId);
        if (written > 0) {
          console.log(`[plaid][D2x-slice4] backfilled ${written} snapshot(s) for space ${spaceId} (item ${plaidItemId})`);
        }
      } catch (e) {
        console.error(`[plaid][D2x-slice4] snapshot backfill failed for space ${spaceId} (non-fatal):`, e);
      }
    }
  } catch (e) {
    console.error(`[plaid][D2x-slice4] snapshot backfill resolution failed for item ${plaidItemId} (non-fatal):`, e);
  }
}

/**
 * Runs the deferred first-run transaction history import for one PlaidItem.
 * Never throws. Intended to be scheduled with Next.js `after()`.
 *
 * @param plaidItemId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function runDeferredHistorySync(plaidItemId: string): Promise<void> {
  try {
    const r = await syncTransactionsForItem(plaidItemId);
    console.log(
      `[plaid][D2x-slice2] background history sync complete for item ${plaidItemId} — ` +
        `added ${r.added}, modified ${r.modified}, removed ${r.removed} ` +
        `(created ${r.created}, updatedByPlaidId ${r.updatedByPlaidId}, updatedByFingerprint ${r.updatedByFingerprint}, skippedMissingAccount ${r.skippedMissingAccount})`,
    );

    // D2.x Slice 4 — reconstruct historical snapshots now that full history
    // exists. Best-effort/non-fatal and gated to new Spaces inside.
    await backfillHistoryForItem(plaidItemId);
  } catch (e) {
    console.error(
      `[plaid][D2x-slice2] background history sync FAILED for item ${plaidItemId} (non-fatal — Link already succeeded): ${plaidErrorSummary(e)}`,
      e,
    );

    // Reflect genuine item-health problems (needs re-auth / unrecoverable) on
    // the existing PlaidItem fields so Slice 3's status surface and the cron
    // behave correctly. Transient / 429 errors return null here and are left
    // untouched for the cron to retry. This update is itself best-effort.
    try {
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        await db.plaidItem.update({
          where: { id: plaidItemId },
          data:  { status: health.status, errorCode: health.errorCode },
        });
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(plaidItemId);
      }
    } catch (updateErr) {
      console.error(
        `[plaid][D2x-slice2] failed to persist PlaidItem health for item ${plaidItemId} (non-fatal):`,
        updateErr,
      );
    }
  }
}
