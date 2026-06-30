/**
 * lib/ai/assemblers/transactions.ts
 *
 * AI Context Assembler — 'transactions_summary' domain (D4 Slice 4).
 *
 * Assembles aggregated transaction intelligence for the validated Space.
 * RAW TRANSACTION ROWS ARE NEVER RETURNED — this domain is intentionally
 * summary-only. FinanceDomains.TRANSACTIONS_RAW is a separate future domain
 * for explicit opt-in raw access.
 *
 * ── Transaction visibility ────────────────────────────────────────────────────
 * Transactions reach a Space via two paths (mirroring lib/data/transactions.ts):
 *   1. Legacy:  transaction.account.spaceId   (old Account model)
 *   2. Current: transaction.financialAccount via SpaceAccountLink (D3 canonical)
 * Both paths are ORed together so no transaction is silently excluded during
 * the migration period. Transaction.deletedAt is always filtered to null
 * (D2 Step 4D-R soft-delete guard).
 *
 * ── What is included ─────────────────────────────────────────────────────────
 * Banking categories only (Income, Transfer, Groceries, Dining, Shopping,
 * Travel, Subscriptions, Utilities, Interest, Payment, Other). Investment
 * transaction categories (Buy, Sell, Dividend, Split, Fee) are excluded —
 * they belong to a future investment-activity domain.
 *
 * ── Query window ─────────────────────────────────────────────────────────────
 *   scopeHint='brief' → last 30 days  (Daily Brief: recent activity)
 *   scopeHint='full'  → last 90 days  (full context: trend visibility)
 * A fetch safety cap (TRANSACTION_FETCH_LIMIT) prevents unbounded queries
 * for Spaces with dense transaction history. Aggregation is over the returned
 * rows; if the cap is hit, the summary covers the most recent N rows within
 * the window.
 *
 * ── Permissions ──────────────────────────────────────────────────────────────
 * buildContext() validates Space membership before invoking any assembler.
 * The OR query always scopes to the validated spaceId — no cross-Space rows
 * can appear. SpaceAccountLink.status = ACTIVE is enforced on the current path.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - All queries filter by spaceCtx.spaceId.
 * - No raw transaction rows are returned in the ContextDomainSection.
 */

import { db } from '@/lib/db';
import { ShareStatus, TransactionCategory } from '@prisma/client';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  TransactionsSummaryData,
  CategorySpend,
  RecurringCandidate,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Banking categories — mirrors the constant in lib/data/transactions.ts. */
const BANKING_CATEGORIES: TransactionCategory[] = [
  TransactionCategory.Income,
  TransactionCategory.Transfer,
  TransactionCategory.Groceries,
  TransactionCategory.Dining,
  TransactionCategory.Shopping,
  TransactionCategory.Travel,
  TransactionCategory.Subscriptions,
  TransactionCategory.Utilities,
  TransactionCategory.Interest,
  TransactionCategory.Payment,
  TransactionCategory.Other,
];

/** Categories that represent money flowing in (income / interest). */
const INCOME_CATEGORIES = new Set<TransactionCategory>([
  TransactionCategory.Income,
  TransactionCategory.Interest,
]);

/**
 * Safety cap on rows fetched per assembly. Aggregation covers these rows;
 * if a Space has more than this many banking transactions in the window the
 * summary reflects the most recent TRANSACTION_FETCH_LIMIT rows only.
 */
const TRANSACTION_FETCH_LIMIT = 5_000;

const WINDOW_BRIEF_DAYS = 30;
const WINDOW_FULL_DAYS  = 90;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type TxnRow = {
  date:     Date;
  merchant: string;
  category: TransactionCategory;
  amount:   number;
  pending:  boolean;
};

// ---------------------------------------------------------------------------
// Assembler implementation
// ---------------------------------------------------------------------------

async function assembleTransactions(
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
): Promise<ContextDomainSection | null> {
  const { spaceId } = spaceCtx;
  const { scopeHint = 'full' } = options;
  const assembledAt = new Date().toISOString();

  const windowDays  = scopeHint === 'brief' ? WINDOW_BRIEF_DAYS : WINDOW_FULL_DAYS;
  const windowStart = startOfDay(-windowDays);

  // ── Query ─────────────────────────────────────────────────────────────────
  // Mirrors the dual-path OR in lib/data/transactions.ts:
  //   path 1 — legacy Account.spaceId
  //   path 2 — FinancialAccount via active SpaceAccountLink (D3 canonical)
  // Both deletedAt guards (account-level and transaction-level) are applied.

  const rows: TxnRow[] = await db.transaction.findMany({
    where: {
      OR: [
        {
          account: { spaceId },
        },
        {
          financialAccount: {
            deletedAt:         null,
            spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } },
          },
        },
      ],
      deletedAt: null,
      category:  { in: BANKING_CATEGORIES },
      date:      { gte: windowStart },
    },
    select: {
      date:     true,
      merchant: true,
      category: true,
      amount:   true,
      pending:  true,
    },
    orderBy: { date: 'desc' },
    take:    TRANSACTION_FETCH_LIMIT,
  });

  // No transactions in window — return null so the domain is noted as empty.
  if (rows.length === 0) return null;

  // ── Partition: settled vs pending ─────────────────────────────────────────

  const settled: TxnRow[] = [];
  const pending: TxnRow[] = [];

  for (const r of rows) {
    (r.pending ? pending : settled).push(r);
  }

  // ── Cash flow aggregation (settled only) ──────────────────────────────────

  let incomeTotal      = 0;
  let expenseTotal     = 0;
  let debtPaymentTotal = 0;
  let transferTotal    = 0;

  let largestIncomeRow:  TxnRow | null = null;
  let largestExpenseRow: TxnRow | null = null;

  const categoryMap = new Map<string, { total: number; count: number }>();

  for (const txn of settled) {
    // Category bucket accumulator
    const entry = categoryMap.get(txn.category) ?? { total: 0, count: 0 };
    entry.total += txn.amount;
    entry.count += 1;
    categoryMap.set(txn.category, entry);

    if (txn.category === TransactionCategory.Transfer) {
      transferTotal += Math.abs(txn.amount);
      continue;
    }

    if (txn.category === TransactionCategory.Payment) {
      if (txn.amount < 0) debtPaymentTotal += Math.abs(txn.amount);
      continue;
    }

    if (INCOME_CATEGORIES.has(txn.category) && txn.amount > 0) {
      incomeTotal += txn.amount;
      if (!largestIncomeRow || txn.amount > largestIncomeRow.amount) {
        largestIncomeRow = txn;
      }
      continue;
    }

    // Everything else with a negative amount is an expense
    if (txn.amount < 0) {
      expenseTotal += Math.abs(txn.amount);
      if (!largestExpenseRow || txn.amount < largestExpenseRow.amount) {
        largestExpenseRow = txn;
      }
    }
  }

  const netCashFlow = incomeTotal - expenseTotal - debtPaymentTotal;

  // ── Pending aggregation ───────────────────────────────────────────────────

  let pendingCreditCount = 0;
  let pendingCreditTotal = 0;
  let pendingDebitCount  = 0;
  let pendingDebitTotal  = 0;

  for (const txn of pending) {
    if (txn.amount > 0) {
      pendingCreditCount++;
      pendingCreditTotal += txn.amount;
    } else {
      pendingDebitCount++;
      pendingDebitTotal += Math.abs(txn.amount);
    }
  }

  // ── By-category summary ───────────────────────────────────────────────────
  // Sorted by absolute total descending — highest-spend categories first.

  const byCategory: CategorySpend[] = Array.from(categoryMap.entries())
    .map(([category, { total, count }]): CategorySpend => ({
      category,
      total: Math.round(Math.abs(total) * 100) / 100,
      count,
    }))
    .sort((a, b) => b.total - a.total);

  // For brief scope: keep only top 5 categories (enough for a morning summary).
  const byCategoryOutput = scopeHint === 'brief' ? byCategory.slice(0, 5) : byCategory;

  // ── Date range ────────────────────────────────────────────────────────────
  // rows is ordered desc by date; last element is oldest in the window.

  const newestDate = rows[0].date.toISOString().split('T')[0];

  // ── Recurring candidates (settled transactions, full scope only) ──────────
  // Heuristic: merchants appearing 2+ times in the window are candidates.
  // Groups by case-insensitive merchant name. Excludes Transfer and Payment
  // categories since predictable internal moves aren't interesting signals.

  let recurringCandidates: RecurringCandidate[] | undefined;

  if (scopeHint !== 'brief') {
    const merchantMap = new Map<string, { amounts: number[]; category: string }>();

    for (const txn of settled) {
      if (
        txn.category === TransactionCategory.Transfer ||
        txn.category === TransactionCategory.Payment
      ) continue;

      const key     = txn.merchant.trim().toLowerCase();
      const group   = merchantMap.get(key) ?? { amounts: [], category: txn.category };
      group.amounts.push(txn.amount);
      merchantMap.set(key, group);
    }

    recurringCandidates = [];
    for (const [merchant, group] of merchantMap) {
      if (group.amounts.length < 2) continue;
      const sum = group.amounts.reduce((s, a) => s + a, 0);
      const avg = sum / group.amounts.length;
      recurringCandidates.push({
        merchant,
        occurrences:   group.amounts.length,
        typicalAmount: Math.round(avg * 100) / 100,
        category:      group.category,
      });
    }

    // Most frequent first, then largest absolute typical amount
    recurringCandidates.sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        Math.abs(b.typicalAmount) - Math.abs(a.typicalAmount),
    );
  }

  // ── Assemble payload ──────────────────────────────────────────────────────

  const data: TransactionsSummaryData = {
    windowDays,
    startDate:        windowStart.toISOString().split('T')[0],
    endDate:          newestDate,
    transactionCount: rows.length,

    incomeTotal:      Math.round(incomeTotal      * 100) / 100,
    expenseTotal:     Math.round(expenseTotal     * 100) / 100,
    debtPaymentTotal: Math.round(debtPaymentTotal * 100) / 100,
    transferTotal:    Math.round(transferTotal    * 100) / 100,
    netCashFlow:      Math.round(netCashFlow      * 100) / 100,

    pendingCreditCount,
    pendingCreditTotal: Math.round(pendingCreditTotal * 100) / 100,
    pendingDebitCount,
    pendingDebitTotal:  Math.round(pendingDebitTotal  * 100) / 100,

    byCategory: byCategoryOutput,

    largestIncome: largestIncomeRow
      ? {
          merchant: largestIncomeRow.merchant,
          amount:   Math.round(largestIncomeRow.amount * 100) / 100,
          date:     largestIncomeRow.date.toISOString().split('T')[0],
        }
      : null,

    largestExpense: largestExpenseRow
      ? {
          merchant: largestExpenseRow.merchant,
          amount:   Math.round(Math.abs(largestExpenseRow.amount) * 100) / 100,
          date:     largestExpenseRow.date.toISOString().split('T')[0],
        }
      : null,

    ...(recurringCandidates !== undefined ? { recurringCandidates } : {}),
  };

  return {
    domain:      FinanceDomains.TRANSACTIONS_SUMMARY,
    assembledAt,
    data,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns midnight UTC on the day N days ago. */
function startOfDay(offsetDays: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.TRANSACTIONS_SUMMARY, assembleTransactions);
