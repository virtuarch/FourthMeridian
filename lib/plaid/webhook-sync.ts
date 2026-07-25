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
import { runFullRefresh, recordAdmissionDenial } from "@/lib/plaid/refresh-execution";
import type { RefreshTrigger, RefreshProfile } from "@/lib/plaid/refresh-execution-types";
// OPS-2D-4 — the canonical admission authority. This wrapper is the shared entry
// point for the webhook receiver, the connect trigger and the resume backstop, so
// admitting HERE covers three of the seven producers at one seam.
import { admitOperationalWork } from "@/lib/platform/admission/facts";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";

export { LOCK_TTL_MS };

/**
 * OPS-2D-4 — "not-admitted" joins the outcome vocabulary.
 *
 * It is deliberately NOT folded into "skipped-locked". Those two look alike from
 * a caller's seat (neither ran) and mean opposite things operationally:
 * skipped-locked says another sync is doing this work right now, not-admitted
 * says nobody is and nobody will until an operator changes the platform's state.
 * Collapsing them would make an intentional pause read as healthy contention.
 */
export type WebhookSyncOutcome = "ran" | "skipped-locked" | "not-admitted";

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
  /**
   * OPS-2D-4 — a verdict already taken by the caller.
   *
   * `resume-stale-imports` fans out over up to 25 items in one pass. Admission
   * facts are platform-wide and do not change mid-loop, so re-resolving them per
   * item would be 25 reads answering one question — and worse, a mid-loop flip
   * would make one dispatch behave two ways. The job resolves once and threads
   * the verdict through; single-item callers (the webhook receiver, the connect
   * trigger) pass nothing and this resolves for itself.
   */
  admission?: StampedAdmissionVerdict,
): Promise<WebhookSyncOutcome> {
  // ── OPS-2D-4 — ADMISSION ────────────────────────────────────────────────────
  // Before the lock, before the pipeline, before any provider call. A denial
  // therefore claims nothing, stamps no syncIncompleteAt, and calls no provider —
  // it only leaves evidence.
  const verdict = admission ?? (await admitOperationalWork({ work: "REFRESH_EXECUTION" }));
  if (verdict.decision === "DENY") {
    await recordAdmissionDenial({
      itemId: plaidItemId, trigger, profile, admissionReason: verdict.reason!,
    });
    console.log(`[plaid webhook] item ${plaidItemId} not admitted — ${verdict.reason}`);
    return "not-admitted";
  }

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
