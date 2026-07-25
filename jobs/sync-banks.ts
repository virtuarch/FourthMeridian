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
 *
 * 2026-07-14 — after each item's successful sync, best-effort re-runs A9
 * wealth-history regeneration (regenerate-history.ts) over its accounts'
 * spaces. This is the ongoing self-heal half of the same-day fix: connect
 * time only gets ONE regen pass (backgroundHistorySync.ts), and if this
 * item's transactions genuinely weren't all available yet at that moment,
 * nothing previously ever retried it. Every daily sync now gives it another
 * chance, using the SAME earliest-transaction floor, so history catches up
 * on its own within a day or two with no manual re-run. Gated on
 * WEALTH_REGENERATION_ENABLED; a no-op when unset.
 */

import { db } from "@/lib/db";
import { PlaidInvestmentsConsent, PlaidItemStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { classifyPlaidErrorForHealth, redactedErrorForLog } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { ingestInvestmentEvents, investmentEventsEnabled } from "@/lib/investments/investment-event-ingest";
import { regenerateWealthHistoryForAccounts, wealthRegenerationEnabled, recentWealthWindow } from "@/lib/snapshots/regenerate-history";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { refreshBalancesForItem } from "@/lib/plaid/refresh";
// DF-2B — scheduled refresh adopts the SAME canonical execution authority as
// manual refresh. runFullRefresh owns the RefreshExecution lifecycle; cron
// injects its OWN stage pipeline (below) so its provider work is unchanged —
// only the execution ledger is added.
import { runFullRefresh } from "@/lib/plaid/refresh-execution";
// OPS-2D-4 — canonical admission, resolved once per dispatch (see syncBanks).
import { admitOperationalWork } from "@/lib/platform/admission/facts";
import type { RefreshStageRecorder, RefreshEndpoint } from "@/lib/plaid/refresh-execution-types";

export interface SyncBanksResult {
  succeeded: number;
  failed:    number;
  /** F1 (2026-07-14) — items skipped because another sync already held their lock. Neither succeeded nor failed; picked up by the in-flight run. */
  skipped:   number;
  total:     number;
  /** A3-4 — items whose scheduled investment-event ingestion ran (flag on + consent ENABLED). */
  eventItems: number;
  /**
   * OPS-2D-4 — the typed admission reason when the platform declined this pass.
   * Absent on every admitted run. The job SUCCEEDED: it ran, asked, and was told
   * no. This lands in the JobRun summary, which is what keeps a paused platform
   * from reading as a broken scheduler.
   */
  notAdmitted?: string;
}

/** DF-2B — the cron runner's outcome, consumed by syncBanks for counting/logging. */
export interface CronItemOutcome {
  /** The item's transaction sync was skipped because another sync held its lock. */
  skippedLocked: boolean;
  added:    number;
  modified: number;
  removed:  number;
}

/** Injection seam for testing the cron stage sequence without Plaid or a database. */
export interface CronItemDeps {
  syncTransactions?:    typeof syncTransactionsForItem;
  withLock?:            typeof withPlaidItemSyncLock;
  refreshBalances?:     typeof refreshBalancesForItem;
  regenerateSnapshots?: typeof regenerateSnapshotsForAccounts;
}

/**
 * DF-2B — the cron per-item stage pipeline, driving the RefreshExecution
 * recorder. Behavior-preserving vs. the previous inline body: transactions
 * under the item lock (skip → IN_FLIGHT), then best-effort balances + today's
 * snapshot (never fails the item; recorded FAILED without throwing). Wealth-
 * history self-heal and investment-event ingestion stay in syncBanks, exactly
 * as before (a wealth projection and a lock-independent Plaid call, not stages
 * of this locked refresh). A thrown transaction error propagates to
 * runFullRefresh (finalizes TRANSACTIONS FAILED) and on to syncBanks's catch.
 */
export async function runCronItemRefresh(
  itemId: string,
  recorder: RefreshStageRecorder,
  runId: string,
  deps: CronItemDeps = {},
): Promise<CronItemOutcome> {
  const syncTransactions    = deps.syncTransactions    ?? syncTransactionsForItem;
  const withLock            = deps.withLock            ?? withPlaidItemSyncLock;
  const refreshBalances     = deps.refreshBalances     ?? refreshBalancesForItem;
  const regenerateSnapshots = deps.regenerateSnapshots ?? regenerateSnapshotsForAccounts;

  // ── TRANSACTIONS — the ONE stage under the item lock ─────────────────────
  recorder.begin("TRANSACTIONS", "PROVIDER");
  const lockResult = await withLock(itemId, () => syncTransactions(itemId, { runId }));
  if (!lockResult.ok) {
    recorder.skip("TRANSACTIONS", "PROVIDER", "IN_FLIGHT");
    return { skippedLocked: true, added: 0, modified: 0, removed: 0 };
  }
  const tx = lockResult.result;
  recorder.succeed("TRANSACTIONS", {
    recordsRead:    tx.added + tx.modified,
    recordsWritten: tx.created + tx.updatedByPlaidId + tx.updatedByFingerprint,
    recordsChanged: tx.added + tx.modified + tx.removed,
  });

  // ── BALANCES + SNAPSHOT — best-effort freshness; never fails the item ────
  // (CONN-3 L3: the daily sync refreshes balances then regenerates today's
  // snapshot from those fresh balances.)
  recorder.begin("BALANCES", "PROVIDER");
  let stage: RefreshEndpoint = "BALANCES";
  try {
    const bal = await refreshBalances(itemId);
    recorder.succeed("BALANCES", {
      recordsChanged:    bal.updatedAccountIds.length,
      coveredAccountIds: bal.updatedAccountIds,
      accounts:          bal.accountCoverage,
    });
    if (bal.updatedAccountIds.length > 0) {
      stage = "SNAPSHOT";
      recorder.begin("SNAPSHOT", "DERIVED");
      const spaces = await regenerateSnapshots(bal.updatedAccountIds);
      recorder.succeed("SNAPSHOT", {
        recordsChanged:    spaces.length,
        coveredAccountIds: bal.updatedAccountIds, // input accounts (doctrine: materially-used inputs)
      });
    }
  } catch (e) {
    recorder.fail(stage, e);
    console.warn(`[sync-banks] balance/snapshot freshness failed for PlaidItem ${itemId} (non-fatal):`, e);
  }

  return { skippedLocked: false, added: tx.added, modified: tx.modified, removed: tx.removed };
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

  // ── OPS-2D-4 — ADMISSION, once per dispatch ─────────────────────────────────
  // The fleet sync is the widest fan-out on the platform. Admission facts are
  // platform-wide, so one resolution governs the whole pass: asking per item
  // would be N reads answering one question, and a mid-loop flip would make a
  // single dispatch behave two ways.
  //
  // Evidence is ONE dispatch-level finding in the JobRun summary — NOT a denied
  // RefreshExecution per item. With a fleet of connections and a multi-slot cron,
  // per-item rows would bury the real executions the Refresh workspace exists to
  // show behind thousands of identical denials.
  //
  // The job returns NORMALLY. It ran, it asked, it was told no — that is a
  // successful job, and recording it as a failure would make an operator's own
  // pause register as a broken scheduler.
  const admission = await admitOperationalWork({ work: "REFRESH_EXECUTION" });
  if (admission.decision === "DENY") {
    console.log(
      `[sync-banks] ${items.length} item(s) eligible but NOT ADMITTED — ${admission.reason}; ` +
        "no provider call, no lock claimed, no item marked.",
    );
    return { succeeded: 0, failed: 0, skipped: 0, total: items.length, eventItems: 0, notAdmitted: admission.reason! };
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let eventItems = 0;
  const eventsOn = investmentEventsEnabled();

  for (const item of items) {
    try {
      // DF-2B — through the canonical execution authority. runFullRefresh opens
      // one immutable RefreshExecution per item, runs cron's OWN stage pipeline
      // (runCronItemRefresh: transactions-under-lock → balances → snapshot),
      // persists per-stage RefreshEndpointResults, and derives completion —
      // identical lifecycle to manual refresh. Cron's provider work, lock scope,
      // skip/fail counting, and per-item isolation are unchanged.
      const outcome = await runFullRefresh<CronItemOutcome>(
        { itemId: item.id, trigger: "CRON", profile: "FULL_REFRESH" },
        { refresh: ({ recorder, runId }) => runCronItemRefresh(item.id, recorder, runId) },
      );
      if (outcome.skippedLocked) {
        skipped++;
        console.log(`[sync-banks] ${item.institutionName}: skipped — sync already in progress elsewhere`);
      } else {
        succeeded++;
        if (outcome.added || outcome.modified || outcome.removed) {
          console.log(
            `[sync-banks] ${item.institutionName}: +${outcome.added} ~${outcome.modified} -${outcome.removed}`
          );
        }

        // 2026-07-14 — ongoing self-heal for the "connect-time regen ran before
        // this item's transactions were fully available" gap (see
        // backgroundHistorySync.ts's A9 step, which already does this once at
        // connect). regenerateWealthHistory's account floor is now
        // earliest-real-Transaction based (regenerate-history.ts fix, same day),
        // so a re-run here after EVERY daily sync can pick up days it couldn't
        // before, with no manual re-run ever needed. Cheap best-effort no-op
        // when the flag is off or this item has no active-linked accounts.
        if (wealthRegenerationEnabled()) {
          try {
            const conns = await db.accountConnection.findMany({
              where:  { plaidItemDbId: item.id, deletedAt: null },
              select: { financialAccountId: true },
            });
            const faIds = conns.map((c) => c.financialAccountId);
            if (faIds.length > 0) {
              const { fromDate, toDate } = recentWealthWindow();
              await regenerateWealthHistoryForAccounts(faIds, { fromDate, toDate });
            }
          } catch (e) {
            console.warn(`[sync-banks] wealth-history regen failed for "${item.institutionName}" (PlaidItem ${item.id}) (non-fatal):`, e);
          }
        }
      }
    } catch (e) {
      failed++;
      console.error(`[sync-banks] failed for institution "${item.institutionName}" (PlaidItem ${item.id}):`, redactedErrorForLog(e));
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
