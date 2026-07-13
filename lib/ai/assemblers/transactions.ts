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
import { isCostFlow, isRefund, isIncome, isTransfer, isDebtPayment } from '@/lib/transactions/flow-predicates';
// TE-2B — the canonical "needs classification" predicate (single authority; this
// assembler is a consumer, never a fork). TI2-W1: needs-classification aggregates.
import { shouldSurfaceAsNeedsClassification } from '@/lib/transactions/needs-classification';
// TI4 Slice 1 — read-time owned-account transfer matching, the SAME impure wrapper
// the Tab's list reads call (lib/data/transactions.ts:136). TI2-W1 §3.3 parity:
// so a payment-app row the Tab shows as a resolved internal transfer is NOT counted
// here as UNKNOWN_PAYMENT_APP_PURPOSE (a KD-10 cross-surface divergence otherwise).
import { resolveOwnedTransferCounterparties } from '@/lib/transactions/transfer-resolution';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { convertMoney, identityContext } from '@/lib/money/convert';
import { buildSpaceConversionContext } from '@/lib/money/server-context';
import type { ConversionContext } from '@/lib/money/types';
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

// FlowType P5 Slice 4 (D-2) / TI1 — flows counted in expenseTotal (gross
// Σ|amount|): SPENDING + FEE + INTEREST charges. This membership (the former
// local EXPENSE_FLOWS set, which mirrored the dashboard's FLOW_COST) now lives
// in the single-authority predicate `isCostFlow`. REFUND is disclosed
// separately (refundTotal, D-3) and NEVER netted here — the KD-17 debit-only
// reconciliation between byCategory and expenseTotal depends on it.

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
  // TI2-W1 — row identity + account keys, needed to run the read-time transfer
  // matcher (resolveOwnedTransferCounterparties) for counterparty parity (§3.3).
  id:                 string;
  accountId:          string | null;
  financialAccountId: string | null;
  date:     Date;
  merchant: string;   // RAW provider descriptor — preserved for forensic use
  // MI M6 read cutover — resolved Merchant identity (null/absent when unresolved).
  merchantId?:       string | null;
  resolvedMerchant?: { displayName: string } | null;
  category: TransactionCategory;
  amount:   number;
  pending:  boolean;
  // MC1 Phase 2 Slice 4 — Phase 0 provenance stamp; conversion input for the
  // money-context seam below. Null = pre-backfill residue (native
  // pass-through under any context, plan D-3).
  currency: string | null;
  // FlowType P5 Slice 4 — flow semantics. Non-null for every row the
  // BANKING_FLOWS query filter admits (the filter is on flowType itself).
  flowType:      FlowType | null;
  flowDirection: FlowDirection | null;
  // TI2-W1 — canonical inputs to shouldSurfaceAsNeedsClassification (all flat
  // persisted columns). counterpartyAccountId is the PERSISTED provider-confirmed
  // link; the read-time match supplements it (§3.3 parity).
  classificationReason:  string | null;
  transferRail:          string | null;
  counterpartyAccountId: string | null;
};

/**
 * The subset of a row buildMonthlyBreakdown actually reads. Kept narrower than
 * TxnRow so the KD-17 / golden fixtures (which never carry the TI2-W1 identity /
 * needs-classification columns) still satisfy the exported seam unchanged.
 */
type MonthlyRow = Pick<TxnRow, 'date' | 'amount' | 'currency' | 'category' | 'flowType'>;

/**
 * MC1 Phase 2 Slice 4 — a row's amount in the money-context target, converted
 * at the ROW's own date (historical FX per row, plan D-6). Under the Phase 2
 * identityContext this returns txn.amount exactly (identity / native
 * pass-through), so every accumulator below is byte-identical to the
 * pre-threading code — pinned by transactions.golden.test.ts. Sign is
 * preserved by positive rates, so sign-partitioned accumulators (debit vs
 * credit, source-side legs) partition identically.
 */
function amountInTarget(
  txn: { amount: number; currency: string | null; date: Date },
  ctx: ConversionContext,
): { amount: number; estimated: boolean } {
  const c = convertMoney(
    { amount: txn.amount, currency: txn.currency },
    txn.date.toISOString().slice(0, 10),
    ctx,
  );
  return { amount: c.amount, estimated: c.estimated };
}

// ---------------------------------------------------------------------------
// TI2-W1 — needs-classification aggregation (pure; exported for the golden /
// parity tests). The predicate itself lives in one place
// (lib/transactions/needs-classification.ts); this only sums its verdicts into
// the disclosure aggregate. It is DISCLOSURE ONLY — it never feeds any money
// total in the assembler (§3.2 invariant: needs-classification is a review flag,
// never subtracted from Cash In/Out).
// ---------------------------------------------------------------------------

/** The minimal per-row facts the needs-classification aggregate reads. */
export interface NeedsClassificationRow {
  id:                    string;
  flowType:              string | null;
  classificationReason:  string | null;
  transferRail:          string | null;
  merchantId?:           string | null;
  counterpartyAccountId: string | null;
  amount:                number;
  currency:              string | null;
  date:                  Date;
}

export interface NeedsClassificationAggregate {
  count:                  number;
  unknownInflowCount:     number;
  unknownInflowTotal:     number;
  unknownPaymentAppCount: number;
  unknownPaymentAppTotal: number;
}

/**
 * Accumulate the needs-classification disclosure aggregate over the fetched rows
 * (settled + pending both, per §3.1). `resolvedCp` is the set of row ids whose
 * counterparty was resolved at read time by the TI4 matcher — the parity term
 * (§3.3): a row's `hasResolvedCounterparty` is `counterpartyAccountId != null OR
 * read-time-resolved`, IDENTICAL to how the Tab builds the input
 * (lib/data/transactions.ts:190 → deriveTransactionContext). Amounts are in the
 * target currency at each row's own date (identical to every other accumulator).
 */
export function accumulateNeedsClassification(
  rows:       readonly NeedsClassificationRow[],
  resolvedCp: ReadonlySet<string>,
  ctx:        ConversionContext,
): NeedsClassificationAggregate {
  let count = 0;
  let unknownInflowCount = 0;
  let unknownInflowTotal = 0;
  let unknownPaymentAppCount = 0;
  let unknownPaymentAppTotal = 0;

  for (const r of rows) {
    const res = shouldSurfaceAsNeedsClassification({
      flowType:                r.flowType,
      classificationReason:    r.classificationReason,
      transferRail:            r.transferRail,
      hasResolvedMerchant:     r.merchantId != null,
      hasResolvedCounterparty: r.counterpartyAccountId != null || resolvedCp.has(r.id),
    });
    if (!res.needsClassification) continue;

    count += 1;
    const { amount } = amountInTarget(r, ctx);
    if (res.reason === 'UNKNOWN_INFLOW_SOURCE') {
      unknownInflowCount += 1;
      unknownInflowTotal += amount;
    } else if (res.reason === 'UNKNOWN_PAYMENT_APP_PURPOSE') {
      unknownPaymentAppCount += 1;
      unknownPaymentAppTotal += Math.abs(amount);
    }
  }

  return {
    count,
    unknownInflowCount,
    unknownInflowTotal:     Math.round(unknownInflowTotal * 100) / 100,
    unknownPaymentAppCount,
    unknownPaymentAppTotal: Math.round(unknownPaymentAppTotal * 100) / 100,
  };
}

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
      // TI2-W1 — id + account keys for the read-time transfer matcher (§3.3 parity).
      id:                 true,
      accountId:          true,
      financialAccountId: true,
      date:          true,
      merchant:      true,
      // MI M6 read cutover — resolved Merchant identity (additive join).
      merchantId:       true,
      resolvedMerchant: { select: { displayName: true } },
      category:      true,
      amount:        true,
      pending:       true,
      currency:      true, // MC1 Phase 2 Slice 4 — read-only conversion input
      flowType:      true,
      flowDirection: true,
      // TI2-W1 — flat canonical inputs to the needs-classification predicate.
      classificationReason:  true,
      transferRail:          true,
      counterpartyAccountId: true,
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

  // MC1 Phase 3 Slice 4 — THE AI FLIP (plan seam #4). One real space context
  // for every accumulator in this assembler, prefetched over each fetched
  // row's OWN transaction date (historical FX per row, plan D-6). All-USD
  // Spaces are numerically identical to the Phase 2 identity behavior
  // (equivalence gates); unresolvable rows degrade per D-3 (native +
  // estimated) and taint the summary's `estimated` flag — data-only, no
  // prompt/serializer change (presentation is Phase 4). Identity fallback
  // only if the Space row vanished mid-request.
  const spaceRow = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const moneyCtx = spaceRow
    ? await buildSpaceConversionContext(spaceRow, {
        currencies: rows.map((r) => r.currency),
        dates:      [...new Set(rows.map((r) => r.date.toISOString().slice(0, 10)))],
      })
    : identityContext(DEFAULT_DISPLAY_CURRENCY);

  // ── TI2-W1: needs-classification disclosure aggregate ─────────────────────
  // §3.3 counterparty parity: only pay for the read-time transfer matcher when
  // an unresolved payment-app row actually exists in the window (the common
  // case has none — one array scan to detect). Without such a row, a read-time
  // match could not change any needs-classification verdict, so the extra
  // queries are pure waste. When present, we call the SAME wrapper the Tab's
  // list reads use, so a resolved internal transfer is not miscounted as
  // UNKNOWN_PAYMENT_APP_PURPOSE (KD-10 cross-surface consistency).
  const hasUnresolvedPaymentApp = rows.some(
    (r) => r.transferRail === 'PAYMENT_APP' && r.counterpartyAccountId == null,
  );
  const resolvedCp = hasUnresolvedPaymentApp
    ? new Set((await resolveOwnedTransferCounterparties(rows, { spaceId })).keys())
    : new Set<string>();
  const needsClassification = accumulateNeedsClassification(rows, resolvedCp, moneyCtx);

  // MC1 P3 Slice 4 (D-7) — window-level taint, mirrors the monthly buckets.
  let windowEstimated = false;

  let incomeTotal      = 0;
  let expenseTotal     = 0;
  let refundTotal      = 0;
  let debtPaymentTotal = 0;
  let transferTotal    = 0;

  let largestIncomeRow:  TxnRow | null = null;
  let largestIncomeAmt   = 0; // largestIncomeRow's amount in target units
  let largestExpenseRow: TxnRow | null = null;
  let largestExpenseAmt  = 0; // |largestExpenseRow| in target units

  // KD-17: debit and credit sums are tracked SEPARATELY per category. The old
  // accumulator summed signed amounts and emitted |net| as "total", which let
  // positive rows in a spending category (refunds, credit-card payment credits
  // misclassified as e.g. Other) inflate or deflate the category "spending"
  // figure relative to expenseTotal — which counts debit rows only. See
  // docs/investigations/KD17_TRANSACTION_LEVEL_PROOF.md.
  const categoryMap = new Map<string, { debitTotal: number; creditTotal: number; count: number }>();

  for (const txn of settled) {
    // MC1 Phase 2 Slice 4 — one converted amount per row drives every
    // accumulator and comparison below; MC1 P3 Slice 4 — the same conversion
    // carries the estimated taint into the window flag.
    const conv = amountInTarget(txn, moneyCtx);
    const amt = conv.amount;
    if (conv.estimated) windowEstimated = true;

    // Category bucket accumulator
    const entry = categoryMap.get(txn.category) ?? { debitTotal: 0, creditTotal: 0, count: 0 };
    if (amt < 0) entry.debitTotal += Math.abs(amt);
    else if (amt > 0) entry.creditTotal += amt;
    entry.count += 1;
    categoryMap.set(txn.category, entry);

    // FlowType P5 Slice 4 — partition by flowType (D-1..D-4). Each settled row
    // lands in exactly one bucket; INVESTMENT/ADJUSTMENT/UNKNOWN never reach
    // this loop (excluded by the BANKING_FLOWS query filter).

    if (isTransfer(txn.flowType)) {
      transferTotal += Math.abs(amt);
      continue;
    }

    if (isDebtPayment(txn.flowType)) {
      // Source-side legs only (amount < 0). Destination-side INFLOW legs on
      // debt accounts are deliberately excluded — counting both sides would
      // double-count; the per-liability view is Slice 3's DebtClient rollup.
      if (amt < 0) debtPaymentTotal += Math.abs(amt);
      continue;
    }

    if (isIncome(txn.flowType)) {
      if (amt > 0) {
        incomeTotal += amt;
        // Largest selected in TARGET units (identical under identity); the row
        // object itself keeps its native amount for downstream serialization.
        if (!largestIncomeRow || amt > largestIncomeAmt) {
          largestIncomeRow = txn;
          largestIncomeAmt = amt;
        }
      }
      continue;
    }

    if (isRefund(txn.flowType)) {
      // D-3: disclosed gross; never netted into expenseTotal (KD-17) and
      // never counted as income (a refund reverses prior spending).
      refundTotal += Math.abs(amt);
      continue;
    }

    // D-2: SPENDING + FEE + INTEREST charges, gross.
    if (isCostFlow(txn.flowType)) {
      expenseTotal += Math.abs(amt);
      if (!largestExpenseRow || Math.abs(amt) > largestExpenseAmt) {
        largestExpenseRow = txn;
        largestExpenseAmt = Math.abs(amt);
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
    // MC1 P2 Slice 4 threading; P3 Slice 4 real context + taint.
    const conv = amountInTarget(txn, moneyCtx);
    const amt = conv.amount;
    if (conv.estimated) windowEstimated = true;
    if (amt > 0) {
      pendingCreditCount++;
      pendingCreditTotal += amt;
    } else {
      pendingDebitCount++;
      pendingDebitTotal += Math.abs(amt);
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
    moneyCtx, // MC1 P2 Slice 4 — identity today; Phase 3 flips the target here too
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
      if (isTransfer(txn.flowType) || isDebtPayment(txn.flowType)) continue;

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

  // MI M6 read cutover — group + display by the RESOLVED Merchant identity when
  // present (so aliases like "WALMART #1842" / "WM SUPERCENTER" collapse to one
  // "Walmart"), falling back to the per-request normalizer for unresolved rows.
  // The raw descriptor stays on txn.merchant for forensic use.
  function merchantGroupOf(txn: TxnRow): { key: string; name: string } {
    if (txn.merchantId && txn.resolvedMerchant) {
      return { key: `id:${txn.merchantId}`, name: txn.resolvedMerchant.displayName };
    }
    const { canonicalKey, canonicalName } = normalizeMerchant(txn.merchant);
    return { key: canonicalKey, name: canonicalName };
  }

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

      const { key: canonicalKey, name: canonicalName } = merchantGroupOf(txn);
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

      const { key: canonicalKey, name: canonicalName } = merchantGroupOf(txn);
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
    estimated:        windowEstimated, // MC1 P3 Slice 4 (D-7) — data-only until Phase 4

    pendingCreditCount,
    pendingCreditTotal: Math.round(pendingCreditTotal * 100) / 100,
    pendingDebitCount,
    pendingDebitTotal:  Math.round(pendingDebitTotal  * 100) / 100,

    // TI2-W1 — needs-classification disclosure aggregate (six scalars). Purely
    // additive: no money total above is affected. counterpartyResolution reports
    // that read-time parity was applied (§3.3 option (a), not the PERSISTED_ONLY
    // fallback).
    needsClassification: {
      ...needsClassification,
      counterpartyResolution: 'PERSISTED_AND_READ_TIME' as const,
    },

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
  settled:  MonthlyRow[],
  pending:  MonthlyRow[],
  startIso: string,
  endIso:   string,
  // KD-7: YYYY-MM of the fetch-cap coverage floor, or null when not truncated.
  // The month at this boundary had older rows dropped and is flagged incomplete.
  truncatedMonth: string | null,
  // MC1 Phase 2 Slice 4 — optional money context. Absent ⇒ raw native sums,
  // byte-for-byte the pre-threading behavior (kd17's call sites are unchanged);
  // the assembler passes its identity context (identical output, golden-pinned).
  ctx?: ConversionContext,
): MonthlyBreakdownEntry[] {
  type Bucket = {
    incomeTotal:      number;
    expenseTotal:     number;
    refundTotal:      number;
    debtPaymentTotal: number;
    transferTotal:    number;
    transactionCount: number;
    // MC1 Phase 3 Slice 2 (D-7) — any converted row in this month was
    // estimated (walk-back / miss / null-residue). False without a context.
    estimated:        boolean;
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
        transferTotal: 0, transactionCount: 0, estimated: false, categoryAgg: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  // Settled rows drive money totals + category sums (same rules as the main loop).
  for (const txn of settled) {
    // MC1 Phase 2 Slice 4 — per-row target amount (native when no ctx).
    // MC1 Phase 3 Slice 2 — the same conversion carries the estimated taint (D-7).
    const b = bucketFor(monthKey(txn.date));
    let amt = txn.amount;
    if (ctx) {
      const c = amountInTarget(txn, ctx);
      amt = c.amount;
      if (c.estimated) b.estimated = true;
    }
    b.transactionCount += 1;
    const agg = b.categoryAgg.get(txn.category) ?? { debitTotal: 0, creditTotal: 0, count: 0 };
    if (amt < 0) agg.debitTotal += Math.abs(amt);
    else if (amt > 0) agg.creditTotal += amt;
    agg.count  += 1;
    b.categoryAgg.set(txn.category, agg);

    // FlowType P5 Slice 4 — same flow partition rules as the window loop.
    if (isTransfer(txn.flowType)) {
      b.transferTotal += Math.abs(amt);
    } else if (isDebtPayment(txn.flowType)) {
      if (amt < 0) b.debtPaymentTotal += Math.abs(amt);
    } else if (isIncome(txn.flowType)) {
      if (amt > 0) b.incomeTotal += amt;
    } else if (isRefund(txn.flowType)) {
      b.refundTotal += Math.abs(amt);
    } else if (isCostFlow(txn.flowType)) {
      b.expenseTotal += Math.abs(amt);
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
        estimated:        b.estimated, // MC1 P3 Slice 2 (D-7) — always emitted, rendered nowhere yet
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
      // MI M6 read cutover — resolved Merchant identity (additive join).
      merchantId:       true,
      resolvedMerchant: { select: { displayName: true } },
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
      // MI M6 read cutover — resolved Merchant display name, else the normalizer.
      merchant: r.resolvedMerchant?.displayName ?? normalizeMerchant(r.merchant).canonicalName,
      // Forensic preservation — the original provider descriptor is never lost.
      ...(r.merchant !== (r.resolvedMerchant?.displayName ?? normalizeMerchant(r.merchant).canonicalName) ? { rawMerchant: r.merchant } : {}),
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
