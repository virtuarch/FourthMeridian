/**
 * lib/plaid/webhook-sync.ts
 *
 * The webhook-triggered sync, with a DB concurrency guard.
 *
 * A SYNC_UPDATES_AVAILABLE webhook can be delivered more than once and can race
 * the in-flight post-connect pipeline. Two full pipelines for the same item at
 * once would race PlaidItem.cursor, so this claims a per-item lock
 * (PlaidItem.syncLockedAt) via a conditional update before running, and releases
 * it after. An in-memory lock would not help — duplicate deliveries can land on
 * different serverless instances, so the guard MUST live in the DB.
 *
 * IMPORTANT: it runs the FULL deferred pipeline (runDeferredHistorySync →
 * transaction sync → snapshot backfill → reconstruction → price backfill →
 * wealth regen), NOT a bare syncTransactionsForItem — otherwise a webhook-driven
 * sync would fetch new transactions but leave snapshots/Wealth stale.
 */

import { db } from "@/lib/db";
import { runDeferredHistorySync } from "@/lib/plaid/backgroundHistorySync";

/**
 * Stale-lock recovery window. A crashed/killed pipeline that never released its
 * lock is re-claimable after this long. Set well beyond the 60s invocation
 * budget the pipeline runs under, so it never pre-empts a genuinely live sync.
 */
export const LOCK_TTL_MS = 180_000; // 3 minutes

export type WebhookSyncOutcome = "ran" | "skipped-locked";

/**
 * Claim the per-item sync lock, run the full deferred pipeline, release the
 * lock. If another (fresh) sync already holds the lock, do NOT start a second
 * one — instead mark the item incomplete so the existing resume path re-syncs
 * after the in-flight run finishes, and return "skipped-locked". Best-effort:
 * runDeferredHistorySync never throws, and the lock is always released.
 *
 * Despite the name, this is the SHARED guarded entry point for the full deferred
 * pipeline: BOTH the webhook receiver (app/api/plaid/webhook) AND the connect
 * trigger (app/api/plaid/exchange-token) call it, so a connect pipeline and a
 * webhook pipeline can never run concurrently against the same item (Plaid fires
 * investment/transaction webhooks within seconds of a connect). Whichever wins
 * the lock runs; the other is skipped-locked. Never call runDeferredHistorySync
 * directly from a request path — that reintroduces the lock-free race.
 */
export async function syncPlaidItemFromWebhook(plaidItemId: string): Promise<WebhookSyncOutcome> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - LOCK_TTL_MS);

  // Atomic claim: succeeds only if unlocked, or the prior lock is stale.
  const claim = await db.plaidItem.updateMany({
    where: { id: plaidItemId, OR: [{ syncLockedAt: null }, { syncLockedAt: { lte: staleCutoff } }] },
    data:  { syncLockedAt: now },
  });

  if (claim.count === 0) {
    // A fresh sync holds the lock. Don't race it — record that more history is
    // pending so the client auto-resume / next trigger re-syncs once it's free.
    await db.plaidItem
      .updateMany({ where: { id: plaidItemId }, data: { syncIncompleteAt: now } })
      .catch(() => {});
    console.log(`[plaid webhook] item ${plaidItemId} already syncing — skipped (marked incomplete for resume)`);
    return "skipped-locked";
  }

  let ok = false;
  try {
    ok = await runDeferredHistorySync(plaidItemId);
    return "ran";
  } finally {
    // Release the lock, and on a SUCCESSFUL run also clear syncIncompleteAt in the
    // same write. A concurrent duplicate delivery that lost the lock race stamps
    // syncIncompleteAt=now via the skipped-locked branch above; because that stamp
    // can only land while THIS run holds the lock, this lock-holder's successful
    // completion is the authoritative last write and clears the stale marker —
    // otherwise the item is stuck "importing" forever despite a fully-synced
    // history (the marker's own clearer, syncTransactionsForItem, already ran
    // before the stamp). On failure, leave syncIncompleteAt as runDeferredHistorySync
    // set it — the history genuinely did not complete.
    await db.plaidItem
      .updateMany({
        where: { id: plaidItemId },
        data:  ok ? { syncLockedAt: null, syncIncompleteAt: null } : { syncLockedAt: null },
      })
      .catch((e) => console.error(`[plaid webhook] failed to release lock for item ${plaidItemId}:`, e));
  }
}
