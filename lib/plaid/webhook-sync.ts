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
 *
 * The lock primitives themselves live in lib/plaid/sync-lock.ts (2026-07-14,
 * F1 — connections-weirdness investigation), shared with every OTHER caller of
 * the sync engine (manual Sync/Refresh, auto-resume, Enable Investments, the
 * daily cron). This module uses the low-level claim/release calls directly
 * rather than the withPlaidItemSyncLock convenience wrapper because its success
 * signal is runDeferredHistorySync's RETURN VALUE (it never throws by design),
 * not a thrown error.
 */

import { runDeferredHistorySync } from "@/lib/plaid/backgroundHistorySync";
import { claimPlaidItemSyncLock, releasePlaidItemSyncLock, LOCK_TTL_MS } from "@/lib/plaid/sync-lock";
// DF-2C — the deferred pipeline now writes the canonical RefreshExecution ledger,
// the SAME authority manual/cron use. runFullRefresh owns the lifecycle; this
// module keeps its claim/release lock scope and never-throws contract, and
// supplies the trigger (RECONNECT vs WEBHOOK — the initiating business event).
import { runFullRefresh } from "@/lib/plaid/refresh-execution";
import type { RefreshTrigger, RefreshProfile } from "@/lib/plaid/refresh-execution-types";

export { LOCK_TTL_MS };

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
 * directly from a request path — that reintroduces the lock-free race (this is
 * enforced by a source scan in lib/plaid/sync-lock.test.ts).
 */
export async function syncPlaidItemFromWebhook(
  plaidItemId: string,
  // DF-2C — the initiating business event. "RECONNECT" from the connect flow
  // (exchange-token), "WEBHOOK" from the webhook receiver. Both run the SAME
  // deferred pipeline (profile RECONNECT); only the trigger differs.
  trigger: RefreshTrigger = "WEBHOOK",
  // OPS-2D-1 — the WORKFLOW this wrapper ran. Webhook and reconnect genuinely
  // run the deferred RECONNECT pipeline; the resume-stale-imports backstop runs
  // the same body for a different reason (continuing an incomplete first-run
  // import), and labelling that RECONNECT claimed a token exchange that never
  // happened. Historical rows are NOT rewritten — only future executions carry
  // the corrected profile.
  profile: RefreshProfile = "RECONNECT",
): Promise<WebhookSyncOutcome> {
  // DF-2C — one immutable RefreshExecution per deferred-sync attempt. The lock
  // claim/release and the never-throws contract are UNCHANGED: they live inside
  // the runner, exactly as before, and runFullRefresh never throws here (the
  // runner never throws). A lock-held attempt records a SKIPPED execution.
  return runFullRefresh<WebhookSyncOutcome>(
    { itemId: plaidItemId, trigger, profile },
    {
      refresh: async ({ recorder, runId }) => {
        if (!(await claimPlaidItemSyncLock(plaidItemId))) {
          console.log(`[plaid webhook] item ${plaidItemId} already syncing — skipped (marked incomplete for resume)`);
          recorder.skip("TRANSACTIONS", "PROVIDER", "IN_FLIGHT");
          return "skipped-locked";
        }

        let ok = false;
        try {
          ok = await runDeferredHistorySync(plaidItemId, recorder, runId);
          return "ran";
        } finally {
          // Release the lock, and on a SUCCESSFUL run also clear syncIncompleteAt in the
          // same write. A concurrent duplicate delivery that lost the lock race stamps
          // syncIncompleteAt=now via the skip branch above; because that stamp can only
          // land while THIS run holds the lock, this lock-holder's successful
          // completion is the authoritative last write and clears the stale marker —
          // otherwise the item is stuck "importing" forever despite a fully-synced
          // history (the marker's own clearer, syncTransactionsForItem, already ran
          // before the stamp). On failure, leave syncIncompleteAt as runDeferredHistorySync
          // set it — the history genuinely did not complete.
          await releasePlaidItemSyncLock(plaidItemId, ok);
        }
      },
    },
  );
}
