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
 *     FinancialAccount directly).
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
import { decrypt } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import { AccountType, PlaidItemStatus, ProviderType } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { classifyPlaidErrorForHealth } from "@/lib/plaid/errors";
import { withPlaidRetry } from "@/lib/plaid/retry";

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
export async function refreshPlaidItem(plaidItemDbId: string): Promise<RefreshItemResult> {
  const item = await db.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) {
    throw new Error(`refreshPlaidItem: PlaidItem ${plaidItemDbId} not found`);
  }

  const accessToken = decrypt(item.encryptedToken);

  // ── 1. Balances / account metadata ────────────────────────────────────────
  let accountsUpdated = 0;
  const updatedAccountIds: string[] = [];
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
    // docs/initiatives/d2/D2_STEP3A_PROVIDER_ACCOUNT_IDENTITY_READ_CUTOVER_INVESTIGATION.md.
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

    await db.financialAccount.update({
      where: { id: fa.id },
      data: {
        // Fall back to the existing balance rather than 0 if Plaid returns a
        // transient null — avoids zeroing out a real balance on a hiccup.
        balance: acct.balances.current ?? fa.balance,
        availableBalance,
        ...(creditLimit !== undefined && { creditLimit }),
        lastUpdated: new Date(),
        syncStatus:  "synced",
      },
    });
    accountsUpdated++;
    updatedAccountIds.push(fa.id);
  }

  // ── 2. Investment holdings ──────────────────────────────────────────────
  // Best-effort/non-fatal — an institution with no investment accounts, or a
  // transient Plaid error here, should never block balances/transactions.
  let holdingsUpdated = 0;
  const investmentPlaidAccounts = plaidAccounts.filter(
    (a) => mapAccountType(a.type, a.subtype) === AccountType.investment
  );

  if (investmentPlaidAccounts.length > 0) {
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
        const holdingPlaidIdentity = await db.providerAccountIdentity.findFirst({
          where: { provider: ProviderType.PLAID, externalAccountId: plaidAcct.account_id },
          select: { financialAccount: { select: { id: true } } },
        });

        let fa = holdingPlaidIdentity?.financialAccount ?? null;
        if (!fa) {
          // Selected via a separate variable (not assigned straight into
          // `fa`) so `deletedAt` is available to gate the warning below
          // without widening `fa`'s declared type beyond `{ id }`.
          const legacyFa = await db.financialAccount.findUnique({
            where:  { plaidAccountId: plaidAcct.account_id },
            select: { id: true, deletedAt: true },
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

        await db.holding.deleteMany({ where: { financialAccountId: fa.id } });

        for (const h of acctHoldings) {
          const sec = secById[h.security_id];
          if (!sec) continue;
          if (sec.type === "cash" || !sec.ticker_symbol) continue;

          const currentPrice = h.institution_price ?? 0;
          const prevClose    = sec.close_price ?? currentPrice;
          const change24h    = prevClose > 0
            ? parseFloat((((currentPrice - prevClose) / prevClose) * 100).toFixed(2))
            : 0;

          await db.holding.create({
            data: {
              financialAccountId: fa.id,
              symbol:    sec.ticker_symbol,
              name:      sec.name ?? sec.ticker_symbol,
              quantity:  h.quantity,
              price:     currentPrice,
              value:     h.institution_value ?? h.quantity * currentPrice,
              change24h,
            },
          });
          holdingsUpdated++;
        }
      }
    } catch (holdingsErr) {
      console.warn(
        `[refreshPlaidItem] investmentsHoldingsGet failed for item ${plaidItemDbId} (non-fatal):`,
        holdingsErr
      );
    }
  }

  // ── 3. Transactions ──────────────────────────────────────────────────────
  // Reuses the existing cursor-based sync as-is — no duplicated logic.
  const txSync = await syncTransactionsForItem(plaidItemDbId);

  // ── 4. SpaceSnapshot regeneration ───────────────────────────────────
  // Recomputes today's snapshot row for every space these accounts are
  // shared into, from the now-fresh FinancialAccount balances. This is what
  // the Cash History / Banking History / Net Worth charts actually read —
  // see lib/snapshots/regenerate.ts for why this step exists.
  const spacesSnapshotted = await regenerateSnapshotsForAccounts(updatedAccountIds);

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
  };
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
  const snapshottedSpaceIds = new Set<string>();

  for (const item of items) {
    if (!(await hasActiveLinkedAccount(item.id))) {
      // No active linked account left for this item — not a failure, just
      // done. Self-heal so it drops out of this query on every later call,
      // and skip straight to the next item without calling Plaid.
      await selfHealOrphanedPlaidItem(item.id);
      continue;
    }

    try {
      const r = await refreshPlaidItem(item.id);
      results.push(r);
      totalAccountsUpdated      += r.accountsUpdated;
      totalHoldingsUpdated      += r.holdingsUpdated;
      totalTransactionsAdded    += r.transactionsAdded;
      totalTransactionsModified += r.transactionsModified;
      totalTransactionsRemoved  += r.transactionsRemoved;
      r.spacesSnapshotted.forEach((id) => snapshottedSpaceIds.add(id));
    } catch (e) {
      console.error(`[refreshAllActiveItemsForUser] refresh failed for PlaidItem ${item.id}:`, e);
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        await db.plaidItem.update({
          where: { id: item.id },
          data:  { status: health.status, errorCode: health.errorCode },
        });
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

  return {
    results,
    itemCount: items.length,
    totalAccountsUpdated,
    totalHoldingsUpdated,
    totalTransactionsAdded,
    totalTransactionsModified,
    totalTransactionsRemoved,
    spacesSnapshotted: [...snapshottedSpaceIds],
  };
}
