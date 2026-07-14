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
 * F1 (2026-07-14) — each item's sync goes through the shared syncLockedAt
 * guard (lib/plaid/sync-lock.ts). Two concurrent full pipelines against the
 * same item DO race PlaidItem.cursor and can collide on
 * prisma.transaction.create() (the "Amex 363 UPSERT_ERROR" signature) — the
 * old "idempotent and safe to overlap" claim below was stale/wrong (see the
 * connections-weirdness investigation §2.2); a webhook or manual trigger
 * firing during this job's run on the same item is now skipped-locked instead
 * of racing it, and picked up by whichever pipeline is already in flight.
 *
 * One institution's failure (e.g. ITEM_LOGIN_REQUIRED after the user revokes
 * access at their bank) must never block syncing the rest — each item is
 * wrapped individually.
 */

import { db } from "@/lib/db";
import { PlaidInvestmentsConsent, PlaidItemStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { ingestInvestmentEvents, investmentEventsEnabled } from "@/lib/investments/investment-event-ingest";

export interface SyncBanksResult {
  succeeded: number;
  failed:    number;
  /** F1 (2026-07-14) — items skipped because another sync already held their lock. Neither succeeded nor failed; picked up by the in-flight run. */
  skipped:   number;
  total:     number;
  /** A3-4 — items whose scheduled investment-event ingestion ran (flag on + consent ENABLED). */
  eventItems: number;
}

export async function syncBanks(): Promise<SyncBanksResult> {
  // OPS-2 S4: skip items belonging to deactivated users — a deactivated
  // account shouldn't keep accruing Plaid sync calls (billing honesty). The
  // items themselves stay ACTIVE; syncing resumes automatically on
  // reactivation (deactivatedAt back to null).
  const items = await db.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE, user: { deactivatedAt: null } },
    // A3-4 — investmentsConsent + encryptedToken added for scheduled event
    // ingestion below. The token is decrypted only when actually ingesting
    // (flag on + consent ENABLED) and never leaves this server context.
    select: { id: true, institutionName: true, investmentsConsent: true, encryptedToken: true },
  });

  if (items.length === 0) return { succeeded: 0, failed: 0, skipped: 0, total: 0, eventItems: 0 };

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let eventItems = 0;
  const eventsOn = investmentEventsEnabled();

  for (const item of items) {
    try {
      const lockResult = await withPlaidItemSyncLock(item.id, () => syncTransactionsForItem(item.id));
      if (!lockResult.ok) {
        skipped++;
        console.log(`[sync-banks] ${item.institutionName}: skipped — sync already in progress elsewhere`);
      } else {
        succeeded++;
        const result = lockResult.result;
        if (result.added || result.modified || result.removed) {
          console.log(
            `[sync-banks] ${item.institutionName}: +${result.added} ~${result.modified} -${result.removed}`
          );
        }
      }
    } catch (e) {
      failed++;
      console.error(`[sync-banks] failed for institution "${item.institutionName}" (PlaidItem ${item.id}):`, e);
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        // CH-2 — live columns (unchanged) + durable transition row only on change.
        await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(item.id);
      }
    }

    // A3-4 — scheduled canonical investment-event ingestion. Reuses the SAME
    // shared ingest as the refresh/exchange paths (no second implementation),
    // gated behind INVESTMENT_EVENTS_ENABLED and limited to Items with
    // Investments consent (avoids a doomed call on every non-investment Item).
    // Fully isolated best-effort: never affects the transaction-sync counts
    // above, never fails the job, never touches Holding/PositionObservation.
    // Deliberately unconditional on the lock outcome above — event ingestion is
    // a separate Plaid call (investmentsTransactionsGet) with its own dedupe,
    // not part of the cursor/transaction race this lock guards against.
    if (eventsOn && item.investmentsConsent === PlaidInvestmentsConsent.ENABLED) {
      try {
        const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
        await ingestInvestmentEvents({ accessToken, plaidItemId: item.id, now: new Date() });
        eventItems++;
      } catch (evErr) {
        console.warn(`[sync-banks] investment event ingestion failed for "${item.institutionName}" (PlaidItem ${item.id}) (non-fatal):`, evErr);
      }
    }
  }

  console.log(`[sync-banks] complete — ${succeeded} succeeded, ${failed} failed, ${skipped} skipped, ${items.length} total, ${eventItems} event-ingest`);

  return { succeeded, failed, skipped, total: items.length, eventItems };
}
