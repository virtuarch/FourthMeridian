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
 * KD-1 (2026-07-02): the SpaceAccountLink path additionally requires a
 * visibilityLevel that grants transaction detail (TRANSACTION_DETAIL_VISIBILITY,
 * lib/ai/visibility.ts — currently FULL only). BALANCE_ONLY / SUMMARY_ONLY
 * links contribute balance / summary data via the accounts assembler only;
 * their transaction rows, merchants, and amounts never enter AI context —
 * neither directly nor through any aggregate in this summary. The legacy path
 * is the Space's own accounts and is FULL by definition.
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
 * can appear. SpaceAccountLink.status = ACTIVE and a transaction-detail-
 * granting visibilityLevel (KD-1) are both enforced on the current path.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - All queries filter by spaceCtx.spaceId.
 * - No raw transaction rows are returned in the ContextDomainSection.
 * - Transaction rows are sourced only from accounts whose link grants
 *   transaction detail (TRANSACTION_DETAIL_VISIBILITY — KD-1); summary and
 *   drilldown share the same predicate constant.
 */

import { db } from '@/lib/db';
import { ShareStatus, TransactionCategory, FlowType } from '@prisma/client';
import type { FlowDirection } from '@prisma/client';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { TRANSACTION_DETAIL_VISIBILITY } from '@/lib/ai/visibility';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  TransactionsSummaryData,
  CategorySpend,
  RecurringCandidate,
  MerchantSummary,
  IncomeSource,
  MonthlyBreakdownEntry,
  TransactionDrilldown,
  DrilldownTransaction,
} from '@/lib/ai/types';
import { normalizeMerchant } from '@/lib/transactions/merchant';
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

// FlowType P5 Slice 7: the legacy INCOME_CATEGORIES / MERCHANT_EXCLUDED_CATEGORIES /
// SPENDING_CATEGORIES sets were deleted after the flow cutover (Slices 4–6) left
// them with zero runtime references. flowType/flowDirection is the single
// semantic authority. BANKING_CATEGORIES above remains: it is list membership
// (resolveCategory drilldown phrase → category), not flow semantics.

/**
 * FlowType P5 Slice 4 (D-1) — the banking-flow row set. Which rows the AI sees
 * is now defined by economic flow, not merchant taxonomy: Dividend rows
 * (flowType=INCOME) and Fee rows (flowType=FEE) become reachable. Excluded:
 * INVESTMENT (security activity, stays in the Investments view), ADJUSTMENT
 * (non-economic artifacts), UNKNOWN (0 rows by the P4 backfill invariant).
 */
const BANKING_FLOWS: FlowType[] = [
  FlowType.SPENDING,
  FlowType.REFUND,
  FlowType.INCOME,
  FlowType.DEBT_PAYMENT,
  FlowType.TRANSFER,
  FlowType.FEE,
  FlowType.INTEREST,
];

/**
 * FlowType P5 Slice 4 (D-2) — flows counted in expenseTotal (gross Σ|amount|):
 * SPENDING, plus FEE (newly reachable), plus INTEREST charges (parity with the
 * legacy fall-through that already counted them). Mirrors the dashboard's
 * Slice-2 FLOW_COST set. REFUND is disclosed separately (refundTotal, D-3) and
 * NEVER netted here — the KD-17 debit-only reconciliation between byCategory
 * and expenseTotal depends on it.
 */
const EXPENSE_FLOWS = new Set<FlowType>([
  FlowType.SPENDING,
  FlowType.FEE,
  FlowType.INTEREST,
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
 * Cap on merchants emitted in the (D6.3A-1) merchant rollup. Grouping happens
 * over all settled rows; only the top N by absolute total are serialized so the
 * context payload stays bounded for Spaces with a long merchant tail.
 */
const MERCHANT_ROLLUP_LIMIT = 25;

/**
 * Cap on income sources emitted in the (D6.3 stabilization) income rollup.
 * Mirrors MERCHANT_ROLLUP_LIMIT: grouping is over all settled inflow rows; only
 * the top N by total are serialized so the payload stays bounded.
 */
const INCOME_SOURCE_ROLLUP_LIMIT = 25;

/** Default / maximum rows returned by a transaction drilldown (D6 evidence). */
const DRILLDOWN_DEFAULT_LIMIT = 15;
const DRILLDOWN_MAX_LIMIT     = 25;

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
  // FlowType P5 Slice 4 — flow semantics. Non-null for every row the
  // BANKING_FLOWS query filter admits (the filter is on flowType itself).
  flowType:      FlowType | null;
  flowDirection: FlowDirection | null;
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
  //   path 2 — FinancialAccount via active SpaceAccountLink (D3 canonical),
  //            restricted to links granting transaction detail (KD-1) so
  //            BALANCE_ONLY / SUMMARY_ONLY accounts never contribute rows.
  // Both deletedAt guards (account-level and transaction-level) are applied.

  // KD-7 truncation sentinel: fetch one row beyond the cap so we can detect
  // deterministically whether the matching set exceeded TRANSACTION_FETCH_LIMIT.
  // Rows are newest-first, so any overflow drops the OLDEST rows — which would
  // silently deflate older-month totals, category/merchant rollups, and trends.
  const fetched: TxnRow[] = await db.transaction.findMany({
    where: {
      OR: [
        {
          account: { spaceId },
        },
        {
          financialAccount: {
            deletedAt:         null,
            spaceAccountLinks: {
              some: {
                spaceId,
                status:          ShareStatus.ACTIVE,
                visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
              },
            },
          },
        },
      ],
      deletedAt: null,
      // FlowType P5 Slice 4 (D-1): row set defined by economic flow, replacing
      // `category: { in: BANKING_CATEGORIES } ` — admits Dividend (INCOME) and
      // Fee (FEE) rows; excludes INVESTMENT/ADJUSTMENT/UNKNOWN.
      flowType:  { in: BANKING_FLOWS },
      // Floor always applied; ceiling only for an explicit past-bounded window.
      date:      win.end ? { gte: win.start, lte: win.end } : { gte: win.start },
    },
    select: {
      date:          true,
      merchant:      true,
      category:      true,
      amount:        true,
      pending:       true,
      flowType:      true,
      flowDirection: true,
    },
    orderBy: { date: 'desc' },
    take:    TRANSACTION_FETCH_LIMIT + 1,
  });

  // Truncated when the sentinel row came back; aggregate only the capped set.
  const truncated = fetched.length > TRANSACTION_FETCH_LIMIT;
  const rows: TxnRow[] = truncated
    ? fetched.slice(0, TRANSACTION_FETCH_LIMIT)
    : fetched;

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
  let refundTotal      = 0;
  let debtPaymentTotal = 0;
  let transferTotal    = 0;

  let largestIncomeRow:  TxnRow | null = null;
  let largestExpenseRow: TxnRow | null = null;

  // KD-17: debit and credit sums are tracked SEPARATELY per category. The old
  // accumulator summed signed amounts and emitted |net| as "total", which let
  // positive rows in a spending category (refunds, credit-card payment credits
  // misclassified as e.g. Other) inflate or deflate the category "spending"
  // figure relative to expenseTotal — which counts debit rows only. See
  // docs/investigations/KD17_TRANSACTION_LEVEL_PROOF.md.
  const categoryMap = new Map<string, { debitTotal: number; creditTotal: number; count: number }>();

  for (const txn of settled) {
    // Category bucket accumulator
    const entry = categoryMap.get(txn.category) ?? { debitTotal: 0, creditTotal: 0, count: 0 };
    if (txn.amount < 0) entry.debitTotal += Math.abs(txn.amount);
    else if (txn.amount > 0) entry.creditTotal += txn.amount;
    entry.count += 1;
    categoryMap.set(txn.category, entry);

    // FlowType P5 Slice 4 — partition by flowType (D-1..D-4). Each settled row
    // lands in exactly one bucket; INVESTMENT/ADJUSTMENT/UNKNOWN never reach
    // this loop (excluded by the BANKING_FLOWS query filter).

    if (txn.flowType === FlowType.TRANSFER) {
      transferTotal += Math.abs(txn.amount);
      continue;
    }

    if (txn.flowType === FlowType.DEBT_PAYMENT) {
      // Source-side legs only (amount < 0). Destination-side INFLOW legs on
      // debt accounts are deliberately excluded — counting both sides would
      // double-count; the per-liability view is Slice 3's DebtClient rollup.
      if (txn.amount < 0) debtPaymentTotal += Math.abs(txn.amount);
      continue;
    }

    if (txn.flowType === FlowType.INCOME) {
      if (txn.amount > 0) {
        incomeTotal += txn.amount;
        if (!largestIncomeRow || txn.amount > largestIncomeRow.amount) {
          largestIncomeRow = txn;
        }
      }
      continue;
    }

    if (txn.flowType === FlowType.REFUND) {
      // D-3: disclosed gross; never netted into expenseTotal (KD-17) and
      // never counted as income (a refund reverses prior spending).
      refundTotal += Math.abs(txn.amount);
      continue;
    }

    // D-2: SPENDING + FEE + INTEREST charges, gross.
    if (txn.flowType !== null && EXPENSE_FLOWS.has(txn.flowType)) {
      expenseTotal += Math.abs(txn.amount);
      if (!largestExpenseRow || Math.abs(txn.amount) > Math.abs(largestExpenseRow.amount)) {
        largestExpenseRow = txn;
      }
    }
  }

  // D-4: refunds offset spend in the net figure; transfers stay excluded.
  const netCashFlow = incomeTotal + refundTotal - expenseTotal - debtPaymentTotal;

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
  // KD-17 universal rule: `total` is the DEBIT-ONLY sum — the exact population
  // expenseTotal and the drilldown aggregate — for every category, including
  // non-spending ones (Income's inflow figure is carried by incomeTotal, not
  // byCategory; its byCategory entry exists for its `count`, which
  // lib/ai/intelligence/annotations.ts reads for incomeTransactionCount).
  // Credits are disclosed separately via `creditTotal`, never netted.
  // Zero-total entries are intentionally KEPT at the window level (count
  // consumers); serialization filters them. Sorted by debit total descending.

  const byCategory: CategorySpend[] = Array.from(categoryMap.entries())
    .map(([category, { debitTotal, creditTotal, count }]): CategorySpend => ({
      category,
      total: Math.round(debitTotal * 100) / 100,
      ...(creditTotal > 0 ? { creditTotal: Math.round(creditTotal * 100) / 100 } : {}),
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
  // KD-7: when truncated, the oldest RETAINED row is the true coverage floor.
  // Rows are date-desc, so the last element is the oldest kept row. The month it
  // falls in had older rows dropped and is therefore incomplete.
  const coverageStartIso = truncated
    ? rows[rows.length - 1].date.toISOString().split('T')[0]
    : win.startIso;
  const monthlyBreakdown = buildMonthlyBreakdown(
    settled,
    pending,
    win.startIso,
    effectiveEndIso,
    truncated ? coverageStartIso.slice(0, 7) : null,
  );

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
      // Slice 4: flow-based exclusion (was category Transfer/Payment).
      if (
        txn.flowType === FlowType.TRANSFER ||
        txn.flowType === FlowType.DEBT_PAYMENT
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

  // ── Merchant rollup (D6.3A-1 + D6.3 stabilization — SPENDING merchants only) ─
  // Groups settled rows by the deterministic canonical merchant key
  // (lib/transactions/merchant.ts) so downstream consumers see one entry per
  // merchant instead of one per raw statement descriptor. `total` is the
  // absolute settled expense sum (mirrors byCategory/cash-flow money
  // conventions); `category` is the merchant's dominant spending category.
  //
  // SPENDING-ONLY (D6.3, flow semantics since Slice 4): only settled
  // flowType=SPENDING rows are grouped here. This is what keeps payroll,
  // internal transfers, debt payments, fees, and refunds out of "top merchants
  // by spend"; inflows are rolled up separately into `incomeSources` below.

  let merchants: MerchantSummary[] | undefined;

  if (scopeHint !== 'brief') {
    type MerchantAgg = {
      canonicalName: string;
      total:         number;                      // absolute settled expense sum
      occurrences:   number;
      firstSeen:     string;                      // YYYY-MM-DD
      lastSeen:      string;                      // YYYY-MM-DD
      categoryCount: Map<string, { count: number; absTotal: number }>;
    };

    const merchantMap = new Map<string, MerchantAgg>();

    for (const txn of settled) {
      // Spending merchants only (Slice 4): one flow predicate replaces the
      // category-exclusion set + sign check. Payroll (INCOME), transfers,
      // debt payments, fees, and refunds structurally cannot surface here.
      if (txn.flowType !== FlowType.SPENDING) continue;

      const { canonicalKey, canonicalName } = normalizeMerchant(txn.merchant);
      const iso = txn.date.toISOString().split('T')[0];
      const abs = Math.abs(txn.amount);

      const agg = merchantMap.get(canonicalKey) ?? {
        canonicalName,
        total:         0,
        occurrences:   0,
        firstSeen:     iso,
        lastSeen:      iso,
        categoryCount: new Map<string, { count: number; absTotal: number }>(),
      };

      agg.total       += abs;
      agg.occurrences += 1;
      if (iso < agg.firstSeen) agg.firstSeen = iso;
      if (iso > agg.lastSeen)  agg.lastSeen  = iso;

      const cat = agg.categoryCount.get(txn.category) ?? { count: 0, absTotal: 0 };
      cat.count    += 1;
      cat.absTotal += abs;
      agg.categoryCount.set(txn.category, cat);

      merchantMap.set(canonicalKey, agg);
    }

    merchants = Array.from(merchantMap.entries())
      .map(([canonicalKey, agg]): MerchantSummary => {
        // Dominant category: most transactions, ties broken by larger abs total.
        let dominant = '';
        let best = { count: -1, absTotal: -1 };
        for (const [category, stat] of agg.categoryCount) {
          if (
            stat.count > best.count ||
            (stat.count === best.count && stat.absTotal > best.absTotal)
          ) {
            dominant = category;
            best = stat;
          }
        }
        return {
          canonicalName: agg.canonicalName,
          canonicalKey,
          occurrences:   agg.occurrences,
          total:         Math.round(agg.total * 100) / 100,
          category:      dominant,
          firstSeen:     agg.firstSeen,
          lastSeen:      agg.lastSeen,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, MERCHANT_ROLLUP_LIMIT);
  }

  // ── Income-source rollup (D6.3 stabilization — INFLOW sources only) ───────
  // Mirror image of the merchant rollup: groups settled INFLOW rows by the same
  // canonical key. Included = positive amount with flowType=INCOME (the same
  // population that feeds the top-level incomeTotal, so the numbers reconcile;
  // includes dividends and interest earned since Slice 4). Transfers are
  // excluded by construction (TRANSFER is a different flow). This is where
  // payroll belongs — never `merchants`.

  let incomeSources: IncomeSource[] | undefined;

  if (scopeHint !== 'brief') {
    type IncomeAgg = {
      canonicalName: string;
      total:         number;                      // positive settled inflow sum
      occurrences:   number;
      firstSeen:     string;                      // YYYY-MM-DD
      lastSeen:      string;                      // YYYY-MM-DD
    };

    const incomeMap = new Map<string, IncomeAgg>();

    for (const txn of settled) {
      // Slice 4: flow-based inclusion (was INCOME_CATEGORIES + sign). Dividend
      // payers now appear as income sources (approved N6).
      if (txn.flowType !== FlowType.INCOME) continue;
      if (txn.amount <= 0) continue;

      const { canonicalKey, canonicalName } = normalizeMerchant(txn.merchant);
      const iso = txn.date.toISOString().split('T')[0];

      const agg = incomeMap.get(canonicalKey) ?? {
        canonicalName,
        total:       0,
        occurrences: 0,
        firstSeen:   iso,
        lastSeen:    iso,
      };

      agg.total       += txn.amount;
      agg.occurrences += 1;
      if (iso < agg.firstSeen) agg.firstSeen = iso;
      if (iso > agg.lastSeen)  agg.lastSeen  = iso;

      incomeMap.set(canonicalKey, agg);
    }

    incomeSources = Array.from(incomeMap.entries())
      .map(([canonicalKey, agg]): IncomeSource => ({
        canonicalName: agg.canonicalName,
        canonicalKey,
        occurrences:   agg.occurrences,
        total:         Math.round(agg.total * 100) / 100,
        firstSeen:     agg.firstSeen,
        lastSeen:      agg.lastSeen,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, INCOME_SOURCE_ROLLUP_LIMIT);
  }

  // ── Drilldown evidence (D6 — only when an explicit drilldown was requested) ─
  // Re-reads real line items behind a category/merchant/period for explainability.
  // Never runs on ordinary prompts (the option is absent) and only reads rows
  // inside the Space's FULL-visibility boundary.
  const drilldown = options.drilldown
    ? await assembleDrilldown(spaceCtx, options.drilldown, win)
    : undefined;

  // ── Assemble payload ──────────────────────────────────────────────────────

  const data: TransactionsSummaryData = {
    windowDays:       win.days,
    startDate:        win.startIso,
    endDate:          newestDate,
    transactionCount: rows.length,

    // KD-7 fetch-cap coverage flags.
    truncated,
    coverageStartDate: coverageStartIso,
    fetchLimit:        TRANSACTION_FETCH_LIMIT,

    incomeTotal:      Math.round(incomeTotal      * 100) / 100,
    expenseTotal:     Math.round(expenseTotal     * 100) / 100,
    refundTotal:      Math.round(refundTotal      * 100) / 100,
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
    ...(merchants !== undefined ? { merchants } : {}),
    ...(incomeSources !== undefined ? { incomeSources } : {}),
    ...(drilldown !== undefined ? { drilldown } : {}),
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
/**
 * KD-17 checked invariant — the reconciliation rule the prompt used to assert
 * as prose only. For any category rollup whose `total` is debit-only (the
 * KD-17 universal rule), the spending categories (caller passes its
 * non-spending name set) must sum to ≤ expenseTotal: both sides aggregate the
 * same debit-row population, and expenseTotal additionally contains debit rows
 * of name-filtered categories (e.g. Interest charges), so equality is NOT
 * expected — only ≤. A violation means the aggregation populations have
 * diverged again (the KD-17 defect class) and the emitted figures cannot be
 * trusted.
 *
 * Pure and side-effect free: returns a violation description or null. The
 * caller decides how to fail (throw in dev, log + annotate in prod).
 * Tolerance is one cent — inputs are 2-dp currency values, so anything larger
 * than float noise is a real divergence.
 */
export interface SpendingInvariantViolation {
  scope:                 string; // e.g. '2026-01' (monthly) or 'window'
  spendingCategorySum:   number;
  expenseTotal:          number;
  excess:                number;
}

export function checkSpendingCategoryInvariant(
  categories:  Pick<CategorySpend, 'category' | 'total'>[],
  expenseTotal: number,
  nonSpending:  ReadonlySet<string>,
  scope:        string,
): SpendingInvariantViolation | null {
  const spendingCategorySum = categories
    .filter((c) => !nonSpending.has(c.category))
    .reduce((s, c) => s + c.total, 0);
  const excess = spendingCategorySum - expenseTotal;
  // Compare in whole cents so IEEE-754 noise at the boundary (e.g.
  // 100.01 − 100.00 === 0.010000000000005) can never trip a false positive.
  if (Math.round(excess * 100) > 1) {
    return {
      scope,
      spendingCategorySum: Math.round(spendingCategorySum * 100) / 100,
      expenseTotal:        Math.round(expenseTotal * 100) / 100,
      excess:              Math.round(excess * 100) / 100,
    };
  }
  return null;
}

// Exported for KD-17 regression tests (lib/ai/assemblers/transactions.kd17.test.ts)
// — no runtime consumer outside this module.
export function buildMonthlyBreakdown(
  settled:  TxnRow[],
  pending:  TxnRow[],
  startIso: string,
  endIso:   string,
  // KD-7: YYYY-MM of the fetch-cap coverage floor, or null when not truncated.
  // The month at this boundary had older rows dropped and is flagged incomplete.
  truncatedMonth: string | null,
): MonthlyBreakdownEntry[] {
  type Bucket = {
    incomeTotal:      number;
    expenseTotal:     number;
    refundTotal:      number;
    debtPaymentTotal: number;
    transferTotal:    number;
    transactionCount: number;
    // KD-17: per-category debit sum + credit sum + settled row count, mirroring
    // the top-level byCategory (debit-only `total`, credits disclosed
    // separately — never a signed net). count mirrors CategorySpend.count.
    categoryAgg:      Map<string, { debitTotal: number; creditTotal: number; count: number }>;
  };

  const buckets = new Map<string, Bucket>();

  const bucketFor = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = {
        incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0,
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
    const agg = b.categoryAgg.get(txn.category) ?? { debitTotal: 0, creditTotal: 0, count: 0 };
    if (txn.amount < 0) agg.debitTotal += Math.abs(txn.amount);
    else if (txn.amount > 0) agg.creditTotal += txn.amount;
    agg.count  += 1;
    b.categoryAgg.set(txn.category, agg);

    // FlowType P5 Slice 4 — same flow partition rules as the window loop.
    if (txn.flowType === FlowType.TRANSFER) {
      b.transferTotal += Math.abs(txn.amount);
    } else if (txn.flowType === FlowType.DEBT_PAYMENT) {
      if (txn.amount < 0) b.debtPaymentTotal += Math.abs(txn.amount);
    } else if (txn.flowType === FlowType.INCOME) {
      if (txn.amount > 0) b.incomeTotal += txn.amount;
    } else if (txn.flowType === FlowType.REFUND) {
      b.refundTotal += Math.abs(txn.amount);
    } else if (txn.flowType !== null && EXPENSE_FLOWS.has(txn.flowType)) {
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
      // categories, non-zero debit total only). This is the authoritative
      // per-month category source — absence means "no classified settled
      // SPENDING (debit rows) this month", never $0. KD-17: `total` is the
      // debit-only sum (same population as expenseTotal and the drilldown);
      // credits are disclosed via `creditTotal`, never netted. A pure-credit
      // category month (refund-only) is dropped rather than shown as phantom
      // spending.
      const byCategory: CategorySpend[] = Array.from(b.categoryAgg.entries())
        .map(([category, { debitTotal, creditTotal, count }]): CategorySpend => ({
          category,
          total: Math.round(debitTotal * 100) / 100,
          ...(creditTotal > 0 ? { creditTotal: Math.round(creditTotal * 100) / 100 } : {}),
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

      // KD-7: the coverage-floor month had older rows dropped by the fetch cap.
      const monthTruncated = truncatedMonth !== null && month === truncatedMonth;

      return {
        month,
        incomeTotal:      Math.round(b.incomeTotal      * 100) / 100,
        expenseTotal:     Math.round(b.expenseTotal     * 100) / 100,
        refundTotal:      Math.round(b.refundTotal      * 100) / 100,
        debtPaymentTotal: Math.round(b.debtPaymentTotal * 100) / 100,
        transferTotal:    Math.round(b.transferTotal    * 100) / 100,
        transactionCount: b.transactionCount,
        ...(partial ? { partial: true } : {}),
        ...(monthTruncated ? { truncated: true } : {}),
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

/** Resolve a free-text category name to a TransactionCategory, or null. */
function resolveCategory(raw: string | undefined): TransactionCategory | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  for (const c of BANKING_CATEGORIES) {
    if (c.toLowerCase() === key) return c;
  }
  return null;
}

/**
 * D6 transaction drilldown — bounded evidence retrieval, NOT a new aggregation
 * engine. Re-reads the real transactions behind a resolved category / merchant /
 * period so the AI can explain "what is this made up of?".
 *
 * Visibility: mirrors the summary's dual-path Space scoping. The
 * FinancialAccount path is restricted to TRANSACTION_DETAIL_VISIBILITY
 * (lib/ai/visibility.ts — the same predicate the summary query uses, so
 * drilldown and summary can never disagree; KD-1) so BALANCE_ONLY /
 * SUMMARY_ONLY accounts never contribute raw line items. The legacy Account
 * path is the Space's own accounts (account.spaceId) and is treated as FULL.
 * Because every surfaced row is FULL-visibility, the source account name is
 * safe to include.
 *
 * Settled rows only (pending excluded) so the shown totals reconcile with the
 * settled category totals elsewhere in the summary. Spending-only (amount < 0)
 * unless the caller explicitly asked about a non-spending category.
 */
async function assembleDrilldown(
  spaceCtx:  SpaceContext,
  request:   NonNullable<AssemblerOptions['drilldown']>,
  defaultWin: { startIso: string; endIso: string | null },
): Promise<TransactionDrilldown | undefined> {
  const { spaceId } = spaceCtx;

  // Window: explicit drilldown bounds win, else fall back to the summary window.
  const startIso = request.startDate ?? defaultWin.startIso;
  const endIso   = request.endDate   ?? defaultWin.endIso ?? new Date().toISOString().split('T')[0];
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end   = new Date(`${endIso}T23:59:59.999Z`);

  const resolvedCategory   = resolveCategory(request.category);
  const includeNonSpending = request.includeNonSpending === true;
  const merchantQuery      = request.merchant?.trim();

  // Category constraint (Slice 4, D-5):
  //   - a specific resolved category → exactly that category (explicit ask)
  //   - includeNonSpending           → any banking-flow row
  //   - default                      → discretionary spending (flowType=SPENDING)
  const categoryWhere = resolvedCategory
    ? { category: resolvedCategory }
    : includeNonSpending
      ? { flowType: { in: BANKING_FLOWS } }
      : { flowType: FlowType.SPENDING };

  // Sign constraint: spending only (amount < 0) unless a non-spending category
  // was explicitly requested (income is positive, etc.).
  const amountWhere = includeNonSpending ? {} : { amount: { lt: 0 } };

  const rows = await db.transaction.findMany({
    where: {
      OR: [
        { account: { spaceId } },
        {
          financialAccount: {
            deletedAt:         null,
            spaceAccountLinks: {
              some: {
                spaceId,
                status:          ShareStatus.ACTIVE,
                visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
              },
            },
          },
        },
      ],
      deletedAt: null,
      pending:   false,
      date:      { gte: start, lte: end },
      ...categoryWhere,
      ...amountWhere,
      ...(merchantQuery ? { merchant: { contains: merchantQuery, mode: 'insensitive' } } : {}),
    },
    select: {
      date:        true,
      merchant:    true,
      description: true,
      category:    true,
      amount:      true,
      account:          { select: { name: true } },
      financialAccount: { select: { name: true, displayName: true } },
    },
    orderBy: { date: 'desc' },
    // KD-7: same LIMIT+1 sentinel as the summary query so a fetch-cap hit here is
    // detected rather than silently under-reporting matchedTotal/totalCount.
    take:    TRANSACTION_FETCH_LIMIT + 1,
  });

  if (rows.length === 0) return undefined;

  const fetchTruncated = rows.length > TRANSACTION_FETCH_LIMIT;
  const capped         = fetchTruncated ? rows.slice(0, TRANSACTION_FETCH_LIMIT) : rows;

  // matchedTotal / totalCount describe the matching set actually aggregated. When
  // fetchTruncated they are a lower bound (older rows beyond the cap are omitted);
  // `truncated` below is forced true so the consumer never implies exhaustiveness.
  const matchedTotal = capped.reduce((s, r) => s + Math.abs(r.amount), 0);
  const totalCount   = capped.length;

  const limit = Math.min(request.limit ?? DRILLDOWN_DEFAULT_LIMIT, DRILLDOWN_MAX_LIMIT);

  const shown = [...capped]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, limit);

  const transactions: DrilldownTransaction[] = shown.map((r) => {
    const accountName =
      r.financialAccount?.displayName ?? r.financialAccount?.name ?? r.account?.name ?? undefined;
    return {
      date:     r.date.toISOString().split('T')[0],
      merchant: normalizeMerchant(r.merchant).canonicalName,
      ...(r.description ? { description: r.description } : {}),
      amount:   Math.round(r.amount * 100) / 100,
      category: r.category,
      ...(accountName ? { accountName } : {}),
    };
  });

  const shownTotal = shown.reduce((s, r) => s + Math.abs(r.amount), 0);

  return {
    ...(resolvedCategory ? { category: resolvedCategory } : {}),
    ...(merchantQuery ? { merchant: merchantQuery } : {}),
    startDate:    startIso,
    endDate:      endIso,
    ...(request.label ? { label: request.label } : {}),
    transactions,
    shownCount:   transactions.length,
    totalCount,
    shownTotal:   Math.round(shownTotal   * 100) / 100,
    matchedTotal: Math.round(matchedTotal * 100) / 100,
    truncated:    fetchTruncated || totalCount > transactions.length,
  };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.TRANSACTIONS_SUMMARY, assembleTransactions);
