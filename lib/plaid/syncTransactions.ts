/**
 * lib/plaid/syncTransactions.ts
 *
 * Reusable, webhook-ready transaction sync for a single PlaidItem.
 * Wraps Plaid's /transactions/sync (cursor-based incremental sync) so the
 * same function can be called from multiple entry points without duplicating
 * sync logic:
 *
 *  - app/api/plaid/exchange-token/route.ts — initial sync, immediately after
 *    a successful Link flow (accounts already imported by that point).
 *  - app/api/plaid/sync/route.ts — manual "Sync Now" endpoint.
 *  - jobs/sync-banks.ts — a pre-existing stub (`export {}`, present since the
 *    v1.0 foundation commit, named for exactly this purpose) now wired to
 *    call this function. jobs/scheduler.ts already registers it on a fixed
 *    interval. Note: startScheduler() itself is not invoked anywhere yet (no
 *    instrumentation.ts hook) — a pre-existing gap unrelated to this work, so
 *    the interval is registered but dormant until that's wired up separately.
 *  - a future Plaid webhook handler (SYNC_UPDATES_AVAILABLE) — endpoint
 *    itself deliberately out of scope for this pass (needs public endpoint
 *    handling, signature verification, retry/error handling of its own);
 *    this is exactly what it would call once built.
 *
 * Design notes:
 *  - Takes our internal PlaidItem.id (not Plaid's item_id) so callers never
 *    need to touch the encrypted access token directly.
 *  - Resumes from PlaidItem.cursor; a null/undefined cursor means "first
 *    sync ever" and Plaid returns the full available transaction history.
 *  - Loops on `has_more` — a single call may require several pages.
 *  - Persists `next_cursor` back onto PlaidItem only after the full loop
 *    completes successfully, so a mid-loop failure can safely retry from the
 *    last *persisted* cursor rather than silently skipping a page.
 *  - Maps Plaid's account_id -> FinancialAccount.id via the unique
 *    plaidAccountId field set at import time. Transactions for an account we
 *    don't recognize (e.g. an account type we don't import) are skipped with
 *    a warning, not an error — one unmapped account can't abort the sync.
 *  - Flips the amount sign: Plaid uses positive = money out (debit),
 *    negative = money in (credit). FinTracker's convention (see
 *    prisma/schema.prisma Transaction model comment) is the opposite:
 *    positive = money in (credit), negative = money out (debit).
 *  - Upserts on the unique `plaidTransactionId` field so re-running a sync
 *    (e.g. retried webhook delivery) never creates duplicates.
 *  - Writes `financialAccountId`, never the legacy `accountId` — Plaid-synced
 *    transactions only ever belong to a FinancialAccount.
 */

import { plaidClient } from "@/lib/plaid/client";
import { decrypt } from "@/lib/plaid/encryption";
import { db } from "@/lib/db";
import { TransactionCategory } from "@prisma/client";
import type { Transaction as PlaidTransaction } from "plaid";

export interface SyncTransactionsResult {
  added:    number;
  modified: number;
  removed:  number;
  cursor:   string | null;
}

/**
 * Maps a Plaid transaction's category info to our TransactionCategory enum.
 * Prefers the modern `personal_finance_category` taxonomy; falls back to the
 * legacy `category` string array; defaults to "Other". Never throws — an
 * unrecognized or missing category should never block a transaction import.
 */
export function mapPlaidCategory(
  txn: Pick<PlaidTransaction, "personal_finance_category" | "category">
): TransactionCategory {
  const pfc = txn.personal_finance_category;
  if (pfc?.primary) {
    const detailed = pfc.detailed ?? "";

    // Detailed-level overrides — more precise than the primary bucket alone.
    if (detailed.includes("INTEREST"))     return TransactionCategory.Interest;
    if (detailed.includes("SUBSCRIPTION")) return TransactionCategory.Subscriptions;

    switch (pfc.primary) {
      case "INCOME":              return TransactionCategory.Income;
      case "TRANSFER_IN":
      case "TRANSFER_OUT":        return TransactionCategory.Transfer;
      case "LOAN_PAYMENTS":       return TransactionCategory.Payment;
      case "BANK_FEES":           return TransactionCategory.Fee;
      case "FOOD_AND_DRINK":      return TransactionCategory.Dining;
      case "GENERAL_MERCHANDISE": return TransactionCategory.Shopping;
      case "RENT_AND_UTILITIES":  return TransactionCategory.Utilities;
      case "TRAVEL":               return TransactionCategory.Travel;
      default:                     return TransactionCategory.Other;
    }
  }

  // Legacy fallback — Plaid's older `category` array, e.g. ["Food and Drink", "Restaurants"].
  const legacy = txn.category?.[0]?.toLowerCase() ?? "";
  if (legacy.includes("food") || legacy.includes("restaurant")) return TransactionCategory.Dining;
  if (legacy.includes("shop"))                                  return TransactionCategory.Shopping;
  if (legacy.includes("travel"))                                return TransactionCategory.Travel;
  if (legacy.includes("transfer"))                              return TransactionCategory.Transfer;
  if (legacy.includes("payment"))                               return TransactionCategory.Payment;
  if (legacy.includes("interest"))                              return TransactionCategory.Interest;
  if (legacy.includes("payroll") || legacy.includes("deposit")) return TransactionCategory.Income;
  if (legacy.includes("utilities") || legacy.includes("rent"))  return TransactionCategory.Utilities;
  if (legacy.includes("subscription"))                          return TransactionCategory.Subscriptions;

  return TransactionCategory.Other;
}

/**
 * Runs an incremental transaction sync for the given PlaidItem.
 *
 * @param plaidItemDbId  Our internal PlaidItem.id (primary key), not Plaid's item_id.
 */
export async function syncTransactionsForItem(plaidItemDbId: string): Promise<SyncTransactionsResult> {
  const item = await db.plaidItem.findUnique({ where: { id: plaidItemDbId } });
  if (!item) {
    throw new Error(`syncTransactionsForItem: PlaidItem ${plaidItemDbId} not found`);
  }

  const accessToken = decrypt(item.encryptedToken);

  let cursor: string | undefined = item.cursor ?? undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  // Cache plaidAccountId -> FinancialAccount.id within this run — avoids a
  // query per transaction when many transactions share a handful of accounts.
  const accountIdCache = new Map<string, string | null>();
  async function resolveFinancialAccountId(plaidAccountId: string): Promise<string | null> {
    if (accountIdCache.has(plaidAccountId)) return accountIdCache.get(plaidAccountId)!;
    const fa = await db.financialAccount.findUnique({
      where:  { plaidAccountId },
      select: { id: true },
    });
    const resolved = fa?.id ?? null;
    accountIdCache.set(plaidAccountId, resolved);
    return resolved;
  }

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
    });
    const { added: addedTxns, modified: modifiedTxns, removed: removedTxns, has_more, next_cursor } = resp.data;

    for (const txn of [...addedTxns, ...modifiedTxns]) {
      const financialAccountId = await resolveFinancialAccountId(txn.account_id);
      if (!financialAccountId) {
        console.warn(
          `[plaid sync] no FinancialAccount for plaidAccountId ${txn.account_id} — skipping transaction ${txn.transaction_id}`
        );
        continue;
      }

      // Plaid: positive = debit (money out), negative = credit (money in).
      // FinTracker: positive = credit (money in), negative = debit (money out).
      const amount   = -txn.amount;
      const category = mapPlaidCategory(txn);

      try {
        await db.transaction.upsert({
          where: { plaidTransactionId: txn.transaction_id },
          update: {
            financialAccountId,
            date:        new Date(txn.date),
            merchant:    txn.merchant_name ?? txn.name,
            description: txn.name,
            category,
            amount,
            pending:     txn.pending,
          },
          create: {
            financialAccountId,
            plaidTransactionId: txn.transaction_id,
            date:        new Date(txn.date),
            merchant:    txn.merchant_name ?? txn.name,
            description: txn.name,
            category,
            amount,
            pending:     txn.pending,
          },
        });
      } catch (e) {
        console.error(`[plaid sync] failed to upsert transaction ${txn.transaction_id}:`, e);
      }
    }
    added    += addedTxns.length;
    modified += modifiedTxns.length;

    if (removedTxns.length > 0) {
      const ids = removedTxns.map((t) => t.transaction_id);
      const result = await db.transaction.deleteMany({ where: { plaidTransactionId: { in: ids } } });
      removed += result.count;
    }

    hasMore = has_more;
    cursor  = next_cursor;
  }

  await db.plaidItem.update({
    where: { id: plaidItemDbId },
    data:  { cursor: cursor ?? null, lastSyncedAt: new Date() },
  });

  return { added, modified, removed, cursor: cursor ?? null };
}
