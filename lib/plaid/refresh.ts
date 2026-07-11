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
 *     investment-type accounts — same delete-then-recreate approach as
 *     exchange-token's initial import, cross-referenced via
 *     FinancialAccount.plaidAccountId (D11: Holding is now FK'd to
 *     FinancialAccount directly). Consent-gated: skipped (and
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
import { AccountType, PlaidInvestmentsConsent, PlaidItemStatus, ProviderType, ShareStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { regenerateSnapshotsForAccounts, regenerateSpaceSnapshot } from "@/lib/snapshots/regenerate";
import { emitDomainEvent } from "@/lib/events/emit";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { classifyPlaidErrorForHealth, getPlaidErrorCode, plaidErrorSummary } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { withPlaidRetry } from "@/lib/plaid/retry";
import { deriveInvestmentsConsent } from "@/lib/plaid/investmentsConsent";
import { capturePositionObservations, investmentObservationsEnabled } from "@/lib/investments/position-capture";
import { syncCurrentHoldings } from "@/lib/investments/sync-current-holdings";
import { ingestInvestmentEvents, investmentEventsEnabled } from "@/lib/investments/investment-event-ingest";

// Mirrors app/api/plaid/exchange-token/route.ts's mapAccountType — kept as a
// private copy here (not exported/shared) since refresh only needs it to
// decide which accounts are investment-type for the holdings step.
function mapAccountType(type: string, subtype: string | null | undefined): AccountType {
  switch (type) {
    case "depository":
      return subtype === "savings" || subtype === "money market" || subtype === "cd"
        ? AccountType.savings
        : AccountType.checking;
    case "investment":
      return subtype === "crypto exchange"
        ? AccountType.crypto
        : AccountType.investment;
    case "credit":
    case "loan":
      return AccountType.debt;
    default:
      return AccountType.other;
  }
}

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
    where: { financialAccountId: { in: ids }, deletedAt: null },
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
  /** D2 Step 7B — set instead of calling Plaid when this item is on the manual-refresh cooldown. */
  skipped?:               "cooldown";
  /** D2 Step 7B — only set when skipped === "cooldown". */
  retryAfterSeconds?:     number;
}

/**
 * Refreshes a single PlaidItem: balances, then holdings, then transactions.
 * Safe to call repeatedly — every step is idempotent (update-only balance
 * writes against existing accounts, delete+recreate holdings, cursor-based
 * transaction upsert).
 *
 * @param plaidItemDbId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function refreshPlaidItem(
  plaidItemDbId: string,
  opts?: { deferSnapshot?: boolean },
): Promise<RefreshItemResult> {
  const item = await db.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) {
    throw new Error(`refreshPlaidItem: PlaidItem ${plaidItemDbId} not found`);
  }

  const accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);

  // ── 1. Balances / account metadata ────────────────────────────────────────
  let accountsUpdated = 0;
  const updatedAccountIds: string[] = [];
  // M2 — per-account balance before/after for cash/card reconciliation.
  const reconcileTargets: Array<{ id: string; type: string; kind: "cash" | "card"; balanceBefore: number; balanceAfter: number }> = [];
  const accountsRes   = await withPlaidRetry(
    () => plaidClient.accountsGet({ access_token: accessToken }),
    "accountsGet"
  );
  const plaidAccounts = accountsRes.data.accounts;

  for (const acct of plaidAccounts) {
    // D2 Step 3E — resolved primarily via ProviderAccountIdentity (provider=
    // PLAID, externalAccountId=acct.account_id) rather than
    // FinancialAccount.plaidAccountId directly, with a fallback to the
    // legacy lookup if no identity row exists yet. Fallback-first, not a
    // hard replacement — mirrors Steps 3C/3D. See
    // docs/initiatives/d2/investigations/D2_STEP3A_PROVIDER_ACCOUNT_IDENTITY_READ_CUTOVER_INVESTIGATION.md.
    // D2 Step 1D — findFirst, not findUnique: see lib/accounts/reconcile.ts
    // for why (provider, externalAccountId) is no longer a named unique key).
    const plaidIdentity = await db.providerAccountIdentity.findFirst({
      where: { provider: ProviderType.PLAID, externalAccountId: acct.account_id },
      include: { financialAccount: true },
    });

    let fa = plaidIdentity?.financialAccount ?? null;
    if (!fa) {
      fa = await db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } });
      // Only warn for accounts still in active use — an archived (deletedAt
      // set) account hitting the legacy fallback is expected, not a coverage
      // gap worth investigating: it's the same account skipped two lines
      // below by the `if (!fa || fa.deletedAt) continue;` guard.
      if (fa && !fa.deletedAt) {
        console.warn(
          `[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${acct.account_id}. Coverage gap; investigate before removing fallback.`
        );
      }
    }

    // No match, or soft-deleted (removed by the user) — never restore or
    // create during a refresh. That only happens via relink (exchange-token).
    if (!fa || fa.deletedAt) continue;

    const availableBalance = acct.balances.available ?? undefined;
    const creditLimit       = acct.balances.limit ?? undefined;
    // D4 Balance Freshness Provenance — when Plaid says the institution last
    // refreshed this balance (AccountBalance.last_updated_datetime). Distinct
    // from lastUpdated below, which records when Fourth Meridian synced with
    // Plaid. Always overwritten on every refresh — including with null — so
    // the stored value faithfully represents what Plaid returned on this call,
    // not a cached historical value from a previous call.
    const balanceLastUpdatedAt = acct.balances.last_updated_datetime
      ? new Date(acct.balances.last_updated_datetime)
      : null;

    await db.financialAccount.update({
      where: { id: fa.id },
      data: {
        // Fall back to the existing balance rather than 0 if Plaid returns a
        // transient null — avoids zeroing out a real balance on a hiccup.
        balance: acct.balances.current ?? fa.balance,
        availableBalance,
        ...(creditLimit !== undefined && { creditLimit }),
        balanceLastUpdatedAt,
        lastUpdated: new Date(),
        syncStatus:  "synced",
      },
    });
    accountsUpdated++;
    updatedAccountIds.push(fa.id);

    // M2 — capture before/after balance for reconcilable account types.
    const rk = reconcileKind(fa);
    if (rk) {
      reconcileTargets.push({
        id:            fa.id,
        type:          fa.type,
        kind:          rk,
        balanceBefore: fa.balance,                         // stored (pre-update) balance
        balanceAfter:  acct.balances.current ?? fa.balance, // fresh balance just written
      });
    }
  }

  // ── 2. Investment holdings ──────────────────────────────────────────────
  // Best-effort/non-fatal — an institution with no investment accounts, or a
  // transient Plaid error here, should never block balances/transactions.
  let holdingsUpdated = 0;
  const investmentPlaidAccounts = plaidAccounts.filter(
    (a) => mapAccountType(a.type, a.subtype) === AccountType.investment
  );

  // Consent gate — derive from the accountsGet payload just fetched (free;
  // authoritative for DTM Items), falling back to the stored state for
  // pre-DTM Items whose metadata is inconclusive. Persisted on change, so
  // once an Item is known to lack consent the holdings call is skipped on
  // every later refresh instead of failing with ADDITIONAL_CONSENT_REQUIRED
  // each time. Re-derived every refresh → self-heals to ENABLED after the
  // user grants consent via Link update mode.
  let investmentsConsent: PlaidInvestmentsConsent | null = item.investmentsConsent;
  if (investmentPlaidAccounts.length > 0) {
    const derived = deriveInvestmentsConsent(accountsRes.data.item);
    if (derived !== null) {
      if (derived !== item.investmentsConsent) {
        await db.plaidItem.update({
          where: { id: plaidItemDbId },
          data:  { investmentsConsent: derived },
        });
        console.log(
          `[refreshPlaidItem] investmentsConsent ${item.investmentsConsent ?? "unknown"} → ${derived} for item ${plaidItemDbId} ("${item.institutionName}")`
        );
      }
      investmentsConsent = derived;
    }
  }
  // null = still unknown (pre-DTM Item, never probed) — attempt once below;
  // the outcome is persisted either way, so the probe never repeats.
  const holdingsCallable =
    investmentsConsent === null || investmentsConsent === PlaidInvestmentsConsent.ENABLED;

  if (investmentPlaidAccounts.length > 0 && holdingsCallable) {
    try {
      const holdingsRes      = await withPlaidRetry(
        () => plaidClient.investmentsHoldingsGet({ access_token: accessToken }),
        "investmentsHoldingsGet"
      );
      const { holdings, securities } = holdingsRes.data;
      const secById           = Object.fromEntries(securities.map((s) => [s.security_id, s]));

      for (const plaidAcct of investmentPlaidAccounts) {
        const acctHoldings = holdings.filter((h) => h.account_id === plaidAcct.account_id);
        if (!acctHoldings.length) continue;

        // D11 — Holding is now FK'd to FinancialAccount directly; cross-
        // reference via provider identity (D2 Step 3E), same pattern as the
        // balance lookup above, falling back to plaidAccountId if no
        // identity row exists yet — same as exchange-token's initial import.
        // D2 Step 1D — findFirst, not findUnique: see
        // lib/accounts/reconcile.ts for why (provider, externalAccountId) is
        // no longer a named unique key.
        // currency in both selects: MC1 Phase 0 Slice 2 — account-level
        // fallback for the per-holding currency stamp below.
        const holdingPlaidIdentity = await db.providerAccountIdentity.findFirst({
          where: { provider: ProviderType.PLAID, externalAccountId: plaidAcct.account_id },
          select: { financialAccount: { select: { id: true, currency: true } } },
        });

        let fa = holdingPlaidIdentity?.financialAccount ?? null;
        if (!fa) {
          // Selected via a separate variable (not assigned straight into
          // `fa`) so `deletedAt` is available to gate the warning below
          // without widening `fa`'s declared type beyond `{ id, currency }`.
          const legacyFa = await db.financialAccount.findUnique({
            where:  { plaidAccountId: plaidAcct.account_id },
            select: { id: true, currency: true, deletedAt: true },
          });
          // Only warn for accounts still in active use — an archived
          // account hitting the legacy fallback is expected, not a coverage
          // gap worth investigating.
          if (legacyFa && !legacyFa.deletedAt) {
            console.warn(
              `[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${legacyFa.id} externalAccountId=${plaidAcct.account_id}. Coverage gap; investigate before removing fallback.`
            );
          }
          fa = legacyFa;
        }
        if (!fa) continue; // never create — refresh only updates known accounts

        // A1 — dark-write append-only observation capture from the RAW payload
        // (incl. cash / no-ticker securities the Holding writer skips below).
        // Runs BEFORE the destructive Holding delete+recreate, gated behind the
        // kill switch, best-effort/non-fatal (writeBtcHolding precedent): a
        // capture failure must never affect balances/holdings/transactions.
        if (investmentObservationsEnabled()) {
          try {
            await capturePositionObservations({
              financialAccountId: fa.id,
              plaidHoldings:      acctHoldings,
              securitiesById:     secById,
              date:               new Date(),
              // Derived brokerage-cash reconciliation from the SAME refresh
              // payload (contemporaneous balance + holdings). Balance from the
              // investment account's own accountsGet balances.
              accountBalance:     plaidAcct.balances.current ?? null,
              accountCurrency:    plaidAcct.balances.iso_currency_code ?? null,
              balanceAsOf:        plaidAcct.balances.last_updated_datetime ? new Date(plaidAcct.balances.last_updated_datetime) : null,
              payloadComplete:    holdingsRes.data.is_investments_fallback_item !== true,
            });
          } catch (obsErr) {
            console.warn(
              `[refreshPlaidItem] position observation capture failed for account ${fa.id} (non-fatal): ${obsErr instanceof Error ? obsErr.message : obsErr}`
            );
          }
        }

        // A2 — stable per-holding sync (update-in-place / insert / remove-stale)
        // replaces the prior deleteMany+create. Runs AFTER observation capture
        // above; keeps Holding symbol-keyed and cash/no-ticker filtered. Removal
        // is gated on a complete payload.
        const syncCounts = await syncCurrentHoldings({
          financialAccountId: fa.id,
          plaidHoldings:      acctHoldings,
          securitiesById:     secById,
          accountCurrency:    fa.currency,
          payloadComplete:    holdingsRes.data.is_investments_fallback_item !== true,
        });
        holdingsUpdated += syncCounts.inserted + syncCounts.updated + syncCounts.unchanged;
      }

      // A3 — canonical investment event ingestion (once per Item; separate
      // investmentsTransactionsGet call). Runs AFTER holdings capture / cash
      // reconciliation / Holding sync, gated behind INVESTMENT_EVENTS_ENABLED,
      // isolated best-effort: a failure here never affects the holdings refresh
      // just completed. Consent is known good (holdings succeeded above).
      if (investmentEventsEnabled()) {
        try {
          await ingestInvestmentEvents({ accessToken, plaidItemId: plaidItemDbId, now: new Date() });
        } catch (evErr) {
          console.warn(
            `[refreshPlaidItem] investment event ingestion failed for item ${plaidItemDbId} (non-fatal): ${evErr instanceof Error ? evErr.message : evErr}`
          );
        }
      }

      // Unknown (pre-DTM) probe succeeded — remember it so the derivation
      // fallback above resolves without ambiguity on every later refresh.
      if (investmentsConsent === null) {
        await db.plaidItem.update({
          where: { id: plaidItemDbId },
          data:  { investmentsConsent: PlaidInvestmentsConsent.ENABLED },
        });
      }
    } catch (holdingsErr) {
      if (getPlaidErrorCode(holdingsErr) === "ADDITIONAL_CONSENT_REQUIRED") {
        // Expected for Items linked without Investments consent — not an
        // application error. Remember it so this call is skipped from now on
        // (until the user re-consents via Link update mode).
        await db.plaidItem.update({
          where: { id: plaidItemDbId },
          data:  { investmentsConsent: PlaidInvestmentsConsent.CONSENT_REQUIRED },
        });
        console.log(
          `[refreshPlaidItem] item ${plaidItemDbId} ("${item.institutionName}") lacks Investments consent — holdings skipped until granted via Link update mode`
        );
      } else {
        console.warn(
          `[refreshPlaidItem] investmentsHoldingsGet failed for item ${plaidItemDbId} (non-fatal): ${plaidErrorSummary(holdingsErr)}`
        );
      }
    }
  }

  // ── 3. Transactions ──────────────────────────────────────────────────────
  // Reuses the existing cursor-based sync as-is — no duplicated logic.
  // M2 — snapshot the reconcilable accounts' transaction sums BEFORE the sync
  // so we can diff how much this sync changed them.
  const reconcileIds = reconcileTargets.map((t) => t.id);
  const txnSumBefore = await txnSumByAccount(reconcileIds);

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
        const balanceDelta = t.balanceAfter - t.balanceBefore;
        const txnSumDelta  = (txnSumAfter.get(t.id) ?? 0) - (txnSumBefore.get(t.id) ?? 0);
        const expected     = t.kind === "cash" ? txnSumDelta : -txnSumDelta;
        const mismatch     = Math.abs(balanceDelta - expected);
        const threshold    = Math.max(100, Math.abs(t.balanceAfter) * 0.02);
        if (mismatch > threshold) {
          console.warn(
            `[reconcile] BALANCE_TX_MISMATCH account ${t.id} (${t.type}) — balanceDelta=${balanceDelta.toFixed(2)} expected=${expected.toFixed(2)} mismatch=${mismatch.toFixed(2)} > threshold=${threshold.toFixed(2)}`
          );
          await recordSyncIssue({
            kind:               "BALANCE_TX_MISMATCH",
            plaidItemId:        plaidItemDbId,
            financialAccountId: t.id,
            detail:             { accountType: t.type, kind: t.kind, balanceDelta, txnSumDelta, expected, mismatch, threshold },
          });
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

    try {
      const r = await refreshPlaidItem(item.id, { deferSnapshot: true });
      results.push(r);
      totalAccountsUpdated      += r.accountsUpdated;
      totalHoldingsUpdated      += r.holdingsUpdated;
      totalTransactionsAdded    += r.transactionsAdded;
      totalTransactionsModified += r.transactionsModified;
      totalTransactionsRemoved  += r.transactionsRemoved;
      succeededAccountIds.push(...(r.updatedAccountIds ?? []));
    } catch (e) {
      console.error(`[refreshAllActiveItemsForUser] refresh failed for PlaidItem ${item.id}:`, e);
      failedItemIds.push(item.id);
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        await db.plaidItem.update({
          where: { id: item.id },
          data:  { status: health.status, errorCode: health.errorCode },
        });
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
