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
import { claimPlaidItemSyncLockAt, releasePlaidItemSyncLock, LOCK_TTL_MS } from "@/lib/plaid/sync-lock";
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
import { billableSkipCode, type BillableDecision, type BillableOperation } from "@/lib/entitlements/billable-gate-core";
import { billableForPlaidItem } from "@/lib/platform/policies/billable-subjects";

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
export type WebhookSyncOutcome = "ran" | "skipped-locked" | "not-admitted" | "plan-restricted";

/**
 * BETA LIFECYCLE L2 — the billable gate at the shared choke point. Every
 * producer of the deferred pipeline (the Plaid webhook, the connect follow-on
 * import, resume-sync, resume-stale-imports) reaches the provider through
 * here, so ONE gate covers all four. The Item bills the user who CONNECTED it
 * (PlaidItem.userId — lib/platform/policies/billable-subjects.ts).
 *
 * A refusal follows the admission-denial contract exactly: no lock claimed,
 * no syncIncompleteAt stamped or cleared, no lastSyncedAt / cursor / health
 * change, no provider call — one SKIPPED RefreshExecution whose
 * admissionReason is the billable skip code (e.g. BILLABLE_COST_FREEZE), so
 * Platform Ops sees "deferred by plan", never "completed". After the
 * restriction lifts, the Item resumes from its persisted cursor (the next
 * webhook, the daily sync-banks sweep, or resume-stale-imports when an import
 * was incomplete).
 */
export interface WebhookSyncGate {
  /** A decision already taken by a batch caller (resume-stale-imports); single-item callers pass none. */
  billable?: BillableDecision;
  /** Test seams — production passes none. */
  checkBillable?: (plaidItemId: string, operation: BillableOperation) => Promise<BillableDecision>;
  recordDenial?: typeof recordAdmissionDenial;
  /** Replaces the locked pipeline (tests prove it is never reached on a refusal). */
  runPipeline?: () => Promise<WebhookSyncOutcome>;
  /**
   * P2 — replaces ONE locked run (claim → pipeline → release) but keeps the
   * follow-up orchestration around it, so a test can drive the real lock
   * primitives against a fake row and count how many runs the wrapper starts.
   */
  runLockedOnce?: () => Promise<LockedRunResult>;
}

/**
 * P2 — what one locked run reports to the orchestrator. `followUp` is true iff
 * the run SUCCEEDED and a skip landed while it held the lock (the release kept
 * that skip's marker — releasePlaidItemSyncLock's `pendingSignal`).
 */
export interface LockedRunResult {
  outcome: WebhookSyncOutcome;
  followUp: boolean;
  /** Wall-clock of the run, for the follow-up budget check. */
  elapsedMs: number;
}

/**
 * P2 — the in-process follow-up budget. Every caller runs under maxDuration =
 * 300 s (webhook, exchange-token, resume-sync). A first run that already used
 * more than this leaves too little room for a second full pipeline, so the
 * follow-up is not started and the surviving marker is the resume-stale-imports
 * backstop's to drive instead (every 5 min, once the marker is > 315 s old).
 * The lock TTL is untouched.
 */
export const FOLLOW_UP_MAX_FIRST_RUN_MS = 120_000;

/**
 * P2 — should the wrapper start its ONE follow-up run? Pure, so the policy is
 * pinned on its own.
 *
 *  · only after a run that succeeded with a skip landing mid-run (`followUp`);
 *  · never from a follow-up itself (bounded: one extra run, never a loop);
 *  · never for RESUME — resume-stale-imports drives up to MAX_ITEMS_PER_RUN
 *    items in one 300 s invocation, so doubling an item's work there would
 *    spend the batch's budget; the kept marker makes the Item a candidate on
 *    the next pass instead;
 *  · never when the first run used more than FOLLOW_UP_MAX_FIRST_RUN_MS.
 */
export function shouldRunFollowUp(
  first: Pick<LockedRunResult, "followUp" | "elapsedMs">,
  trigger: RefreshTrigger,
  isFollowUp: boolean,
): boolean {
  return first.followUp && !isFollowUp && trigger !== "RESUME" && first.elapsedMs <= FOLLOW_UP_MAX_FIRST_RUN_MS;
}

/** The billable operation each trigger represents. */
export function webhookSyncOperation(trigger: RefreshTrigger): BillableOperation {
  return trigger === "RESUME" ? "plaid_resume_sync" : trigger === "WEBHOOK" ? "plaid_webhook_sync" : "plaid_sync";
}

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
  gate: WebhookSyncGate = {},
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

  // ── BETA LIFECYCLE L2 — THE BILLABLE GATE ───────────────────────────────────
  // After admission, before the lock, before the pipeline, before any provider
  // call: a frozen / paused / ended (or unverifiable) customer's Item records a
  // deferred fact and nothing else (see WebhookSyncGate).
  const billable = gate.billable
    ?? await (gate.checkBillable ?? billableForPlaidItem)(plaidItemId, webhookSyncOperation(trigger));
  if (!billable.allowed) {
    await (gate.recordDenial ?? recordAdmissionDenial)({
      itemId: plaidItemId, trigger, profile, admissionReason: billableSkipCode(billable.reason),
    }).catch((e) => console.warn(`[plaid webhook] deferred-fact record failed for ${plaidItemId} (non-fatal):`, e instanceof Error ? e.message : String(e)));
    console.log(`[plaid webhook] item ${plaidItemId} plan-restricted — ${billable.reason}; no provider call, no lock, no marker written`);
    return "plan-restricted";
  }
  if (gate.runPipeline) return gate.runPipeline();

  // ── P2 — ONE LOCKED RUN, THEN AT MOST ONE FOLLOW-UP ─────────────────────────
  // A signal that loses the claim while this run holds the lock (Production
  // 2026-11-01: a card's HISTORICAL_UPDATE, 9 s into the RECONNECT run) is
  // recorded as a kept syncIncompleteAt marker, and the release reports it. The
  // follow-up re-uses the verdicts already taken above (seconds old) and goes
  // through the same claim, so the lock and idempotency guarantees are those
  // of any run. It is never itself followed up: however many skips land during
  // either run, the wrapper starts at most two runs, and whatever the follow-up
  // could not absorb stays on the marker for resume-stale-imports.
  const runOnce = gate.runLockedOnce ?? (() => runLockedOnce(plaidItemId, trigger, profile));
  const first = await runOnce();
  if (shouldRunFollowUp(first, trigger, false)) {
    console.log(`[plaid webhook] item ${plaidItemId}: a sync was skipped during this run — running ONE follow-up pass now`);
    await runOnce();
  } else if (first.followUp) {
    console.log(`[plaid webhook] item ${plaidItemId}: a sync was skipped during this run — follow-up left to resume-stale-imports (trigger ${trigger}, first run ${first.elapsedMs} ms)`);
  }
  return first.outcome;
}

/**
 * One claim → full deferred pipeline → release, under one RefreshExecution.
 * Unchanged from before P2 except that it reports whether the release kept a
 * mid-run skip's marker.
 */
async function runLockedOnce(
  plaidItemId: string,
  trigger: RefreshTrigger,
  profile: RefreshProfile,
): Promise<LockedRunResult> {
  const t0 = Date.now();
  let followUp = false;
  // DF-2C — one immutable RefreshExecution per deferred-sync attempt. The lock
  // claim/release and the never-throws contract are UNCHANGED: they live inside
  // the runner, exactly as before, and runFullRefresh never throws here (the
  // runner never throws). A lock-held attempt records a SKIPPED execution.
  const outcome = await runFullRefresh<WebhookSyncOutcome>(
    { itemId: plaidItemId, trigger, profile },
    {
      refresh: async ({ recorder, runId }) => {
        // IDEMP-005 — the claim returns the fencing token; the release below only
        // clears the lease while this run still owns it (a run that outlived
        // LOCK_TTL_MS must not clear the next holder's lock).
        const claimedAt = await claimPlaidItemSyncLockAt(plaidItemId);
        if (!claimedAt) {
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
          // same write — but only a marker from BEFORE this claim (P2). A losing claim
          // stamps syncIncompleteAt=now via the skip branch above while THIS run holds
          // the lock; that stamp is a signal this run may not have seen (a
          // HISTORICAL_UPDATE that landed after the transactions pull), so the release
          // keeps it and reports `pendingSignal` for the one follow-up. A marker older
          // than the claim is this run's to discharge and is cleared exactly as
          // before (b871093). On failure, leave syncIncompleteAt as
          // runDeferredHistorySync set it — the history genuinely did not complete.
          const released = await releasePlaidItemSyncLock(plaidItemId, ok, undefined, claimedAt);
          followUp = released.pendingSignal;
        }
      },
    },
  );
  return { outcome, followUp, elapsedMs: Date.now() - t0 };
}
