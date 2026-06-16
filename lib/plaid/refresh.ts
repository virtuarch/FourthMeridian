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
 *     exchange-token's initial import, cross-referenced via the legacy
 *     Account.plaidAccountId (Holding is still FK'd to the legacy Account
 *     model, not FinancialAccount).
 *  3. Transactions, via the existing syncTransactionsForItem() — untouched,
 *     reused as-is so sync logic is never duplicated.
 *
 * Does not create AccountConnection or WorkspaceAccountShare rows — those
 * are established once at Link time and are not part of a refresh.
 */

import { plaidClient } from "@/lib/plaid/client";
import { decrypt } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import { AccountType, PlaidItemStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";

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
  error?:                 string;
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
  const accountsRes   = await plaidClient.accountsGet({ access_token: accessToken });
  const plaidAccounts = accountsRes.data.accounts;

  for (const acct of plaidAccounts) {
    const fa = await db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } });
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
      const holdingsRes      = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
      const { holdings, securities } = holdingsRes.data;
      const secById           = Object.fromEntries(securities.map((s) => [s.security_id, s]));

      for (const plaidAcct of investmentPlaidAccounts) {
        const acctHoldings = holdings.filter((h) => h.account_id === plaidAcct.account_id);
        if (!acctHoldings.length) continue;

        // Holding is still FK'd to the legacy Account model — cross-reference
        // via plaidAccountId, same as exchange-token's initial import.
        const dbAcct = await db.account.findUnique({
          where:  { plaidAccountId: plaidAcct.account_id },
          select: { id: true },
        });
        if (!dbAcct) continue; // never create — refresh only updates known accounts

        await db.holding.deleteMany({ where: { accountId: dbAcct.id } });

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
              accountId: dbAcct.id,
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

  return {
    plaidItemId:          plaidItemDbId,
    institution:          item.institutionName,
    ok:                   true,
    accountsUpdated,
    holdingsUpdated,
    transactionsAdded:    txSync.added,
    transactionsModified: txSync.modified,
    transactionsRemoved:  txSync.removed,
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
}

/**
 * Refreshes every active PlaidItem owned by the given user. One item's
 * failure (e.g. ITEM_LOGIN_REQUIRED) does not block the others — mirrors the
 * per-item try/catch pattern in app/api/plaid/sync/route.ts.
 */
export async function refreshAllActiveItemsForUser(userId: string): Promise<RefreshSummary> {
  const items = await db.plaidItem.findMany({
    where:  { userId, status: PlaidItemStatus.ACTIVE },
    select: { id: true, institutionName: true },
  });

  const results: RefreshItemResult[] = [];
  let totalAccountsUpdated      = 0;
  let totalHoldingsUpdated      = 0;
  let totalTransactionsAdded    = 0;
  let totalTransactionsModified = 0;
  let totalTransactionsRemoved  = 0;

  for (const item of items) {
    try {
      const r = await refreshPlaidItem(item.id);
      results.push(r);
      totalAccountsUpdated      += r.accountsUpdated;
      totalHoldingsUpdated      += r.holdingsUpdated;
      totalTransactionsAdded    += r.transactionsAdded;
      totalTransactionsModified += r.transactionsModified;
      totalTransactionsRemoved  += r.transactionsRemoved;
    } catch (e) {
      console.error(`[refreshAllActiveItemsForUser] refresh failed for PlaidItem ${item.id}:`, e);
      results.push({
        plaidItemId:          item.id,
        institution:          item.institutionName,
        ok:                   false,
        accountsUpdated:      0,
        holdingsUpdated:      0,
        transactionsAdded:    0,
        transactionsModified: 0,
        transactionsRemoved:  0,
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
  };
}
