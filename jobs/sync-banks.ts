/**
 * jobs/sync-banks.ts
 *
 * Background job: incrementally syncs transactions for every active
 * PlaidItem, via the shared syncTransactionsForItem() function (see
 * lib/plaid/syncTransactions.ts). Runs on a fixed interval registered in
 * jobs/scheduler.ts.
 *
 * This file existed as an empty `export {}` stub (named for exactly this
 * purpose, per the original jobs/scheduler.ts doc comment: "stub until Plaid
 * integration is wired") before this change — filling it in wires a
 * pre-existing placeholder rather than introducing new job infrastructure.
 * Note startScheduler() itself still isn't invoked anywhere (no
 * instrumentation.ts hook) — that's a separate, pre-existing gap, so this
 * job is registered but dormant until that's wired up.
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

export async function syncBanks(): Promise<void> {
  const items = await db.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE },
    select: { id: true, institutionName: true },
  });

  if (items.length === 0) return;

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
    }
  }

  console.log(`[sync-banks] complete — ${succeeded} succeeded, ${failed} failed, ${items.length} total`);
}
