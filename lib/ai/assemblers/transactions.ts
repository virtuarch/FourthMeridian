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
  MonthlyBreakdownEntry,
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

/** Number of top categories surfaced per month in the monthly breakdown. */
const MONTHLY_TOP_CATEGORIES = 3;

/**
 * Defensive ceiling on an explicit (D6) window. The routing layer already caps
 * "last N months" at 24 months and YTD is naturally bounded, but this guards
 * against any caller supplying an unbounded range: the window floor is never
 * allowed to reach further back than this many days.
 */
const MAX_EXPLICIT_WINDOW_DAYS = 800; // ~26 months

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
  const { scopeHint = 'full', transactionWindow } = options;
  const assembledAt = new Date().toISOString();

  // ── Resolve the analysis window ─────────────────────────────────────────────
  // Default: rolling 30-day (brief) / 90-day (full) window, floor only.
  // Explicit (D6): a caller-supplied inclusive [startDate, endDate] range. The
  // floor is clamped to MAX_EXPLICIT_WINDOW_DAYS so a request can never reach
  // unbounded history. windowDays is the inclusive day count — it feeds the
  // downstream monthly-equivalent math unchanged (only the span widens).
  const win = resolveWindow(scopeHint, transactionWindow);

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
      // Floor always applied; ceiling only for an explicit past-bounded window.
      date:      win.end ? { gte: win.start, lte: win.end } : { gte: win.start },
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

  // ── Monthly rollups (D6 — deterministic, per calendar month) ──────────────
  // Buckets are built directly from the queried rows so month-by-month answers
  // never require the LLM to divide a window total by a month count. The
  // effective ceiling is the explicit window end, or today for a rolling window,
  // so partial-month detection reflects the actual coverage of the request.
  const effectiveEndIso = win.endIso ?? new Date().toISOString().split('T')[0];
  const monthlyBreakdown = buildMonthlyBreakdown(settled, pending, win.startIso, effectiveEndIso);

  // ── Date range ────────────────────────────────────────────────────────────
  // rows is ordered desc by date; last element is oldest in the window.
  // For an explicit window the reported endDate is the requested ceiling so the
  // provenance block shows the exact period asked for; otherwise it is the most
  // recent transaction date (default rolling-window behavior, unchanged).

  const newestDate = win.endIso ?? rows[0].date.toISOString().split('T')[0];

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
    windowDays:       win.days,
    startDate:        win.startIso,
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

    monthlyBreakdown,

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

/** UTC calendar month key (YYYY-MM) for a Date. */
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** True when a YYYY-MM-DD date is the last calendar day of its UTC month. */
function isLastDayOfMonth(iso: string): boolean {
  const y   = Number(iso.slice(0, 4));
  const mo  = Number(iso.slice(5, 7)); // 1–12
  const day = Number(iso.slice(8, 10));
  // Day 0 of the next month === last day of month `mo`.
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return day >= lastDay;
}

/**
 * Build the deterministic per-calendar-month breakdown (D6).
 *
 * Money totals mirror the top-level cash-flow aggregation exactly and use
 * SETTLED rows only. transactionCount includes pending rows so the per-month
 * counts sum to the top-level transactionCount. A month is flagged `partial`
 * when the window clips it — the first month if the floor lands after the 1st,
 * or the last month if the ceiling lands before month-end (e.g. an in-progress
 * current month on a rolling window). Result is ordered oldest → newest.
 */
function buildMonthlyBreakdown(
  settled:  TxnRow[],
  pending:  TxnRow[],
  startIso: string,
  endIso:   string,
): MonthlyBreakdownEntry[] {
  type Bucket = {
    incomeTotal:      number;
    expenseTotal:     number;
    debtPaymentTotal: number;
    transferTotal:    number;
    transactionCount: number;
    // Per-category signed sum + settled row count. Abs(signed) at output mirrors
    // the top-level byCategory; count mirrors CategorySpend.count.
    categoryAgg:      Map<string, { signed: number; count: number }>;
  };

  const buckets = new Map<string, Bucket>();

  const bucketFor = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = {
        incomeTotal: 0, expenseTotal: 0, debtPaymentTotal: 0,
        transferTotal: 0, transactionCount: 0, categoryAgg: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  // Settled rows drive money totals + category sums (same rules as the main loop).
  for (const txn of settled) {
    const b = bucketFor(monthKey(txn.date));
    b.transactionCount += 1;
    const agg = b.categoryAgg.get(txn.category) ?? { signed: 0, count: 0 };
    agg.signed += txn.amount;
    agg.count  += 1;
    b.categoryAgg.set(txn.category, agg);

    if (txn.category === TransactionCategory.Transfer) {
      b.transferTotal += Math.abs(txn.amount);
    } else if (txn.category === TransactionCategory.Payment) {
      if (txn.amount < 0) b.debtPaymentTotal += Math.abs(txn.amount);
    } else if (INCOME_CATEGORIES.has(txn.category) && txn.amount > 0) {
      b.incomeTotal += txn.amount;
    } else if (txn.amount < 0) {
      b.expenseTotal += Math.abs(txn.amount);
    }
  }

  // Pending rows only bump the count (excluded from money totals, as top-level).
  for (const txn of pending) {
    bucketFor(monthKey(txn.date)).transactionCount += 1;
  }

  const startMonth   = startIso.slice(0, 7);
  const startClipped = Number(startIso.slice(8, 10)) > 1;
  const endMonth     = endIso.slice(0, 7);
  const endClipped   = !isLastDayOfMonth(endIso);

  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // oldest → newest
    .map(([month, b]): MonthlyBreakdownEntry => {
      // Full deterministic per-category totals for this month (all present
      // categories, non-zero only). This is the authoritative per-month category
      // source — absence means "no classified settled txns this month", never $0.
      const byCategory: CategorySpend[] = Array.from(b.categoryAgg.entries())
        .map(([category, { signed, count }]): CategorySpend => ({
          category,
          total: Math.round(Math.abs(signed) * 100) / 100,
          count,
        }))
        .filter((c) => c.total > 0)
        .sort((x, y) => y.total - x.total);

      // topCategories stays a compact convenience slice of byCategory.
      const topCategories = byCategory
        .slice(0, MONTHLY_TOP_CATEGORIES)
        .map(({ category, total }) => ({ category, total }));

      const partial =
        (month === startMonth && startClipped) ||
        (month === endMonth && endClipped);

      return {
        month,
        incomeTotal:      Math.round(b.incomeTotal      * 100) / 100,
        expenseTotal:     Math.round(b.expenseTotal     * 100) / 100,
        debtPaymentTotal: Math.round(b.debtPaymentTotal * 100) / 100,
        transferTotal:    Math.round(b.transferTotal    * 100) / 100,
        transactionCount: b.transactionCount,
        ...(partial ? { partial: true } : {}),
        byCategory,
        ...(topCategories.length > 0 ? { topCategories } : {}),
      };
    });
}

/** Returns midnight UTC on the day N days ago. */
function startOfDay(offsetDays: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Whole UTC days (inclusive) between two YYYY-MM-DD dates, minimum 1. */
function inclusiveDaySpan(startIso: string, endIso: string): number {
  const start = Date.parse(`${startIso}T00:00:00.000Z`);
  const end   = Date.parse(`${endIso}T00:00:00.000Z`);
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

/**
 * Resolve the query window from scopeHint + an optional explicit request.
 *
 * Default (no explicit window): rolling floor only — 30 days (brief) / 90 days
 * (full), matching the pre-D6 behavior exactly.
 *
 * Explicit (D6): inclusive [startDate, endDate]. The floor is clamped so it can
 * never reach further back than MAX_EXPLICIT_WINDOW_DAYS. `days` is the
 * inclusive day count used for downstream monthly-equivalent math.
 */
function resolveWindow(
  scopeHint:         'full' | 'brief',
  transactionWindow: AssemblerOptions['transactionWindow'],
): { start: Date; end: Date | null; startIso: string; endIso: string | null; days: number } {
  if (!transactionWindow) {
    const days  = scopeHint === 'brief' ? WINDOW_BRIEF_DAYS : WINDOW_FULL_DAYS;
    const start = startOfDay(-days);
    return { start, end: null, startIso: start.toISOString().split('T')[0], endIso: null, days };
  }

  // Clamp the floor to the defensive maximum lookback.
  const earliestAllowed = startOfDay(-MAX_EXPLICIT_WINDOW_DAYS);
  let start = new Date(`${transactionWindow.startDate}T00:00:00.000Z`);
  if (start < earliestAllowed) start = earliestAllowed;

  const startIso = start.toISOString().split('T')[0];
  const endIso   = transactionWindow.endDate;
  // Inclusive ceiling: end of the requested day.
  const end = new Date(`${endIso}T23:59:59.999Z`);

  return { start, end, startIso, endIso, days: inclusiveDaySpan(startIso, endIso) };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.TRANSACTIONS_SUMMARY, assembleTransactions);
