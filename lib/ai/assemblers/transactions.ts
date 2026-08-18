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
 * Transactions reach a Space via the canonical path (mirroring
 * lib/data/transactions.ts): transaction.financialAccount via an ACTIVE
 * SpaceAccountLink (D3 canonical). Transaction.deletedAt is always filtered to
 * null (D2 Step 4D-R soft-delete guard).
 *
 * KD-1 (2026-07-02): the SpaceAccountLink path additionally requires a
 * visibilityLevel that grants transaction detail (TRANSACTION_DETAIL_VISIBILITY,
 * lib/ai/visibility.ts — currently FULL only). BALANCE_ONLY / SUMMARY_ONLY
 * links contribute balance / summary data via the accounts assembler only;
 * their transaction rows, merchants, and amounts never enter AI context —
 * neither directly nor through any aggregate in this summary.
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
import type { FlowDirection, Prisma } from '@prisma/client';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { } from '@/lib/ai/visibility';
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
import { isCostFlow, isIncome, isTransfer, isDebtPayment, isAdjustment, isNonEconomicResidue } from '@/lib/transactions/flow-predicates';
// REVIEW-3 C-1 — THE economic fold. The window and monthly money folds below are
// consumers of the SAME primitives the Cash Flow workspace folds with
// (lib/transactions/cash-flow.ts): foldEconomicRow decides which bucket a row's
// magnitude lands in, clampEconomicSpend is the sole netting/clamp site. This
// assembler re-implemented that 3-way branch three times; it now re-implements
// it zero times, and lib/ai/fold-enrolment.test.ts pins the enrolment.
import { foldEconomicRow, clampEconomicSpend, type EconomicAccumulator } from '@/lib/transactions/cash-flow';
// REVIEW-3 C-2 — the canonical income taxonomy, run over the SAME evidence the
// product DTO path feeds it (lib/transactions/serialize.ts). The payload's
// incomeByClass / incomeSourcesByClass / incomeExcluded previously read
// `(txn as {incomeClass?: string}).incomeClass` — NOT a Prisma column, derived
// nowhere on this path — and therefore shipped structurally empty while claiming
// to be the canonical income composition.
import { attributeIncome, type IncomeAttribution } from '@/lib/transactions/income-source';
import { liabilityInflowIsCustomerPayment } from '@/lib/transactions/liability-inflow';
import type { FlowAuthorityName } from '@/lib/transactions/flow-authority';
// REVIEW-3 C-3 — THE debt-payment authority. debtPaymentTotal is the CASH-leg
// selection (selectDebtPaymentCashLegs), never `isDebtPayment && amt < 0`: the
// old proxy counted unattested provider-categorised rows the authority refuses,
// and missed transfer-typed rows whose destination the transfer authority proved
// to be a liability.
import { selectDebtPaymentCashLegs } from '@/lib/transactions/debt-payment-authority';
import { tierResolver, type LiquidityTx } from '@/lib/transactions/liquidity';
import { resolveTransferAssessments } from '@/lib/transactions/transfer-resolution';
import { dispositionForMaturity } from '@/lib/transactions/transfer-evidence';
// REVIEW-3 B-6 — the one clock (lib/time). This file carried two of the three
// recorded lib/ai inline day derivations; the clock-authority guard now scans
// lib/ai like everything else.
import { todayUTCISO } from '@/lib/time/clock';
// TE-2B — the canonical "needs classification" predicate (single authority; this
// assembler is a consumer, never a fork). TI2-W1: needs-classification aggregates.
import { shouldSurfaceAsNeedsClassification } from '@/lib/transactions/needs-classification';
// TI4 Slice 1 / REVIEW-3 C — read-time transfer assessments, the SAME canonical
// entry point the Tab's list reads call (lib/data/transactions.ts). TI2-W1 §3.3
// parity for needs-classification, plus the maturity verdicts the debt-payment
// authority's attestation reads.
// v2.6-TRUTH-10 — the ONE account-identity authority, and the select that makes
// it answerable. A read that omits a name column silently downgrades the answer.
import { accountDisplayName, ACCOUNT_NAME_SELECT } from '@/lib/accounts/display-identity';
// v2.6-BRIEF-1 — the flow-derived spending/non-spending taxonomy. The ONE owner
// of that membership; the brief-scope category cap reads it rather than
// re-listing {Income, Transfer, Payment} by hand.
import { NON_SPENDING_CATEGORY_NAMES } from '@/lib/ai/spending-categories';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { convertMoney, identityContext } from '@/lib/money/convert';
import { buildSpaceConversionContext, buildSpaceConversionContextById } from '@/lib/money/server-context';
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
 * P2-7B — the CANONICAL banking population, consumed instead of a separate
 * per-assembler flow allow-list. This is the ROW-INCLUSION rule the whole
 * product now shares: `flowType: { not: INVESTMENT }` (the same `BANKING_POPULATION`
 * fragment lib/data/transactions.ts applies; row-level predicate
 * `isBankingPopulation`). Prisma scalar `not` returns null rows too, so UNKNOWN,
 * ADJUSTMENT, and unclassified (null) rows are ADMITTED — closing the P2-2/P2-7A
 * divergence where the old `BANKING_FLOWS` allow-list silently dropped rows the
 * UI/data layer still showed.
 *
 * Admitting them is a VISIBILITY change, not an economics change: the settled /
 * pending / monthly money folds below gate on `isNonEconomicResidue`, so an
 * UNKNOWN / ADJUSTMENT / null row is counted (transactionCount) and surfaced
 * (needs-classification + the unclassified/adjustment disclosure) but NEVER folds
 * into byCategory / income / spend / refund / debt / net (doctrine: an
 * ADJUSTMENT is not spending, an UNKNOWN is not income). INVESTMENT stays out —
 * it is the sole flow outside the banking population.
 */
// v2.6-POP-1 — IMPORTED, no longer redeclared. This file used to carry its own
// copy of the fragment with the same name and the same defect: `not: INVESTMENT`
// drops NULLs, so the AI's "canonical banking population" silently excluded every
// unclassified row while its comment claimed the opposite. Leaving the duplicate
// after fixing the canonical one would be strictly worse than the original bug —
// two constants, one name, two meanings, no way to notice.
//
// Both `where` clauses in this file are OR-free, so the fragment's new OR arm
// spreads safely. This is a deduplication, NOT the AI read-boundary convergence
// (event projection, economic-date windowing, transfer assessments) — those
// remain open and are tracked separately.
// v2.6-PARITY-1 — `bankingTransactionWhere` is now the AI's population too. The
// bare `BANKING_POPULATION` fragment is no longer imported here: consuming the
// half without the Space gate and the event projection is exactly how this file
// came to read a population no other surface did.
import { bankingTransactionWhere } from "@/lib/data/banking-population";

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
  // TI2-W1 — row identity + account key, needed to run the read-time transfer
  // matcher (resolveOwnedTransferCounterparties) for counterparty parity (§3.3).
  id:                 string;
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
  // FlowType P5 Slice 4 — flow semantics. P2-7B: the canonical banking
  // population (`not: INVESTMENT`) admits UNKNOWN / ADJUSTMENT / null too, so
  // flowType can now be null here (non-economic residue — counted, never money-folded).
  flowType:      FlowType | null;
  // v2.6-TRUTH-2 — supersession + movement-form evidence. The AI payload runs the
  // SAME read-time matcher as the UI, so it must supply the same facts or it
  // would receive the old, over-resolving answer while the UI receives the
  // corrected one.
  settlementState: string | null;
  pfcDetailed:     string | null;
  // v2.6-TRUTH-3 — provider FAMILY, for the liability-inflow authority.
  pfcPrimary:      string | null;
  // REVIEW-3 C-2 — WHO wrote the flow facts. The canonical income taxonomy
  // refuses a row the on-chain ledger owns (rung 0); without this it cannot tell.
  flowAuthority:   FlowAuthorityName | null;
  flowDirection: FlowDirection | null;
  // TI2-W1 — canonical inputs to shouldSurfaceAsNeedsClassification (all flat
  // persisted columns). counterpartyAccountId is the PERSISTED provider-confirmed
  // link; the read-time match supplements it (§3.3 parity).
  classificationReason:  string | null;
  transferRail:          string | null;
  counterpartyAccountId: string | null;
  // Financial Truth (Transfer Authority) — the AI payload runs the SAME matcher
  // as the UI, so it must supply the same facts. `counterpartyType` decides the
  // external terminal leaves; `description` is read by the IDENTIFIER extractor
  // and never by anything that could surface a provider token to the model.
  counterpartyType: string | null;
  description:      string | null;
  // L8-B — the CANONICAL financial date the model reasons about. `date` stays as
  // posting provenance; every chronology read below uses this one, so the AI's
  // months, buckets and "largest expense on ..." agree with what the UI shows.
  economicDate:     Date | null;
};

/**
 * The subset of a row buildMonthlyBreakdown actually reads. Kept narrower than
 * TxnRow so the KD-17 / golden fixtures (which never carry the TI2-W1 identity /
 * needs-classification columns) still satisfy the exported seam unchanged.
 */
type MonthlyRow = Pick<TxnRow, 'date' | 'amount' | 'currency' | 'category' | 'flowType'>
  // L8-B — OPTIONAL here, and only here. The KD-17 / spending-trends golden
  // fixtures predate the column and construct rows by hand; `econOf` falls back
  // to `date` for them. A LIVE row always carries it (backfill + dual-write +
  // audit:economic-date), so this cannot mix chronologies on real data.
  & { economicDate?: Date | null }
  // REVIEW-3 C — row identity, needed only when the caller supplies authority
  // verdicts (debt-payment membership / income class) keyed by id. Optional so
  // the KD-17 golden fixtures, which construct rows by hand, are unaffected.
  & { id?: string };

/**
 * L8-B — the canonical financial date of a row.
 *
 * ⚠️ Falls back to `date` ONLY for a golden fixture that predates the column
 * (`economicDate` absent, not null). A live row always carries it — the backfill,
 * dual-write and `audit:economic-date` guarantee that — so this can never
 * silently mix chronologies on real data.
 */
function econOf(r: { date: Date; economicDate?: Date | null }): Date {
  return r.economicDate ?? r.date;
}

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
): { amount: number | null; estimated: boolean } {
  const c = convertMoney(
    { amount: txn.amount, currency: txn.currency },
    econOf(txn).toISOString().slice(0, 10),
    ctx,
  );
  // V25-FINAL-1 — `amount` is null when the conversion is UNAVAILABLE (no rate):
  // callers EXCLUDE the row from their totals (never a native magnitude / fake 0);
  // `estimated` is already true so the bucket's approximate-disclosure still fires.
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
    // V25-FINAL-1 — count the row, but EXCLUDE an unconvertible amount from the
    // money sub-total (never a native magnitude / fake 0).
    if (res.reason === 'UNKNOWN_INFLOW_SOURCE') {
      unknownInflowCount += 1;
      if (amount !== null) unknownInflowTotal += amount;
    } else if (res.reason === 'UNKNOWN_PAYMENT_APP_PURPOSE') {
      unknownPaymentAppCount += 1;
      if (amount !== null) unknownPaymentAppTotal += Math.abs(amount);
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
// The AI read boundary
// ---------------------------------------------------------------------------

/**
 * v2.6-PARITY-1 — THE population the AI reasons over. It is the product's.
 *
 * ── What this used to be ────────────────────────────────────────────────────
 *
 * A hand-built `where` that restated the KD-15 visibility gate, spread
 * `BANKING_POPULATION`, applied NO event projection, and filtered its window on
 * `date` while every bucket downstream keyed on `econOf`. Four statements of
 * rules stated canonically elsewhere, and the model reasoned over their result.
 *
 * ── What it is now ──────────────────────────────────────────────────────────
 *
 * `bankingTransactionWhere` — the same fragment the transaction list, the
 * explorer, the count, the exports and every audit read — AND-ed with a window
 * on `economicDate`. That single substitution closes all three axes at once:
 * the gate is stated once, the event projection comes along with it, and the
 * basis is the one TIME_MODEL rule B1 requires of a flow read.
 *
 * ⚠️ Composed with `AND`, never by spreading. `bankingTransactionWhere` carries
 * an `AND` (population) and an `OR` (event projection); spreading it beside any
 * other fragment that has either key silently discards one of them. That hazard
 * is why this reads the way it does, and `transactions.parity.test.ts` pins it.
 *
 * ── Measured effect of the cutover (audit-ai-read-parity, live corpus) ───────
 *
 *   axis 1  event projection : 0 rows — no live row is superseded today, so the
 *                              projection changes nothing. It is a GUARANTEE
 *                              acquired, not a defect fixed.
 *   axis 3  gate drift       : 0 rows — the two statements happened to agree.
 *   axis 2  basis            : 2 rows / $102.71 (30d), 6 / $445.89 (90d),
 *                              7 / $240.15 (full span). All at the window FLOOR:
 *                              rows that posted inside the window but happened
 *                              before it. `economicDate <= date` on all 4,405
 *                              live rows, so the correction can only ever move
 *                              the floor edge, never the ceiling.
 *
 * The AI's totals move by those floor rows and nothing else.
 */
export function aiTransactionWhere(
  spaceId: string,
  win: { start: Date; end: Date | null },
): Prisma.TransactionWhereInput {
  return {
    AND: [
      // KD-15 visibility, deletedAt on both levels, the banking population and
      // the event projection — one statement, shared with the whole product.
      bankingTransactionWhere(spaceId),
      // TIME_MODEL rule B1 — a FLOW read filters on the economic date. Floor
      // always applied; ceiling only for an explicit past-bounded window.
      { economicDate: win.end ? { gte: win.start, lte: win.end } : { gte: win.start } },
    ],
  };
}

/**
 * v2.6-PARITY-1 — the DRILLDOWN's population. Also the product's.
 *
 * The drilldown is the AI's EVIDENCE path: "what is this made of?" It answers by
 * re-reading real rows, so a row it can reach that no product surface can show
 * is a row the model can cite and the user cannot find.
 *
 * It carried the same three divergences as the summary query, plus one of its
 * own: on the CATEGORY path (`categoryWhere = { category: X }`) the banking
 * population was not applied AT ALL — only the `includeNonSpending` path applied
 * it. So an INVESTMENT row filed under a banking category was drillable and
 * otherwise invisible. Measured before the change: 0 such rows on the live
 * corpus (nothing INVESTMENT-flagged carries a banking category today), so this
 * closes a structural hole rather than a live leak.
 *
 * ⚠️ AND-composed, for the same reason as above: `categoryWhere` may itself BE
 * `BANKING_POPULATION` (an `{ AND: [...] }`), and `bankingTransactionWhere`
 * carries both an `AND` and an `OR`. Spreading any two of these into one object
 * literal drops keys silently. That is precisely the bug shape this file used to
 * have, and the reason the composition is explicit.
 *
 * `pending: false` stays — the drilldown deliberately cites settled rows only.
 */
export function aiDrilldownWhere(
  spaceId: string,
  win:     { start: Date; end: Date },
  parts:   {
    categoryWhere: Prisma.TransactionWhereInput;
    amountWhere:   Prisma.TransactionWhereInput;
    merchantQuery: string | undefined;
  },
): Prisma.TransactionWhereInput {
  return {
    AND: [
      bankingTransactionWhere(spaceId),
      // Rule B1 — the drilldown is a flow read; its window is economic.
      { pending: false, economicDate: { gte: win.start, lte: win.end } },
      parts.categoryWhere,
      parts.amountWhere,
      ...(parts.merchantQuery
        ? [{ merchant: { contains: parts.merchantQuery, mode: 'insensitive' as const } }]
        : []),
    ],
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

  // v2.6-ASSESS-2 — the DECLARED monthly-expense baseline, read from the same
  // `emergency_fund_progress` config the Liquidity workspace and the Overview EF
  // hero divide by. Reading it here puts both candidate baselines on one object
  // so the authority can choose; without it the engine could only ever see the
  // measured one, and "declared outranks measured" would be a rule with no rung.
  const efSection = await db.spaceDashboardSection.findFirst({
    where:  { spaceId, key: 'emergency_fund_progress' },
    select: { config: true },
  });
  const rawDeclared = Number(
    (efSection?.config as { monthlyExpenses?: unknown } | null)?.monthlyExpenses,
  );
  const declaredMonthlyExpenses: number | null =
    Number.isFinite(rawDeclared) && rawDeclared > 0 ? rawDeclared : null;

  // ── Query ─────────────────────────────────────────────────────────────────
  // Mirrors the canonical scope in lib/data/transactions.ts: FinancialAccount
  // via an active SpaceAccountLink (D3 canonical), restricted to links granting
  // transaction detail (KD-1) so BALANCE_ONLY / SUMMARY_ONLY accounts never
  // contribute rows. Both deletedAt guards (account- and transaction-level) apply.

  // KD-7 truncation sentinel: fetch one row beyond the cap so we can detect
  // deterministically whether the matching set exceeded TRANSACTION_FETCH_LIMIT.
  // Rows are newest-first, so any overflow drops the OLDEST rows — which would
  // silently deflate older-month totals, category/merchant rollups, and trends.
  const fetched: TxnRow[] = await db.transaction.findMany({
    where: aiTransactionWhere(spaceId, win),
    select: {
      // TI2-W1 — id + account key for the read-time transfer matcher (§3.3 parity).
      id:                 true,
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
      // v2.6-TRUTH-2 — see TxnRow.
      settlementState:       true,
      pfcDetailed:           true,
      pfcPrimary:            true,
      // REVIEW-3 C-2 — income-taxonomy evidence (rung 0: on-chain refusal).
      flowAuthority:         true,
      // Financial Truth (Transfer Authority) — see TxnRow.
      counterpartyType:      true,
      description:           true,
      // L8-B — the canonical financial chronology.
      economicDate:          true,
    },
    // v2.6-PARITY-1 / rule B1 — a flow read ORDERS on the economic date too.
    // This is load-bearing, not cosmetic: the KD-7 sentinel below takes
    // newest-first and drops the OLDEST rows past the cap, so ordering on
    // posting would truncate a different set than the window admits.
    orderBy: { economicDate: 'desc' },
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
        dates:      [...new Set(rows.map((r) => econOf(r).toISOString().slice(0, 10)))],
      })
    : identityContext(DEFAULT_DISPLAY_CURRENCY);

  // ── REVIEW-3 C — ONE read-time transfer-assessment pass, reused three ways ──
  // The Tab's list reads run the transfer-assessment ladder per row
  // (lib/data/transactions.ts); this assembler now runs the SAME canonical entry
  // point once and reuses its verdicts for:
  //   1. needs-classification counterparty parity (TI2-W1 §3.3 — the previous
  //      resolveOwnedTransferCounterparties call was a projection of this);
  //   2. the debt-payment authority's attestation input (transferMaturity);
  //   3. the movement-form disposition the liquidity classifier reads.
  const assessments = await resolveTransferAssessments(rows, { spaceId });
  const resolvedCp = new Set(
    [...assessments].filter(([, a]) => a.counterpartyAccountId != null).map(([id]) => id),
  );
  const needsClassification = accumulateNeedsClassification(rows, resolvedCp, moneyCtx);

  // Account id → type for the liquidity tier resolver and the income taxonomy.
  // IDs + types only — classification input, never disclosure; nothing from this
  // query reaches the payload.
  const spaceAccountTypes = await db.spaceAccountLink.findMany({
    where:  { spaceId, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
    select: { financialAccount: { select: { id: true, type: true } } },
  });
  const accountTypeById = new Map(
    spaceAccountTypes.map((l) => [l.financialAccount.id, l.financialAccount.type]),
  );
  const liqCtx = tierResolver(
    spaceAccountTypes.map((l) => ({ id: l.financialAccount.id, type: l.financialAccount.type })),
  );

  // ── REVIEW-3 C-2 — the REAL canonical income classification ────────────────
  // Same gate and same evidence as the product DTO path
  // (lib/transactions/serialize.ts → attributeIncome): attributed only for
  // positive INCOME rows; the read-time transfer match is deliberately NOT
  // consulted (the serializer refuses to guess from cross-row state, so this
  // path must too — parity, not caution). The classes here are therefore the
  // classes every product surface shows for the same rows.
  const incomeAttrById = new Map<string, IncomeAttribution>();
  for (const r of rows) {
    if (!(r.amount > 0 && isIncome(r.flowType))) continue;
    const acctType = (r.financialAccountId ? accountTypeById.get(r.financialAccountId) : null) ?? 'other';
    incomeAttrById.set(r.id, attributeIncome({
      flowType:       r.flowType,
      flowAuthority:  r.flowAuthority,
      providerFamily: r.pfcPrimary,
      providerDetail: r.pfcDetailed,
      accountType:    acctType,
      amount:         r.amount,
      isOwnedInternalTransfer: r.counterpartyAccountId != null,
      sourceAccountId: r.financialAccountId,
      liabilityInflowIsIssuerCredit:
        acctType === 'debt' &&
        liabilityInflowIsCustomerPayment({
          providerFamily:                 r.pfcPrimary,
          persistedCounterpartyAccountId: r.counterpartyAccountId,
        }).verdict === 'NO',
    }));
  }

  // ── REVIEW-3 C-3 — the debt-payment authority selects what counts ──────────
  // `selectDebtPaymentCashLegs` (the ONE answer to "how much did I pay toward
  // debt?") decides membership from classifyLiquidity over the enriched rows:
  // CASH legs count once; liability-side legs are excluded (double count);
  // unattested provider-categorised rows are refused; transfer-typed rows whose
  // destination the transfer authority proved to be a liability are admitted.
  // The old inline proxy (`isDebtPayment && amt < 0`) got all three wrong ways.
  const asLiquidityTx = (r: TxnRow): LiquidityTx => {
    const a    = assessments.get(r.id);
    const attr = incomeAttrById.get(r.id);
    return {
      id:                    r.id,
      accountId:             r.financialAccountId,
      financialAccountId:    r.financialAccountId,
      amount:                r.amount,
      flowType:              r.flowType,
      flowDirection:         r.flowDirection,
      counterpartyAccountId: r.counterpartyAccountId ?? a?.counterpartyAccountId ?? null,
      transferMaturity:      a?.maturity ?? null,
      transferDisposition:   a?.maturity ? dispositionForMaturity(a.maturity) : null,
      incomeClass:           attr?.incomeClass ?? null,
      incomeSubtype:         attr?.subtype ?? null,
    } as unknown as LiquidityTx;
  };
  const debtSelection  = selectDebtPaymentCashLegs(settled.map(asLiquidityTx), liqCtx);
  const debtCountedIds = new Set(debtSelection.counted.map((t) => t.id));

  // MC1 P3 Slice 4 (D-7) — window-level taint, mirrors the monthly buckets.
  let windowEstimated = false;

  // REVIEW-3 C-1 — the economic accumulator IS the canonical one. incomeTotal /
  // expenseTotal / refundTotal below are projections of it: income, GROSS spend
  // (a deliberately different measure from the workspace's clamped spend — see
  // the payload comment), refunds. The fold itself is foldEconomicRow.
  const eco: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  // v2.6-TRUTH-5 — the canonical breakdown. Giving the model one "income" number
  // lets it call interest a raise; these carry the composition and the
  // exclusions so it can reason about what the money actually was.
  const incomeByClass: Record<string, { amount: number; count: number }> = {};
  const incomeSourceTotals: Record<string, { label: string; amount: number; count: number }> = {};
  const incomeExcluded: { subtype: string; amount: number; count: number }[] = [];
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

  // P2-7B — the canonical population now admits non-economic residue (UNKNOWN /
  // ADJUSTMENT / null). These rows are counted in transactionCount and surfaced
  // (needs-classification + the disclosure below), but carry NO economic bucket:
  // they must never fold into any category / income / spend / refund / debt /
  // net figure (doctrine: an ADJUSTMENT is not spending, an UNKNOWN is not
  // income). The disclosure is computed over the full fetched set (settled +
  // pending) so a row the UI shows never silently vanishes from AI context.
  let unclassifiedCount = 0;
  let adjustmentCount   = 0;
  for (const r of rows) {
    if (isAdjustment(r.flowType)) adjustmentCount++;
    else if (isNonEconomicResidue(r.flowType)) unclassifiedCount++;
  }

  for (const txn of settled) {
    // P2-7B — non-economic residue is excluded from every money fold (still
    // counted + surfaced above). INVESTMENT never reaches here (out of population).
    if (isNonEconomicResidue(txn.flowType)) continue;

    // MC1 Phase 2 Slice 4 — one converted amount per row drives every
    // accumulator and comparison below; MC1 P3 Slice 4 — the same conversion
    // carries the estimated taint into the window flag.
    const conv = amountInTarget(txn, moneyCtx);
    if (conv.estimated) windowEstimated = true;
    // V25-FINAL-1 — an unconvertible row has no reporting value: EXCLUDE it from
    // every money fold below (never a native magnitude / fake 0). windowEstimated
    // is already set so the window is disclosed as approximate.
    if (conv.amount === null) continue;
    const amt = conv.amount;

    // Category bucket accumulator
    const entry = categoryMap.get(txn.category) ?? { debitTotal: 0, creditTotal: 0, count: 0 };
    if (amt < 0) entry.debitTotal += Math.abs(amt);
    else if (amt > 0) entry.creditTotal += amt;
    entry.count += 1;
    categoryMap.set(txn.category, entry);

    // FlowType P5 Slice 4 / REVIEW-3 C — each settled row is EITHER a movement
    // (debt payment / transfer, disclosed but never economic) OR folds through
    // the canonical economic authority. INVESTMENT never reaches this loop (out
    // of population) and the non-economic residue was skipped above.
    const mag = Math.abs(amt);

    // Movement disclosures first. Membership in "paid toward debt" is the
    // authority's verdict (debtCountedIds), which admits attested transfer-typed
    // cash legs and refuses unattested provider-categorised rows. A transfer row
    // the authority counted as a debt payment is disclosed ONCE, under debt.
    if (debtCountedIds.has(txn.id)) {
      debtPaymentTotal += mag;
      continue;
    }
    if (isDebtPayment(txn.flowType)) {
      // A DEBT_PAYMENT-typed row the authority did NOT count: the liability-side
      // leg of a counted payment (counting both legs would double-count) or an
      // unattested row it refused. Neither is economic; neither is disclosed as
      // a payment. This replaces the old `amt < 0` proxy.
      continue;
    }
    if (isTransfer(txn.flowType)) {
      transferTotal += mag;
      continue;
    }

    if (isIncome(txn.flowType)) {
      // REVIEW-3 C-2 — the class is the canonical taxonomy's verdict, derived
      // above from the same evidence the product DTO path feeds it. A NOT_INCOME
      // row (an issuer credit landing on a card) is excluded from the total by
      // foldEconomicRow below and REPORTED here, so the model sees the exclusion
      // rather than a silently smaller number.
      const attr = incomeAttrById.get(txn.id) ?? null;
      const cls  = attr?.incomeClass ?? null;
      if (cls === "NOT_INCOME") {
        const sub = attr?.subtype ?? "NOT_INCOME";
        const e = incomeExcluded.find((x) => x.subtype === sub);
        if (e) { e.amount += mag; e.count++; } else incomeExcluded.push({ subtype: sub, amount: mag, count: 1 });
      } else if (amt > 0) {
        if (cls) {
          const b = (incomeByClass[cls] ??= { amount: 0, count: 0 });
          b.amount += mag; b.count++;
          const srcId = attr?.sourceAccountId ?? attr?.instrumentId ?? null;
          if (srcId) {
            const sk = `${cls}:${srcId}`;
            const sv = (incomeSourceTotals[sk] ??= { label: srcId, amount: 0, count: 0 });
            sv.amount += mag; sv.count++;
          }
        }
        // Largest selected in TARGET units (identical under identity); the row
        // object itself keeps its native amount for downstream serialization.
        if (!largestIncomeRow || amt > largestIncomeAmt) {
          largestIncomeRow = txn;
          largestIncomeAmt = amt;
        }
      }
    }

    if (isCostFlow(txn.flowType)) {
      if (!largestExpenseRow || mag > largestExpenseAmt) {
        largestExpenseRow = txn;
        largestExpenseAmt = mag;
      }
    }

    // ── THE canonical economic fold (REVIEW-3 C-1) ──────────────────────────
    // One authority decides which economic bucket this magnitude lands in —
    // the same foldEconomicRow the Cash Flow workspace folds with. NOT_INCOME
    // exclusion happens inside it, from the same class derived above.
    foldEconomicRow(eco, txn.flowType, mag, incomeAttrById.get(txn.id)?.incomeClass ?? null);
  }

  const incomeTotal  = eco.income;
  const expenseTotal = eco.spendGross; // GROSS — a named, deliberately different measure (see payload)
  const refundTotal  = eco.refunds;

  // REVIEW-3 C-3 — the HEADLINE net is the canonical economic net: income minus
  // clamped economic spend, the exact figure the Cash Flow workspace renders
  // (perspectiveTotals "economic"). Debt payments are NOT subtracted here — that
  // measure is real but DIFFERENT, and ships beside it, named
  // netAfterDebtPayments. The old formula (income + refunds − gross expense −
  // debt payments) was a fourth definition of "net" and let the Brief print
  // "you spent more than you took in" while the workspace showed a surplus.
  const netCashFlow          = incomeTotal - clampEconomicSpend(eco.spendGross, eco.refunds);
  const netAfterDebtPayments = netCashFlow - debtPaymentTotal;

  // ── Pending aggregation ───────────────────────────────────────────────────

  let pendingCreditCount = 0;
  let pendingCreditTotal = 0;
  let pendingDebitCount  = 0;
  let pendingDebitTotal  = 0;

  for (const txn of pending) {
    // P2-7B — non-economic residue (UNKNOWN / ADJUSTMENT / null) never enters the
    // pending money totals either (already counted in the disclosure above).
    if (isNonEconomicResidue(txn.flowType)) continue;
    // MC1 P2 Slice 4 threading; P3 Slice 4 real context + taint.
    const conv = amountInTarget(txn, moneyCtx);
    if (conv.estimated) windowEstimated = true;
    if (conv.amount === null) continue; // V25-FINAL-1 — unconvertible pending row excluded
    const amt = conv.amount;
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

  // For brief scope: keep only the top 5 SPENDING categories (enough for a
  // morning summary).
  //
  // ── v2.6-BRIEF-1: why the truncation is spending-ranked ────────────────────
  //
  // It was `byCategory.slice(0, 5)` over the whole list. `total` is the
  // DEBIT-ONLY sum (KD-17 — see the comment above), so an INFLOW category has
  // total 0, sorts LAST, and was always the first thing the slice discarded.
  // Income is exactly such a category, and the comment above says why its entry
  // exists at all: "its byCategory entry exists for its `count`, which
  // lib/ai/intelligence/annotations.ts reads for incomeTransactionCount".
  //
  // So the condensed payload silently destroyed the one value the assessment
  // engine reads it for. Measured on the live corpus: 11 categories → 5, Income
  // dropped, incomeTransactionCount 8 → 0, and from that single missing row the
  // engine concluded incomeConfidence LOW, cashFlow UNRELIABLE, deficitCause
  // LOW_INCOME_SAMPLE and currentStatePriority DATA_QUALITY — about a Space
  // whose income data is complete (scripts/audit-brief-assessment-parity.ts).
  //
  // Ranking within SPENDING categories is what the cap was ever for; a
  // non-spending entry was never competing for a spending slot. Membership comes
  // from the existing flow-derived authority (lib/ai/spending-categories.ts),
  // never a hand-written {Income, Transfer, Payment} list — that copy is the
  // thing that module was created to end.
  //
  // ⚠️ The result stays in the ORIGINAL debit-total-descending order. Ranking the
  // survivors separately and concatenating would re-order the list, and
  // `context-serializer.ts` takes `.filter(total > 0).slice(0, 8)` off the front
  // of it — a non-spending category with real debits (Payment, Transfer) would
  // have jumped the queue and changed which categories the model is shown. The
  // cap is the only thing that changes here; the order is not ours to move.
  const topSpending = new Set(
    byCategory
      .filter((c) => !NON_SPENDING_CATEGORY_NAMES.has(c.category))
      .slice(0, 5)
      .map((c) => c.category),
  );
  const byCategoryOutput = scopeHint === 'brief'
    ? byCategory.filter((c) => topSpending.has(c.category) || NON_SPENDING_CATEGORY_NAMES.has(c.category))
    : byCategory;

  // ── Monthly rollups (D6 — deterministic, per calendar month) ──────────────
  // Buckets are built directly from the queried rows so month-by-month answers
  // never require the LLM to divide a window total by a month count. The
  // effective ceiling is the explicit window end, or today for a rolling window,
  // so partial-month detection reflects the actual coverage of the request.
  const effectiveEndIso = win.endIso ?? todayUTCISO();
  // KD-7: when truncated, the oldest RETAINED row is the true coverage floor.
  // Rows are date-desc, so the last element is the oldest kept row. The month it
  // falls in had older rows dropped and is therefore incomplete.
  const coverageStartIso = truncated
    ? econOf(rows[rows.length - 1]).toISOString().split('T')[0]
    : win.startIso;
  const monthlyBreakdown = buildMonthlyBreakdown(
    settled,
    pending,
    win.startIso,
    effectiveEndIso,
    truncated ? coverageStartIso.slice(0, 7) : null,
    moneyCtx, // MC1 P2 Slice 4 — identity today; Phase 3 flips the target here too
    // REVIEW-3 C — the SAME authority verdicts as the window fold, so
    // Σ(monthly figures) reconciles with the window figures by construction.
    {
      debtCountedIds,
      incomeClassOf: (id) => incomeAttrById.get(id)?.incomeClass ?? null,
    },
  );

  // ── Date range ────────────────────────────────────────────────────────────
  // rows is ordered desc by date; last element is oldest in the window.
  // For an explicit window the reported endDate is the requested ceiling so the
  // provenance block shows the exact period asked for; otherwise it is the most
  // recent transaction date (default rolling-window behavior, unchanged).

  const newestDate = win.endIso ?? econOf(rows[0]).toISOString().split('T')[0];

  // ── Recurring candidates (settled transactions, full scope only) ──────────
  // Heuristic: merchants appearing 2+ times in the window are candidates.
  // Groups by case-insensitive merchant name. Excludes Transfer and Payment
  // categories since predictable internal moves aren't interesting signals.

  // P2-7C — the rollup now converts each occurrence per-row at its own date
  // before averaging (was a native Σ txn.amount), so typicalAmount reads in the
  // Space reporting currency like every other money figure here.
  const recurringCandidates: RecurringCandidate[] | undefined =
    scopeHint !== 'brief' ? buildRecurringCandidates(settled, moneyCtx) : undefined;

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

  // P2-7C — the rollup converts each row per its own date into the reporting
  // currency before summing (was a native Σ|amount|), so a merchant total can
  // never be a native-currency sum shown next to a converted expenseTotal.
  const merchants: MerchantSummary[] | undefined =
    scopeHint !== 'brief'
      ? buildMerchantRollup(settled, moneyCtx, MERCHANT_ROLLUP_LIMIT)
      : undefined;

  // ── Income-source rollup (D6.3 stabilization — INFLOW sources only) ───────
  // Mirror image of the merchant rollup: groups settled INFLOW rows by the same
  // canonical key. Included = positive amount with flowType=INCOME (the same
  // population that feeds the top-level incomeTotal, so the numbers reconcile;
  // includes dividends and interest earned since Slice 4). Transfers are
  // excluded by construction (TRANSFER is a different flow). This is where
  // payroll belongs — never `merchants`.

  // P2-7C — same per-row conversion as the merchant rollup, so income sources
  // reconcile with the converted incomeTotal (never a native Σ txn.amount).
  const incomeSources: IncomeSource[] | undefined =
    scopeHint !== 'brief'
      ? buildIncomeSourceRollup(settled, moneyCtx, INCOME_SOURCE_ROLLUP_LIMIT,
          (id) => incomeAttrById.get(id)?.incomeClass ?? null)
      : undefined;

  // ── Drilldown evidence (D6 — only when an explicit drilldown was requested) ─
  // Re-reads real line items behind a category/merchant/period for explainability.
  // Never runs on ordinary prompts (the option is absent) and only reads rows
  // inside the Space's FULL-visibility boundary.
  const drilldown = options.drilldown
    ? await assembleDrilldown(spaceCtx, options.drilldown, win)
    : undefined;

  // ── Assemble payload ──────────────────────────────────────────────────────

  const data: TransactionsSummaryData = {
    // REVIEW-3 C-6 — the currency every money total below is stated in.
    currency:         moneyCtx.target,
    windowDays:       win.days,
    startDate:        win.startIso,
    endDate:          newestDate,
    transactionCount: rows.length,

    // KD-7 fetch-cap coverage flags.
    truncated,
    coverageStartDate: coverageStartIso,
    fetchLimit:        TRANSACTION_FETCH_LIMIT,

    incomeTotal:      Math.round(incomeTotal      * 100) / 100,
    // v2.6-TRUTH-5 — the canonical income composition. `incomeTotal` above is the
    // BANK-TRANSACTION broad income and equals the sum of these classes;
    // investment dividends are a separate ledger (see income-rollup.ts) and are
    // deliberately absent rather than silently folded in.
    incomeScope: "BANK_TRANSACTIONS" as const,
    incomeByClass: Object.fromEntries(Object.entries(incomeByClass).map(([k, v]) =>
      [k, { amount: Math.round(v.amount * 100) / 100, count: v.count }])),
    incomeSourcesByClass: Object.fromEntries(Object.entries(incomeSourceTotals).map(([k, v]) =>
      [k, { amount: Math.round(v.amount * 100) / 100, count: v.count }])),
    incomeExcluded: incomeExcluded.map((e) => ({
      subtype: e.subtype, amount: Math.round(e.amount * 100) / 100, count: e.count,
      reason: "Classified NOT_INCOME by the canonical income authority — excluded from broad income.",
    })),
    // GROSS cost flows (SPENDING+FEE+INTEREST), refunds never netted (KD-17).
    // A DIFFERENT question from the workspace's clamped "spend" — deliberately
    // so, and named: the clamped figure is derivable as
    // expenseTotal − refundTotal floored at 0 (clampEconomicSpend).
    expenseTotal:     Math.round(expenseTotal     * 100) / 100,
    refundTotal:      Math.round(refundTotal      * 100) / 100,
    debtPaymentTotal: Math.round(debtPaymentTotal * 100) / 100,
    transferTotal:    Math.round(transferTotal    * 100) / 100,
    // REVIEW-3 C-3 — netCashFlow is THE canonical economic net (income −
    // clamped spend), identical in definition to the Cash Flow workspace's net.
    // netAfterDebtPayments is the cash position after debt paydown — a separate,
    // named measure, never the headline.
    netCashFlow:          Math.round(netCashFlow          * 100) / 100,
    netAfterDebtPayments: Math.round(netAfterDebtPayments * 100) / 100,
    estimated:        windowEstimated, // MC1 P3 Slice 4 (D-7) — data-only until Phase 4

    pendingCreditCount,
    pendingCreditTotal: Math.round(pendingCreditTotal * 100) / 100,
    pendingDebitCount,
    pendingDebitTotal:  Math.round(pendingDebitTotal  * 100) / 100,

    // P2-7B — non-economic residue disclosure. The canonical banking population
    // admits UNKNOWN / ADJUSTMENT / null; these are counted (transactionCount) and
    // reachable by needs-classification, but excluded from every money total. The
    // counts make their presence explicit so a row the UI shows never silently
    // vanishes from AI context (data-only; consumers may surface "N unclassified").
    unclassifiedCount,
    adjustmentCount,

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

    // v2.6-ASSESS-2 — the user's DECLARED monthly-expense figure, carried beside
    // the measured spending it competes with. `computeAverageMonthlySpending`
    // reads this same object, so `resolveExpenseBaseline` can see both candidate
    // baselines at once and pick between them ONCE, instead of the product
    // dividing by one and the assessment engine by the other.
    declaredMonthlyExpenses,

    // P2-7C — serialize the amount already converted into the reporting currency
    // (largestIncomeAmt / largestExpenseAmt, the same target units used to SELECT
    // the row), not the row's native amount. Otherwise a headline like "largest
    // income €5,000" would sit beside a converted incomeTotal in USD.
    largestIncome: largestIncomeRow
      ? {
          merchant: largestIncomeRow.merchant,
          amount:   Math.round(largestIncomeAmt * 100) / 100,
          date:     econOf(largestIncomeRow).toISOString().split('T')[0],
        }
      : null,

    largestExpense: largestExpenseRow
      ? {
          merchant: largestExpenseRow.merchant,
          amount:   Math.round(largestExpenseAmt * 100) / 100,
          date:     econOf(largestExpenseRow).toISOString().split('T')[0],
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
  // REVIEW-3 C — the window fold's authority verdicts, so the monthly fold asks
  // the SAME questions: debt-payment membership is the debt-payment authority's
  // counted CASH-leg set; income classes are the canonical taxonomy's. Absent
  // (golden fixtures) ⇒ the legacy proxies (`amt < 0` source-side legs; no
  // income-class exclusion), preserving fixture behaviour byte-for-byte.
  authority?: {
    debtCountedIds: ReadonlySet<string>;
    incomeClassOf?: (id: string) => string | null;
  },
): MonthlyBreakdownEntry[] {
  type Bucket = {
    // REVIEW-3 C-1 — the economic buckets are folded by the canonical authority
    // (foldEconomicRow); incomeTotal/expenseTotal/refundTotal are projections.
    eco:              EconomicAccumulator;
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
        eco: { income: 0, spendGross: 0, refunds: 0 }, debtPaymentTotal: 0,
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
    const b = bucketFor(monthKey(econOf(txn)));
    b.transactionCount += 1;
    // P2-7B — non-economic residue (UNKNOWN / ADJUSTMENT / null) is counted in
    // this month's transactionCount but never folded into its category or money
    // totals (same rule as the top-level window loop).
    if (isNonEconomicResidue(txn.flowType)) continue;
    let amt = txn.amount;
    if (ctx) {
      const c = amountInTarget(txn, ctx);
      if (c.estimated) b.estimated = true;
      // V25-FINAL-1 — unconvertible row: counted above, but EXCLUDED from this
      // month's money/category folds (never a native magnitude / fake 0).
      if (c.amount === null) continue;
      amt = c.amount;
    }
    const agg = b.categoryAgg.get(txn.category) ?? { debitTotal: 0, creditTotal: 0, count: 0 };
    if (amt < 0) agg.debitTotal += Math.abs(amt);
    else if (amt > 0) agg.creditTotal += amt;
    agg.count  += 1;
    b.categoryAgg.set(txn.category, agg);

    // REVIEW-3 C — same partition rules as the window loop, from the SAME
    // authorities. With `authority` supplied, debt-payment membership is the
    // counted CASH-leg set (a counted transfer-typed row is disclosed under
    // debt, once) and income classes exclude NOT_INCOME inside foldEconomicRow.
    // Without it (golden fixtures), the legacy proxies apply unchanged.
    const mag = Math.abs(amt);
    const counted = authority && txn.id !== undefined
      ? authority.debtCountedIds.has(txn.id)
      : isDebtPayment(txn.flowType) && amt < 0; // legacy fixture proxy
    if (counted) {
      b.debtPaymentTotal += mag;
    } else if (isDebtPayment(txn.flowType)) {
      // Uncounted leg / refused row — not a payment, not economic (see window loop).
    } else if (isTransfer(txn.flowType)) {
      b.transferTotal += mag;
    } else if (isIncome(txn.flowType) && !authority && amt <= 0) {
      // Legacy fixture behaviour: only positive income folded when no authority.
    } else {
      // ── THE canonical economic fold (REVIEW-3 C-1) ───────────────────────
      foldEconomicRow(
        b.eco, txn.flowType, mag,
        authority?.incomeClassOf && txn.id !== undefined ? authority.incomeClassOf(txn.id) : null,
      );
    }
  }

  // Pending rows only bump the count (excluded from money totals, as top-level).
  for (const txn of pending) {
    bucketFor(monthKey(econOf(txn))).transactionCount += 1;
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
        incomeTotal:      Math.round(b.eco.income     * 100) / 100,
        expenseTotal:     Math.round(b.eco.spendGross * 100) / 100,
        refundTotal:      Math.round(b.eco.refunds    * 100) / 100,
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

// ---------------------------------------------------------------------------
// P2-7C — canonicalized rollup helpers (pure; exported for the multi-currency
// FX tests). Extracted verbatim from assembleTransactions so the merchant /
// income-source / recurring rollups share ONE reporting-currency contract with
// the top-level totals: every row is converted per-row at its own date via
// amountInTarget(row, ctx) BEFORE it is grouped or summed, and any row that
// converted with an estimated rate (walk-back / miss / null-residue) taints the
// entry's `estimated` flag. Under an identity context (all-USD Space) this is
// byte-identical to the pre-P2-7C native sums (pinned by the golden gates).
// ---------------------------------------------------------------------------

/** The minimal per-row facts the rollup helpers read (a structural subset of TxnRow). */
export interface RollupRow {
  /** REVIEW-3 C-2 — row identity for authority-verdict lookups; optional so the
   *  FX fixtures that construct rows by hand are unaffected. */
  id?:               string;
  merchant:          string;
  merchantId?:       string | null;
  resolvedMerchant?: { displayName: string } | null;
  category:          string;
  amount:            number;
  currency:          string | null;
  date:              Date;
  flowType:          FlowType | null;
}

/**
 * MI M6 read cutover — group + display by the RESOLVED Merchant identity when
 * present (so aliases like "WALMART #1842" / "WM SUPERCENTER" collapse to one
 * "Walmart"), falling back to the per-request normalizer for unresolved rows.
 * The raw descriptor stays on row.merchant for forensic use.
 */
function merchantGroupOf(row: Pick<RollupRow, 'merchant' | 'merchantId' | 'resolvedMerchant'>): { key: string; name: string } {
  if (row.merchantId && row.resolvedMerchant) {
    return { key: `id:${row.merchantId}`, name: row.resolvedMerchant.displayName };
  }
  const { canonicalKey, canonicalName } = normalizeMerchant(row.merchant);
  return { key: canonicalKey, name: canonicalName };
}

/**
 * Canonicalized SPENDING merchant rollup. `total` is the absolute sum of each
 * row's amount CONVERTED into `ctx.target` at the row's own date. Sorted by
 * converted total descending, capped to `limit`.
 */
export function buildMerchantRollup(
  settled: readonly RollupRow[],
  ctx:     ConversionContext,
  limit:   number,
): MerchantSummary[] {
  type MerchantAgg = {
    canonicalName: string;
    total:         number; // absolute settled expense sum, in ctx.target
    occurrences:   number;
    firstSeen:     string;
    lastSeen:      string;
    estimated:     boolean;
    categoryCount: Map<string, { count: number; absTotal: number }>;
  };

  const merchantMap = new Map<string, MerchantAgg>();

  for (const txn of settled) {
    // ⚠️ DIFFERENT QUESTION, named (REVIEW-3 C-1): "who did I spend with" is
    // deliberately NARROWER than the COST_FLOWS economic-spend membership —
    // FEE and INTEREST are costs but not merchants, so this rollup admits
    // flowType=SPENDING only. Do not "fix" this to isCostFlow: that would put
    // an interest charge in the top-merchants list. Payroll (INCOME),
    // transfers, debt payments, and refunds structurally cannot surface here.
    if (txn.flowType !== FlowType.SPENDING) continue;

    const { key: canonicalKey, name: canonicalName } = merchantGroupOf(txn);
    const iso  = econOf(txn).toISOString().split('T')[0];
    const conv = amountInTarget(txn, ctx);
    // V25-FINAL-1 — occurrence is still evidence the merchant exists, but an
    // unconvertible amount is EXCLUDED from `total` (never a native magnitude /
    // fake 0); `estimated` discloses the partial.
    const abs  = conv.amount === null ? null : Math.abs(conv.amount);

    const agg = merchantMap.get(canonicalKey) ?? {
      canonicalName,
      total:         0,
      occurrences:   0,
      firstSeen:     iso,
      lastSeen:      iso,
      estimated:     false,
      categoryCount: new Map<string, { count: number; absTotal: number }>(),
    };

    if (abs !== null) agg.total += abs;
    agg.occurrences += 1;
    if (conv.estimated) agg.estimated = true;
    if (iso < agg.firstSeen) agg.firstSeen = iso;
    if (iso > agg.lastSeen)  agg.lastSeen  = iso;

    const cat = agg.categoryCount.get(txn.category) ?? { count: 0, absTotal: 0 };
    cat.count    += 1;
    if (abs !== null) cat.absTotal += abs;
    agg.categoryCount.set(txn.category, cat);

    merchantMap.set(canonicalKey, agg);
  }

  return Array.from(merchantMap.entries())
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
        ...(agg.estimated ? { estimated: true } : {}),
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * Canonicalized INCOME-source rollup — the mirror of buildMerchantRollup over
 * positive flowType=INCOME rows. `total` is the sum of each row's amount
 * CONVERTED into `ctx.target` at the row's own date.
 */
export function buildIncomeSourceRollup(
  settled: readonly RollupRow[],
  ctx:     ConversionContext,
  limit:   number,
  /**
   * REVIEW-3 C-2 — the canonical taxonomy's class for a row (by id). When
   * supplied, NOT_INCOME rows are excluded so this rollup covers the SAME
   * population as incomeTotal (the numbers reconcile — v2.6-TRUTH-6's rule,
   * applied to the AI path). Absent (FX fixtures) ⇒ prior behaviour.
   */
  incomeClassOf?: (id: string) => string | null,
): IncomeSource[] {
  type IncomeAgg = {
    canonicalName: string;
    total:         number; // positive settled inflow sum, in ctx.target
    occurrences:   number;
    firstSeen:     string;
    lastSeen:      string;
    estimated:     boolean;
  };

  const incomeMap = new Map<string, IncomeAgg>();

  for (const txn of settled) {
    // REVIEW-3 C-1 — enrolled on the canonical income predicate (was an inline
    // `!== FlowType.INCOME` — the same question the economic fold asks).
    if (!isIncome(txn.flowType)) continue;
    // Native sign gate: conversion preserves sign (positive rates), so a native
    // inflow is a converted inflow — identical population either way.
    if (txn.amount <= 0) continue;
    // REVIEW-3 C-2 — a NOT_INCOME inflow (issuer credit, internal transfer) is
    // excluded from incomeTotal by the canonical fold, so it must not appear as
    // an "income source" either.
    if (incomeClassOf && txn.id !== undefined && incomeClassOf(txn.id) === 'NOT_INCOME') continue;

    const { key: canonicalKey, name: canonicalName } = merchantGroupOf(txn);
    const iso  = econOf(txn).toISOString().split('T')[0];
    const conv = amountInTarget(txn, ctx);

    const agg = incomeMap.get(canonicalKey) ?? {
      canonicalName,
      total:       0,
      occurrences: 0,
      firstSeen:   iso,
      lastSeen:    iso,
      estimated:   false,
    };

    if (conv.amount !== null) agg.total += conv.amount; // V25-FINAL-1 — exclude unconvertible; occurrence still counted
    agg.occurrences += 1;
    if (conv.estimated) agg.estimated = true;
    if (iso < agg.firstSeen) agg.firstSeen = iso;
    if (iso > agg.lastSeen)  agg.lastSeen  = iso;

    incomeMap.set(canonicalKey, agg);
  }

  return Array.from(incomeMap.entries())
    .map(([canonicalKey, agg]): IncomeSource => ({
      canonicalName: agg.canonicalName,
      canonicalKey,
      occurrences:   agg.occurrences,
      total:         Math.round(agg.total * 100) / 100,
      firstSeen:     agg.firstSeen,
      lastSeen:      agg.lastSeen,
      ...(agg.estimated ? { estimated: true } : {}),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * Recurring-charge candidates — merchants appearing 2+ times. `typicalAmount`
 * is the mean of the occurrences' amounts CONVERTED into `ctx.target` at each
 * row's own date (signed; negative = expense). Transfers and debt payments are
 * excluded (predictable internal moves aren't interesting signals).
 */
export function buildRecurringCandidates(
  settled: readonly RollupRow[],
  ctx:     ConversionContext,
): RecurringCandidate[] {
  // V25-FINAL-1 — `count` is the ACTUAL occurrence count (recurrence signal);
  // `amounts` holds only the CONVERTIBLE legs (the mean is over these). An
  // unconvertible leg still counts as an occurrence but contributes no amount, so
  // a recurring merchant with a missing-rate leg is still detected and flagged
  // estimated rather than silently dropped or blended with a fake 0.
  const merchantMap = new Map<string, { amounts: number[]; count: number; category: string; estimated: boolean }>();

  for (const txn of settled) {
    if (isTransfer(txn.flowType) || isDebtPayment(txn.flowType)) continue;
    const key   = txn.merchant.trim().toLowerCase();
    const group = merchantMap.get(key) ?? { amounts: [], count: 0, category: txn.category, estimated: false };
    const conv  = amountInTarget(txn, ctx);
    group.count += 1;
    if (conv.amount !== null) group.amounts.push(conv.amount);
    if (conv.estimated) group.estimated = true;
    merchantMap.set(key, group);
  }

  const out: RecurringCandidate[] = [];
  for (const [merchant, group] of merchantMap) {
    // Recurring needs ≥2 sightings AND at least one convertible leg for a mean.
    if (group.count < 2 || group.amounts.length === 0) continue;
    const sum = group.amounts.reduce((s, a) => s + a, 0);
    const avg = sum / group.amounts.length;
    out.push({
      merchant,
      occurrences:   group.count,
      typicalAmount: Math.round(avg * 100) / 100,
      category:      group.category,
      ...(group.estimated ? { estimated: true } : {}),
    });
  }

  // Most frequent first, then largest absolute typical amount.
  out.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      Math.abs(b.typicalAmount) - Math.abs(a.typicalAmount),
  );
  return out;
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
 *
 * ⚠️ EXPORTED for `scripts/audit-ai-read-parity.ts` only. The audit measures the
 * AI read boundary against the UI's, and a measurement taken over a window the
 * assembler does not actually use measures nothing. It calls this function
 * rather than reconstructing "30 or 90 days back" — a second copy of a window is
 * how a probe starts agreeing with itself instead of with the code.
 */
export function resolveWindow(
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
 * Visibility: mirrors the summary's canonical Space scoping. The
 * FinancialAccount path is restricted to TRANSACTION_DETAIL_VISIBILITY
 * (lib/ai/visibility.ts — the same predicate the summary query uses, so
 * drilldown and summary can never disagree; KD-1) so BALANCE_ONLY /
 * SUMMARY_ONLY accounts never contribute raw line items.
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
  const endIso   = request.endDate   ?? defaultWin.endIso ?? todayUTCISO();
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end   = new Date(`${endIso}T23:59:59.999Z`);

  const resolvedCategory   = resolveCategory(request.category);
  const includeNonSpending = request.includeNonSpending === true;
  const merchantQuery      = request.merchant?.trim();

  // Category constraint (Slice 4, D-5; P2-7B population):
  //   - a specific resolved category → exactly that category (explicit ask)
  //   - includeNonSpending           → NO extra constraint: "show me everything"
  //                                     means the whole banking population, which
  //                                     `aiDrilldownWhere` now applies for every
  //                                     path via `bankingTransactionWhere`
  //                                     (v2.6-PARITY-1). This arm used to be the
  //                                     ONLY one that applied it.
  //   - default                      → discretionary spending (flowType=SPENDING)
  const categoryWhere: Prisma.TransactionWhereInput = resolvedCategory
    ? { category: resolvedCategory }
    : includeNonSpending
      ? {}
      : { flowType: FlowType.SPENDING };

  // Sign constraint: spending only (amount < 0) unless a non-spending category
  // was explicitly requested (income is positive, etc.).
  const amountWhere = includeNonSpending ? {} : { amount: { lt: 0 } };

  const rows = await db.transaction.findMany({
    where: aiDrilldownWhere(spaceId, { start, end }, { categoryWhere, amountWhere, merchantQuery }),
    select: {
      date:        true,
      merchant:    true,
      // MI M6 read cutover — resolved Merchant identity (additive join).
      merchantId:       true,
      resolvedMerchant: { select: { displayName: true } },
      description: true,
      category:    true,
      amount:      true,
      currency:    true, // P2-7C — conversion input for the drilldown's FX seam
      economicDate: true, // L8-B — the canonical financial chronology
      // v2.6-TRUTH-10 (completed) — ACCOUNT_NAME_SELECT, not a hand-written pair.
      // This read selected `{ name, displayName }` ONLY, so `officialName` and
      // `plaidName` were unreachable and the resolve below could never consult
      // them. That is the same shape as the original defect: a narrow `select`
      // making the identity authority structurally unable to answer.
      financialAccount: { select: ACCOUNT_NAME_SELECT },
    },
    // v2.6-PARITY-1 / rule B1 — same reason as the summary query above.
    orderBy: { economicDate: 'desc' },
    // KD-7: same LIMIT+1 sentinel as the summary query so a fetch-cap hit here is
    // detected rather than silently under-reporting matchedTotal/totalCount.
    take:    TRANSACTION_FETCH_LIMIT + 1,
  });

  if (rows.length === 0) return undefined;

  const fetchTruncated = rows.length > TRANSACTION_FETCH_LIMIT;
  const capped         = fetchTruncated ? rows.slice(0, TRANSACTION_FETCH_LIMIT) : rows;

  // P2-7C — the drilldown is the EVIDENCE behind a category/merchant total, so
  // its figures must read in the same reporting currency as that total. Build a
  // Space conversion context over exactly the capped rows' (currency × date)
  // pairs and convert every row at its own date, mirroring the summary seam.
  // Degrades to identity if the Space row vanished mid-request.
  const drillCtx = await buildSpaceConversionContextById(spaceId, {
    currencies: capped.map((r) => r.currency),
    dates:      [...new Set(capped.map((r) => econOf(r).toISOString().slice(0, 10)))],
  });
  // One converted magnitude per row drives matchedTotal, the "largest" sort, and
  // each serialized amount — never a native amount beside a converted total.
  const convertedAll = capped.map((r) => {
    const c = amountInTarget(r, drillCtx);
    return { row: r, amount: c.amount, estimated: c.estimated };
  });
  let drilldownEstimated = false;
  for (const c of convertedAll) if (c.estimated) drilldownEstimated = true;
  // V25-FINAL-1 — rows with no acceptable rate have NO reporting value; they are
  // EXCLUDED from the drilldown evidence rather than shown as a native amount
  // beside converted figures. `drilldownEstimated` (set above) discloses the gap.
  const converted = convertedAll.filter(
    (c): c is { row: (typeof convertedAll)[number]["row"]; amount: number; estimated: boolean } => c.amount !== null,
  );

  // matchedTotal / totalCount describe the matching set actually aggregated. When
  // fetchTruncated they are a lower bound (older rows beyond the cap are omitted);
  // `truncated` below is forced true so the consumer never implies exhaustiveness.
  const matchedTotal = converted.reduce((s, c) => s + Math.abs(c.amount), 0);
  const totalCount   = converted.length;

  const limit = Math.min(request.limit ?? DRILLDOWN_DEFAULT_LIMIT, DRILLDOWN_MAX_LIMIT);

  // "Largest first" is in the reporting currency now (converted magnitude).
  const shown = [...converted]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, limit);

  const transactions: DrilldownTransaction[] = shown.map(({ row: r, amount, estimated }) => {
    // v2.6-TRUTH-10 (completed) — the ONE identity authority. This was
    // `displayName ?? name`, a TWO-rung fallback that skipped `officialName` and
    // `plaidName`, so a Chase card the whole product calls "Ultimate Rewards®"
    // was narrated to the model as "CREDIT CARD" — the exact divergence TRUTH-10
    // removed everywhere else.
    const accountName = r.financialAccount
      ? accountDisplayName(r.financialAccount)
      : undefined;
    return {
      date:     econOf(r).toISOString().split('T')[0],
      // Posting date rides as PROVENANCE, explicitly labelled, never as the date.
      postedDate: r.date.toISOString().split('T')[0],
      // MI M6 read cutover — resolved Merchant display name, else the normalizer.
      merchant: r.resolvedMerchant?.displayName ?? normalizeMerchant(r.merchant).canonicalName,
      // Forensic preservation — the original provider descriptor is never lost.
      ...(r.merchant !== (r.resolvedMerchant?.displayName ?? normalizeMerchant(r.merchant).canonicalName) ? { rawMerchant: r.merchant } : {}),
      ...(r.description ? { description: r.description } : {}),
      amount:   Math.round(amount * 100) / 100, // P2-7C — reporting currency, at row date
      category: r.category,
      ...(accountName ? { accountName } : {}),
      ...(estimated ? { estimated: true } : {}),
    };
  });

  const shownTotal = shown.reduce((s, c) => s + Math.abs(c.amount), 0);

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
    ...(drilldownEstimated ? { estimated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.TRANSACTIONS_SUMMARY, assembleTransactions);
