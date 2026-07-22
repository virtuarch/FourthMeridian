/**
 * lib/plaid/refresh.ts
 *
 * One reusable refresh pipeline for an existing Plaid connection. Designed
 * to be the single call site for:
 *  - the manual "Refresh" button (app/api/plaid/refresh/route.ts)
 *  - a future daily cron job
 *  - a future webhook handler (SYNC_UPDATES_AVAILABLE, etc.)
 *
 * Refreshes, in order:
 *  1. Balances/account metadata (accountsGet) — exact plaidAccountId match
 *     only. Never creates or restores a FinancialAccount; an account with no
 *     match (or one that's soft-deleted) is skipped, not relinked. Relink/
 *     restore-on-reconnect is a separate concern owned by
 *     app/api/plaid/exchange-token/route.ts + lib/accounts/reconcile.ts —
 *     refresh never touches that path.
 *  2. Investment holdings (investmentsHoldingsGet), for items with any
 *     investment-type accounts — reconciled through syncCurrentHoldings
 *     (insert new / update-in-place / remove-stale, in one transaction), NOT
 *     the old destructive deleteMany→recreate; cross-referenced via
 *     ProviderAccountIdentity with the legacy FinancialAccount.plaidAccountId
 *     fallback (D11: Holding is now FK'd to FinancialAccount directly).
 *     Consent-gated: skipped (and
 *     PlaidItem.investmentsConsent maintained) when the Item lacks
 *     Investments consent, so ADDITIONAL_CONSENT_REQUIRED is never hit
 *     repeatedly — see lib/plaid/investmentsConsent.ts.
 *  3. Transactions, via the existing syncTransactionsForItem() — untouched,
 *     reused as-is so sync logic is never duplicated.
 *  4. SpaceSnapshot regeneration for every space this item's
 *     accounts are shared into (lib/snapshots/regenerate.ts). This is the
 *     fix for the Cash History / Banking History charts: they read
 *     SpaceSnapshot exclusively, and nothing in production wrote that
 *     table before this step existed — only prisma/seed.ts did.
 *
 * Does not create AccountConnection or WorkspaceAccountShare rows — those
 * are established once at Link time and are not part of a refresh.
 */

import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
// PROV-2 — shared owners: Plaid type→AccountType mapping and the identity→legacy
// account resolver (was a private mapAccountType copy + two inline lookups here).
import { mapAccountType } from "@/lib/plaid/account-type";
// PROV-3 — the shared investments-ingest orchestration (was inline here).
import { syncInvestmentsForItem } from "@/lib/plaid/sync-investments";
import { resolvePlaidAccountByExternalId } from "@/lib/accounts/reconcile";
import { AccountType, PlaidItemStatus, ShareStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { evaluateReconciliation } from "@/lib/plaid/reconcile-core";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { regenerateSnapshotsForAccounts, regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";
import { emitDomainEvent } from "@/lib/events/emit";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { classifyPlaidErrorForHealth, redactedErrorForLog } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { withPlaidRetry } from "@/lib/plaid/retry";

// ── M2 — balance↔transaction reconciliation helpers ──────────────────────────

/**
 * Which accounts can be reconciled safely (balance movement ≈ transaction sum).
 * Cash (checking/savings) and revolving credit cards only. Investments/crypto
 * move with the market, and manual/other + non-card debt (loans, amortization)
 * are not transaction-driven → excluded to avoid false positives.
 */
function reconcileKind(fa: {
  type: string;
  debtSubtype: string | null;
  creditLimit: number | null;
}): "cash" | "card" | null {
  if (fa.type === "checking" || fa.type === "savings") return "cash";
  if (fa.type === "debt" && (fa.debtSubtype === "credit_card" || (fa.debtSubtype == null && fa.creditLimit != null))) {
    return "card";
  }
  return null;
}

/** Sum of non-deleted transaction amounts per FinancialAccount (FM signed). */
async function txnSumByAccount(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.transaction.groupBy({
    by: ["financialAccountId"],
    // SAME-BASIS INVARIANT — posted-only (`pending: false`), matching the basis
    // of the balance this sum is compared against. `FinancialAccount.balance` is
    // written from Plaid's `balances.current`, which does NOT include pending
    // activity — the same statement the snapshot system makes about it
    // (regenerate-history.ts, accounts-asof.ts, backfill.ts all filter
    // `pending: false` for exactly this reason).
    //
    // Before PRE-V26-PLAID-CLOSE Phase 2 this sum was pending-INCLUSIVE while
    // the balance was posted-only, so the two sides measured different things.
    // Every pending→posted transition then produced a spurious mismatch equal to
    // the posted amount: the sum did not move (the row was already counted while
    // pending) but the balance did. Both observed BALANCE_TX_MISMATCH events in
    // this database were exactly that artifact — see reconcile-core.test.ts,
    // which replays them and shows both resolve to a mismatch of 0.
    //
    // This does NOT weaken the detector: a genuinely missing POSTED transaction
    // still moves the balance without moving this sum, which is the July-2 class
    // the check was built to catch.
    where: { financialAccountId: { in: ids }, deletedAt: null, pending: false },
    _sum: { amount: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) if (r.financialAccountId) m.set(r.financialAccountId, r._sum.amount ?? 0);
  return m;
}

export interface RefreshItemResult {
  plaidItemId:           string;
  institution:           string;
  ok:                     boolean;
  accountsUpdated:        number;
  holdingsUpdated:        number;
  transactionsAdded:      number;
  transactionsModified:   number;
  transactionsRemoved:    number;
  /** Space ids whose SpaceSnapshot row was regenerated (today's date). */
  spacesSnapshotted:  string[];
  /**
   * FinancialAccount ids whose balance was updated this refresh. Optional/
   * additive. Populated by refreshPlaidItem; used by refreshAllActiveItemsForUser
   * to regenerate each affected Space ONCE after all items complete (snapshot
   * orchestration fix — avoids per-institution partial snapshots).
   */
  updatedAccountIds?: string[];
  error?:                 string;
  /**
   * D2 Step 7B — set instead of calling Plaid when this item is on the
   * manual-refresh cooldown. F1 (2026-07-14) adds "in-flight": another sync
   * already held this item's syncLockedAt guard, so this refresh was skipped
   * rather than racing it (see lib/plaid/sync-lock.ts).
   */
  skipped?:               "cooldown" | "in-flight";
  /** D2 Step 7B — only set when skipped === "cooldown". */
  retryAfterSeconds?:     number;
}

interface ReconcileTarget { id: string; type: string; kind: "cash" | "card"; balanceBefore: number; balanceAfter: number }
type AccountsGetData = Awaited<ReturnType<typeof plaidClient.accountsGet>>["data"];

export interface ItemBalanceRefresh {
  item:              NonNullable<Awaited<ReturnType<typeof db.plaidItem.findUnique>>>;
  accessToken:       string;
  plaidAccounts:     AccountsGetData["accounts"];
  itemData:          AccountsGetData["item"];
  accountsUpdated:   number;
  updatedAccountIds: string[];
  reconcileTargets:  ReconcileTarget[];
}

/**
 * CONN-3 — THE single balance-refresh authority (extracted from refreshPlaidItem;
 * behavior-preserving). accountsGet → write FinancialAccount.balance +
 * availableBalance + creditLimit + balanceLastUpdatedAt + lastUpdated (the
 * balance-VERIFIED stamp) + syncStatus. Never creates/restores/relinks an account
 * (soft-deleted / unmatched accounts are skipped). Reused by refreshPlaidItem
 * (manual Refresh) AND the background freshness paths (webhook, cron) so current
 * balances become fresh on routine syncs — one authority, no duplicated accountsGet.
 *
 * @param plaidItemDbId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function refreshBalancesForItem(plaidItemDbId: string): Promise<ItemBalanceRefresh> {
  const item = await db.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) {
    throw new Error(`refreshBalancesForItem: PlaidItem ${plaidItemDbId} not found`);
  }
  const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);

  let accountsUpdated = 0;
  const updatedAccountIds: string[] = [];
  // M2 — per-account balance before/after for cash/card reconciliation (used by
  // refreshPlaidItem only; carried through so the manual path is unchanged).
  const reconcileTargets: ReconcileTarget[] = [];
  const accountsRes = await withPlaidRetry(
    () => plaidClient.accountsGet({ access_token: accessToken }),
    "accountsGet",
  );
  const plaidAccounts = accountsRes.data.accounts;

  for (const acct of plaidAccounts) {
    // PROV-2 — canonical identity→legacy resolve. Refresh SKIPS soft-deleted
    // matches: never restore or create during a refresh (relink owns that).
    const fa = await resolvePlaidAccountByExternalId(acct.account_id);
    if (!fa || fa.deletedAt) continue;

    const availableBalance = acct.balances.available ?? undefined;
    const creditLimit       = acct.balances.limit ?? undefined;
    // D4 Balance Freshness Provenance — Plaid's institution-side balance time
    // (AccountBalance.last_updated_datetime). Distinct from lastUpdated below,
    // which is Fourth Meridian's write time. Always overwritten (incl. null) so
    // the stored value reflects exactly what Plaid returned on this call.
    const balanceLastUpdatedAt = acct.balances.last_updated_datetime
      ? new Date(acct.balances.last_updated_datetime)
      : null;

    await db.financialAccount.update({
      where: { id: fa.id },
      data: {
        // Fall back to the existing balance rather than 0 on a transient null.
        balance: acct.balances.current ?? fa.balance,
        availableBalance,
        ...(creditLimit !== undefined && { creditLimit }),
        balanceLastUpdatedAt,
        lastUpdated: new Date(), // ← balance-verified stamp
        syncStatus:  "synced",
      },
    });
    accountsUpdated++;
    updatedAccountIds.push(fa.id);

    const rk = reconcileKind(fa);
    if (rk) {
      reconcileTargets.push({
        id:            fa.id,
        type:          fa.type,
        kind:          rk,
        balanceBefore: fa.balance,                          // stored (pre-update) balance
        balanceAfter:  acct.balances.current ?? fa.balance, // fresh balance just written
      });
    }
  }

  return { item, accessToken, plaidAccounts, itemData: accountsRes.data.item, accountsUpdated, updatedAccountIds, reconcileTargets };
}

/**
 * Refreshes a single PlaidItem: balances, then holdings, then transactions.
 * Safe to call repeatedly — every step is idempotent (update-only balance
 * writes against existing accounts, syncCurrentHoldings insert/update/remove-stale
 * holdings reconciliation, cursor-based transaction upsert).
 *
 * @param plaidItemDbId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function refreshPlaidItem(
  plaidItemDbId: string,
  opts?: { deferSnapshot?: boolean },
): Promise<RefreshItemResult> {
  // ── 1. Balances / account metadata — the ONE balance authority (CONN-3) ───
  const { item, accessToken, plaidAccounts, itemData, accountsUpdated, updatedAccountIds, reconcileTargets } =
    await refreshBalancesForItem(plaidItemDbId);

  // ── 2. Investment holdings ──────────────────────────────────────────────
  // Best-effort/non-fatal — an institution with no investment accounts, or a
  // transient Plaid error here, should never block balances/transactions.
  // PROV-3: identical ingest to exchangeToken via syncInvestmentsForItem. The
  // primitive derives + change-detects consent (self-heals to ENABLED after the
  // user grants consent via Link update mode), and skips the holdings call when
  // the item is known to lack consent so ADDITIONAL_CONSENT_REQUIRED is never
  // hit repeatedly.
  const investmentPlaidAccounts = plaidAccounts.filter(
    (a) => mapAccountType(a.type, a.subtype) === AccountType.investment
  );
  const investmentsResult = await syncInvestmentsForItem({
    accessToken,
    plaidItemId:     plaidItemDbId,
    institutionName: item.institutionName,
    investmentAccounts: investmentPlaidAccounts,
    item:            itemData,
    storedConsent:   item.investmentsConsent,
  });
  const holdingsUpdated = investmentsResult.holdingsSynced;

  // ── 3. Transactions ──────────────────────────────────────────────────────
  // Reuses the existing cursor-based sync as-is — no duplicated logic.
  // M2 — snapshot the reconcilable accounts' transaction sums BEFORE the sync
  // so we can diff how much this sync changed them.
  const reconcileIds = reconcileTargets.map((t) => t.id);
  const txnSumBefore = await txnSumByAccount(reconcileIds);

  // PRE-BETA-OPS-CLOSE Phase 2 — PARTIAL CONVERGENCE IS EXPLICIT HERE.
  //
  // This call THROWS (PlaidSyncIncompleteError) when a page could not be fully
  // persisted, and that throw is deliberately NOT caught:
  //
  //   • Everything below — the balance↔transaction reconciliation and the
  //     SpaceSnapshot regeneration — is SKIPPED, on purpose.
  //   • `syncIncompleteAt` stays set, so the item reads as "importing", the
  //     client auto-resume and the daily cron keep retrying it, and Platform Ops
  //     reports it as stalled (lib/platform/stall-projection.ts).
  //   • The caller records the failure (runDeferredHistorySync stamps health,
  //     refreshAllActiveItemsForUser records ok:false). Re-catching it here would
  //     only duplicate that contract — or worse, downgrade it to success.
  //
  // Why skipping is CORRECT rather than merely convenient:
  //   • Reconciliation compares a balance delta against a transaction-sum delta.
  //     With transactions knowingly incomplete it would fire a
  //     BALANCE_TX_MISMATCH describing a gap we already recorded, with less
  //     precision — noise on top of a known incident.
  //   • Snapshot regeneration would bake the fresh balance into HISTORY without
  //     the transactions that explain it, mixing bases in the one place the
  //     posted-basis invariant forbids it.
  //
  // The honest consequence, stated plainly: balances were already written at
  // step 1, so FinancialAccount.balance can be NEWER than this item's
  // transactions and its last converged snapshot until a later sync succeeds.
  // That is not corruption — the balance is true; it is provider truth arriving
  // on two endpoints with independent freshness, which Plaid does not offer
  // atomically. Ordering is therefore NOT changed. What that state requires is
  // DISCLOSURE on the surfaces that mix the two (see the sync-incomplete trust
  // warning in lib/perspectives/envelope.ts).
  const txSync = await syncTransactionsForItem(plaidItemDbId);

  // ── 3b. Balance↔transaction reconciliation (M2) ──────────────────────────
  // For cash/card accounts, the balance movement this refresh should be
  // explained by the net transaction change this sync (cash: +Σamount; card
  // owed: −Σamount). A gap beyond threshold means the balance moved without
  // matching transactions (e.g. the July-2 pending→posted loss). Flag only —
  // best-effort; never fails the refresh; no replay.
  try {
    if (reconcileTargets.length > 0) {
      const txnSumAfter = await txnSumByAccount(reconcileIds);
      for (const t of reconcileTargets) {
        // Phase 2 — the arithmetic now lives in the pure reconcile core so the
        // rule is testable against real recorded incidents. Both sums are
        // posted-only (see txnSumByAccount), matching the balance's basis.
        const v = evaluateReconciliation({
          kind:            t.kind,
          balanceBefore:   t.balanceBefore,
          balanceAfter:    t.balanceAfter,
          postedSumBefore: txnSumBefore.get(t.id) ?? 0,
          postedSumAfter:  txnSumAfter.get(t.id) ?? 0,
        });
        if (v.mismatched) {
          console.warn(
            `[reconcile] BALANCE_TX_MISMATCH account ${t.id} (${t.type}) — balanceDelta=${v.balanceDelta.toFixed(2)} expected=${v.expected.toFixed(2)} mismatch=${v.mismatch.toFixed(2)} > threshold=${v.threshold.toFixed(2)}`
          );
          await recordSyncIssue({
            kind:               "BALANCE_TX_MISMATCH",
            plaidItemId:        plaidItemDbId,
            financialAccountId: t.id,
            // `basis` records WHICH rule produced this row, so a future reader
            // can tell a post-Phase-2 finding from the pending-inclusive legacy
            // events already in the table.
            detail:             { accountType: t.type, kind: t.kind, basis: "posted", balanceDelta: v.balanceDelta, txnSumDelta: v.txnSumDelta, expected: v.expected, mismatch: v.mismatch, threshold: v.threshold },
          }, db);
        }
      }
    }
  } catch (reconErr) {
    console.error(`[reconcile] balance↔transaction reconciliation failed for item ${plaidItemDbId} (non-fatal):`, reconErr);
  }

  // ── 4. SpaceSnapshot regeneration ───────────────────────────────────
  // Recomputes today's snapshot row for every space these accounts are
  // shared into, from the now-fresh FinancialAccount balances. This is what
  // the Cash History / Banking History / Net Worth charts actually read —
  // see lib/snapshots/regenerate.ts for why this step exists.
  //
  // Orchestration fix: when opts.deferSnapshot is set (the all-items refresh
  // path), SKIP the per-item regeneration and let the caller regenerate each
  // affected Space ONCE after every institution has finished — otherwise a
  // regenerate here reads the full Space while OTHER institutions are still
  // stale, persisting a partial-balance snapshot (see
  // D2X_LIVE_SNAPSHOT_PARTIAL_REFRESH_INVESTIGATION.md). Direct single-item
  // callers (no opts) keep regenerating once here, as before.
  const spacesSnapshotted = opts?.deferSnapshot
    ? []
    : await regenerateSnapshotsForAccounts(updatedAccountIds);

  // ── EV-1 Slice 4 — ConnectionSynced (audit-only) ────────────────────────
  // Records a canonical PLAID_REFRESH audit row now that the sync (incl. the
  // snapshot fan-out above) has succeeded. Emitted best-effort AFTER the
  // fan-out and wrapped so an audit-insert failure can never fail a refresh
  // that already succeeded. No handler is registered for ConnectionSynced, so
  // this does not touch the snapshot fan-out, the return value, or error
  // semantics.
  try {
    await emitDomainEvent({
      type:        "ConnectionSynced",
      actorUserId: item.userId,
      payload: {
        provider:          "PLAID",
        plaidItemId:       plaidItemDbId,
        accountsUpdated,
        spacesSnapshotted: spacesSnapshotted.length,
      },
    });
  } catch (auditErr) {
    console.warn(`[refreshPlaidItem] ConnectionSynced audit failed for item ${plaidItemDbId} (non-fatal):`, auditErr);
  }

  return {
    plaidItemId:          plaidItemDbId,
    institution:          item.institutionName,
    ok:                   true,
    accountsUpdated,
    holdingsUpdated,
    transactionsAdded:    txSync.added,
    transactionsModified: txSync.modified,
    transactionsRemoved:  txSync.removed,
    spacesSnapshotted,
    updatedAccountIds,
  };
}

/**
 * Snapshot orchestration fix — regenerate each affected Space exactly ONCE
 * after an all-items refresh, from the fully-refreshed account set, EXCLUDING
 * any Space touched by an item that failed this run (its balances are stale,
 * so a full-set read would persist a partial snapshot). Spaces with no failed
 * item are regenerated once each. Never throws for a single space failure.
 *
 * @param succeededAccountIds  union of updatedAccountIds from items that refreshed OK
 * @param failedItemIds        PlaidItem ids that threw this run
 * @returns the Space ids actually regenerated
 */
async function regenerateCompletedSpaces(
  succeededAccountIds: string[],
  failedItemIds: string[],
): Promise<string[]> {
  if (succeededAccountIds.length === 0) return [];

  // Candidate Spaces — any Space linked to a successfully-refreshed account.
  const candidateLinks = await db.spaceAccountLink.findMany({
    where:  { financialAccountId: { in: succeededAccountIds }, status: ShareStatus.ACTIVE },
    select: { spaceId: true },
  });
  let candidateSpaceIds = new Set(candidateLinks.map((l) => l.spaceId));

  // Tarnished Spaces — linked to any failed item's accounts. Excluded so a
  // knowingly-partial same-day snapshot is never persisted for them.
  if (failedItemIds.length > 0 && candidateSpaceIds.size > 0) {
    const failedConns = await db.accountConnection.findMany({
      where:  { plaidItemDbId: { in: failedItemIds }, deletedAt: null },
      select: { financialAccountId: true },
    });
    const failedFaIds = failedConns.map((c) => c.financialAccountId);
    if (failedFaIds.length > 0) {
      const tarnishedLinks = await db.spaceAccountLink.findMany({
        where:  { financialAccountId: { in: failedFaIds }, status: ShareStatus.ACTIVE },
        select: { spaceId: true },
      });
      const tarnished = new Set(tarnishedLinks.map((l) => l.spaceId));
      candidateSpaceIds = new Set([...candidateSpaceIds].filter((id) => !tarnished.has(id)));
    }
  }

  const spaceIds = [...candidateSpaceIds];
  await Promise.all(spaceIds.map((id) => regenerateSpaceSnapshot(id)));
  return spaceIds;
}

export interface RefreshSummary {
  results:                    RefreshItemResult[];
  itemCount:                  number;
  totalAccountsUpdated:       number;
  totalHoldingsUpdated:       number;
  totalTransactionsAdded:     number;
  totalTransactionsModified:  number;
  totalTransactionsRemoved:   number;
  /** Distinct space ids whose SpaceSnapshot row was regenerated. */
  spacesSnapshotted:      string[];
}

/**
 * Lifecycle fix — docs/bugfixes/BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS.md,
 * Step C.
 *
 * True if this PlaidItem has at least one live AccountConnection pointing at
 * a FinancialAccount that is not archived. False means every account this
 * item was ever linked to has since been archived (most commonly via
 * duplicate reconciliation — see lib/accounts/reconcile.ts's Step A, which
 * closes this gap going forward for new merges) — there is nothing left for
 * a refresh to update, and calling Plaid for it only produces a
 * "[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit"
 * warning with no useful write behind it.
 */
async function hasActiveLinkedAccount(plaidItemDbId: string): Promise<boolean> {
  const count = await db.accountConnection.count({
    where: {
      plaidItemDbId,
      deletedAt: null,
      financialAccount: { deletedAt: null },
    },
  });
  return count > 0;
}

/**
 * Self-heals a PlaidItem found to have zero active linked accounts: closes
 * out any AccountConnection rows still marked live (deletedAt: null) — there
 * should be none left after reconcile.ts's Step A fix, but data orphaned
 * before that fix shipped can still reach this path once — then disconnects
 * the PlaidItem if that leaves it with zero live connections, via the same
 * disconnectPlaidItemIfOrphaned used by app/api/accounts/[id]/route.ts's
 * DELETE handler. Once this runs, the item drops out of the
 * `status: ACTIVE` query below on every later call, so this is a one-time
 * cost per orphaned item, not a per-refresh cost.
 */
async function selfHealOrphanedPlaidItem(plaidItemDbId: string): Promise<void> {
  await db.accountConnection.updateMany({
    where: { plaidItemDbId, deletedAt: null },
    data:  { deletedAt: new Date() },
  });
  await disconnectPlaidItemIfOrphaned(plaidItemDbId);
}

/**
 * Refreshes every active PlaidItem owned by the given user. One item's
 * failure (e.g. ITEM_LOGIN_REQUIRED) does not block the others — mirrors the
 * per-item try/catch pattern in app/api/plaid/sync/route.ts.
 *
 * Step C guard — an item with zero active linked accounts is skipped before
 * ever calling Plaid (self-healed instead, see selfHealOrphanedPlaidItem).
 * Items with at least one active linked account are completely unaffected:
 * the try/catch below is untouched, so real per-item Plaid failures
 * (ITEM_LOGIN_REQUIRED, INVALID_ACCESS_TOKEN, permissions errors, etc.) are
 * never suppressed.
 *
 * D2 Step 7B — `options.excludeItemIds` lets the caller (the manual refresh
 * route) keep items on the manual-refresh cooldown out of this query
 * entirely, so they're never passed to Plaid. Cooldown itself is decided and
 * marked by the caller (lib/plaid/refreshCooldown.ts) — this function only
 * honors the exclusion list; it has no cooldown logic of its own.
 */
export async function refreshAllActiveItemsForUser(
  userId: string,
  options?: { excludeItemIds?: string[] }
): Promise<RefreshSummary> {
  const items = await db.plaidItem.findMany({
    where: {
      userId,
      status: PlaidItemStatus.ACTIVE,
      ...(options?.excludeItemIds?.length && { id: { notIn: options.excludeItemIds } }),
    },
    select: { id: true, institutionName: true },
  });

  const results: RefreshItemResult[] = [];
  let totalAccountsUpdated      = 0;
  let totalHoldingsUpdated      = 0;
  let totalTransactionsAdded    = 0;
  let totalTransactionsModified = 0;
  let totalTransactionsRemoved  = 0;

  // Orchestration fix — defer snapshots per item; regenerate each affected
  // Space ONCE after the loop from the fully-refreshed set (see
  // regenerateCompletedSpaces). Collect the union of successfully-updated
  // account ids and the ids of items that failed.
  const succeededAccountIds: string[] = [];
  const failedItemIds: string[] = [];

  for (const item of items) {
    if (!(await hasActiveLinkedAccount(item.id))) {
      // No active linked account left for this item — not a failure, just
      // done. Self-heal so it drops out of this query on every later call,
      // and skip straight to the next item without calling Plaid.
      await selfHealOrphanedPlaidItem(item.id);
      continue;
    }

    // F1 (2026-07-14) — same shared syncLockedAt guard the webhook/connect
    // pipeline uses (lib/plaid/sync-lock.ts), so the daily-cron-adjacent bulk
    // refresh path can never race a webhook/manual/cron sync against the same
    // item's cursor. A skip here isn't a failure — it's deferred to whichever
    // run is already in flight, so it's excluded from both succeededAccountIds
    // and failedItemIds (nothing to snapshot, nothing to mark unhealthy).
    try {
      const lockResult = await withPlaidItemSyncLock(item.id, () => refreshPlaidItem(item.id, { deferSnapshot: true }));
      if (!lockResult.ok) {
        results.push({
          plaidItemId:          item.id,
          institution:          item.institutionName,
          ok:                   false,
          accountsUpdated:      0,
          holdingsUpdated:      0,
          transactionsAdded:    0,
          transactionsModified: 0,
          transactionsRemoved:  0,
          spacesSnapshotted:    [],
          skipped:              "in-flight",
        });
        continue;
      }
      const r = lockResult.result;
      results.push(r);
      totalAccountsUpdated      += r.accountsUpdated;
      totalHoldingsUpdated      += r.holdingsUpdated;
      totalTransactionsAdded    += r.transactionsAdded;
      totalTransactionsModified += r.transactionsModified;
      totalTransactionsRemoved  += r.transactionsRemoved;
      succeededAccountIds.push(...(r.updatedAccountIds ?? []));
    } catch (e) {
      console.error(`[refreshAllActiveItemsForUser] refresh failed for PlaidItem ${item.id}:`, redactedErrorForLog(e));
      failedItemIds.push(item.id);
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        // CH-2 — writes the live columns (unchanged) + a durable transition row
        // only when the effective state actually changed.
        await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(item.id);
      }
      results.push({
        plaidItemId:          item.id,
        institution:          item.institutionName,
        ok:                   false,
        accountsUpdated:      0,
        holdingsUpdated:      0,
        transactionsAdded:    0,
        transactionsModified: 0,
        transactionsRemoved:  0,
        spacesSnapshotted: [],
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  // Regenerate once per affected Space after ALL institutions are done,
  // excluding any Space touched by a failed item (best-effort; never fails the
  // refresh). This replaces the per-item regeneration removed above.
  let snapshottedSpaceIds: string[] = [];
  try {
    snapshottedSpaceIds = await regenerateCompletedSpaces(succeededAccountIds, failedItemIds);
  } catch (snapErr) {
    console.error("[refreshAllActiveItemsForUser] post-loop snapshot regeneration failed (non-fatal):", snapErr);
  }

  return {
    results,
    itemCount: items.length,
    totalAccountsUpdated,
    totalHoldingsUpdated,
    totalTransactionsAdded,
    totalTransactionsModified,
    totalTransactionsRemoved,
    spacesSnapshotted: snapshottedSpaceIds,
  };
}
