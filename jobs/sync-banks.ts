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
 * instrumentation.ts hook) — that's a separate, pre-existing gap, so the
 * scheduler.ts registration is dormant. Production scheduling instead goes
 * through app/api/jobs/sync-banks/route.ts (D2 Step 7C), a Vercel Cron
 * target that calls this same function directly — see vercel.json for the
 * schedule.
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

export interface SyncBanksResult {
  succeeded: number;
  failed:    number;
  total:     number;
}

export async function syncBanks(): Promise<SyncBanksResult> {
  const items = await db.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE },
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
      }
    }
  }

  console.log(`[sync-banks] complete — ${succeeded} succeeded, ${failed} failed, ${items.length} total`);

  return { succeeded, failed, total: items.length };
}
