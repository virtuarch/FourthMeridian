/**
 * jobs/sync-banks.ts
 *
 * OPS-001 / OPS-010 (2026-10-22): the sweep is BUDGETED. Items are taken
 * oldest-first (never-synced, then lastSyncedAt ascending), an Item is only
 * started while SYNC_BANKS_PER_ITEM_RESERVE_MS of the SYNC_BANKS_BUDGET_MS
 * budget remains, and the rest are reported as `deferred`. The registry marks
 * this job `selfContinues`, so the dispatcher re-runs it CONTINUATION_DELAY_MS
 * after a run that deferred work — the tail of the list no longer starves
 * every day at the same cut-off. A running Plaid sync cannot be safely
 * abandoned (it holds the Item lease and writes pages), so the per-Item
 * deadline is enforced by the start reserve and REPORTED (`slowItems`), not by
 * killing the call; the transport timeout is OPS-004 (Agent E, lib/plaid/client.ts).
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
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";
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
  /** OPS-001 — Items not started because the budget ran out; the continuation picks them up. */
  deferred: number;
  /** Items skipped because they synced within SYNC_BANKS_RECENT_MS. */
  fresh: number;
  /** OPS-010 — Items that exceeded SYNC_BANKS_ITEM_DEADLINE_MS. */
  slowItems: number;
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
    console.warn(`[sync-banks] balance/snapshot freshness failed for PlaidItem ${itemId} (non-fatal):`, redactedErrorForLog(e));
  }

  return { skippedLocked: false, added: tx.added, modified: tx.modified, removed: tx.removed };
}

/** OPS-001 — the sweep's wall-clock budget inside the 300 s cron lambda (leaves headroom for siblings and regen). */
export const SYNC_BANKS_BUDGET_MS = 180_000;
/** OPS-010 — an Item is only STARTED when at least this much budget remains (a sync cannot be safely abandoned mid-flight). */
export const SYNC_BANKS_PER_ITEM_RESERVE_MS = 45_000;
/** An Item that took longer than this is reported as slow (the per-Item deadline, observed — see header). */
export const SYNC_BANKS_ITEM_DEADLINE_MS = 60_000;
/** Items successfully synced this recently (webhook, manual, an earlier slice) are not re-synced by the sweep. */
export const SYNC_BANKS_RECENT_MS = 2 * 3_600_000;

export interface SyncBanksCandidate {
  id: string;
  institutionName: string;
  investmentsConsent: PlaidInvestmentsConsent | null;
  encryptedToken: string;
  lastSyncedAt: Date | null;
}

export interface SyncBanksDeps {
  /** Test injection seams — production callers pass none of these. */
  loadItems?: () => Promise<SyncBanksCandidate[]>;
  admit?: () => Promise<Pick<StampedAdmissionVerdict, "decision" | "reason">>;
  processItem?: (item: SyncBanksCandidate) => Promise<"succeeded" | "failed" | "skipped">;
  clock?: () => number;
  budgetMs?: number;
}

/**
 * OPS-001 / OPS-010 — oldest-first, budgeted, resumable order. Never-synced
 * Items first, then by lastSyncedAt ascending, id as the tie-break; Items
 * synced within SYNC_BANKS_RECENT_MS are dropped (already fresh).
 */
export function syncBanksOrder(items: readonly SyncBanksCandidate[], now: number): SyncBanksCandidate[] {
  const t = (d: Date | null) => (d ? d.getTime() : -Infinity);
  return items
    .filter((i) => i.lastSyncedAt === null || now - i.lastSyncedAt.getTime() >= SYNC_BANKS_RECENT_MS)
    .sort((a, b) => (t(a.lastSyncedAt) - t(b.lastSyncedAt)) || a.id.localeCompare(b.id));
}

async function loadSyncBanksItems(): Promise<SyncBanksCandidate[]> {
  return db.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE, user: { deactivatedAt: null } },
    select: { id: true, institutionName: true, investmentsConsent: true, encryptedToken: true, lastSyncedAt: true },
  });
}

export async function syncBanks(deps: SyncBanksDeps = {}): Promise<SyncBanksResult> {
  const clock = deps.clock ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? SYNC_BANKS_BUDGET_MS;
  const start = clock();
  const all = await (deps.loadItems ?? loadSyncBanksItems)();
  const items = syncBanksOrder(all, start);
  const fresh = all.length - items.length;

  if (items.length === 0) return { succeeded: 0, failed: 0, skipped: 0, total: all.length, eventItems: 0, deferred: 0, fresh, slowItems: 0 };

  // PRE-BETA-OPS-CLOSE — the platform-wide admission gate (unchanged).
  const admission = await (deps.admit ?? (() => admitOperationalWork({ work: "REFRESH_EXECUTION" })))();
  if (admission.decision === "DENY") {
    console.log(
      `[sync-banks] ${items.length} item(s) eligible but NOT ADMITTED — ${admission.reason}; ` +
        "no provider call, no lock claimed, no item marked.",
    );
    return { succeeded: 0, failed: 0, skipped: 0, total: all.length, eventItems: 0, deferred: items.length, fresh, slowItems: 0, notAdmitted: admission.reason! };
  }

  const counters = { succeeded: 0, failed: 0, skipped: 0, eventItems: 0 };
  const processItem = deps.processItem ?? ((item: SyncBanksCandidate) => syncOneBankItem(item, counters));
  let deferred = 0;
  let slowItems = 0;

  for (let i = 0; i < items.length; i++) {
    // OPS-001 — stop STARTING Items once the remaining budget cannot cover one.
    // The rest are reported as `deferred`; the dispatcher re-runs this job
    // after CONTINUATION_DELAY_MS (registry fact `selfContinues`), and the
    // oldest-first order puts them at the head of that run.
    if (clock() - start > budgetMs - SYNC_BANKS_PER_ITEM_RESERVE_MS) {
      deferred = items.length - i;
      console.log(`[sync-banks] budget of ${budgetMs} ms nearly spent; ${deferred} item(s) deferred to the continuation.`);
      break;
    }
    const item = items[i];
    const t0 = clock();
    const outcome = await processItem(item);
    const ms = clock() - t0;
    if (ms > SYNC_BANKS_ITEM_DEADLINE_MS) {
      slowItems++;
      console.warn(`[sync-banks] ${item.institutionName} (PlaidItem ${item.id}) exceeded the per-item deadline: ${ms} ms`);
    }
    if (deps.processItem) counters[outcome]++;
  }

  console.log(`[sync-banks] complete — ${counters.succeeded} succeeded, ${counters.failed} failed, ${counters.skipped} skipped, ${deferred} deferred, ${fresh} fresh, ${all.length} total, ${counters.eventItems} event-ingest`);
  return { ...counters, total: all.length, deferred, fresh, slowItems };
}

/** One Item's cron refresh — the pre-OPS-001 loop body, verbatim in behaviour. Never throws. */
async function syncOneBankItem(
  item: SyncBanksCandidate,
  counters: { succeeded: number; failed: number; skipped: number; eventItems: number },
): Promise<"succeeded" | "failed" | "skipped"> {
  const eventsOn = investmentEventsEnabled();
  let outcomeKind: "succeeded" | "failed" | "skipped" = "succeeded";
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
      counters.skipped++; outcomeKind = "skipped";
      console.log(`[sync-banks] ${item.institutionName}: skipped — sync already in progress elsewhere`);
    } else {
      counters.succeeded++;
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
          console.warn(`[sync-banks] wealth-history regen failed for "${item.institutionName}" (PlaidItem ${item.id}) (non-fatal):`, redactedErrorForLog(e));
        }
      }
    }
  } catch (e) {
    counters.failed++; outcomeKind = "failed";
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
      // RLS-C-S8 — a cron job's authority, stated at the call site. `db` and
      // not `systemDb` only because the Plaid surface's split-authority slice
      // owns that move; the parameter now makes it a one-line change.
      await ingestInvestmentEvents(db, { accessToken, plaidItemId: item.id, now: new Date() });
      counters.eventItems++;
    } catch (evErr) {
      console.warn(`[sync-banks] investment event ingestion failed for "${item.institutionName}" (PlaidItem ${item.id}) (non-fatal):`, redactedErrorForLog(evErr));
    }
  }
  return outcomeKind;
}
