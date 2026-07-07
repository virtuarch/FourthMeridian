/**
 * jobs/sync-banks.ts
 *
 * Background job: incrementally syncs transactions for every active
 * PlaidItem, via the shared syncTransactionsForItem() function (see
 * lib/plaid/syncTransactions.ts).
 *
 * SCHEDULING (OPS-4 S2): registered in lib/jobs/registry.ts (06:00 UTC slot)
 * and executed by the single dispatcher cron (app/api/jobs/dispatch),
 * ledgered through runJob(). The per-job route
 * app/api/jobs/sync-banks/route.ts (D2 Step 7C) remains as the
 * manual/fallback entrypoint. The historical in-process jobs/scheduler.ts —
 * dormant since birth (startScheduler() was never invoked) — was retired in
 * S2; the registry is its successor.
 *
 * Idempotent and safe to overlap with a user-triggered sync of the same
 * item — both paths upsert on the unique Transaction.plaidTransactionId, so
 * re-processing the same page of Plaid results never creates duplicates.
 *
 * One institution's failure (e.g. ITEM_LOGIN_REQUIRED after the user revokes
 * access at their bank) must never block syncing the rest — each item is
 * wrapped individually.
 */

import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";

export interface SyncBanksResult {
  succeeded: number;
  failed:    number;
  total:     number;
}

export async function syncBanks(): Promise<SyncBanksResult> {
  // OPS-2 S4: skip items belonging to deactivated users — a deactivated
  // account shouldn't keep accruing Plaid sync calls (billing honesty). The
  // items themselves stay ACTIVE; syncing resumes automatically on
  // reactivation (deactivatedAt back to null).
  const items = await db.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE, user: { deactivatedAt: null } },
    select: { id: true, institutionName: true },
  });

  if (items.length === 0) return { succeeded: 0, failed: 0, total: 0 };

  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const result = await syncTransactionsForItem(item.id);
      succeeded++;
      if (result.added || result.modified || result.removed) {
        console.log(
          `[sync-banks] ${item.institutionName}: +${result.added} ~${result.modified} -${result.removed}`
        );
      }
    } catch (e) {
      failed++;
      console.error(`[sync-banks] failed for institution "${item.institutionName}" (PlaidItem ${item.id}):`, e);
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        await db.plaidItem.update({
          where: { id: item.id },
          data:  { status: health.status, errorCode: health.errorCode },
        });
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(item.id);
      }
    }
  }

  console.log(`[sync-banks] complete — ${succeeded} succeeded, ${failed} failed, ${items.length} total`);

  return { succeeded, failed, total: items.length };
}
