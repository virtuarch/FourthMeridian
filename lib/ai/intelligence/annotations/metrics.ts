/**
 * lib/ai/intelligence/annotations/metrics.ts
 *
 * Leaf scoring + domain-extraction helpers: metric math, spending opportunities,
 * month trends, debt-strategy ranking. Pure; depends only on types + constants.
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

import type {
  ConfidenceLevel,
  DataQualitySection,
  DebtSection,
  DebtPayoffUrgency,
  DebtCandidate,
  DebtStrategySection,
  SpendingCategoryClassification,
  SpendingCategoryOpportunity,
  SpendingOpportunitySection,
  TrendDirection,
  SpendingTrendMetric,
  MetricTrend,
  SpendingTrendsSection,
} from './types';
import {
  REVIEW_MIN_MONTHLY,
  SPENDING_DISCRETIONARY,
  SPENDING_SEMI_DISCRETIONARY,
  SPENDING_FIXED,
  TREND_FLAT_PCT,
} from './constants';
import type { SpaceContext_AI, TransactionsSummaryData, MonthlyBreakdownEntry, SnapshotSectionData, AccountsSectionData, GoalsSectionData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { classifyFlow, isExcludedFromSpending } from '@/lib/transactions/flow-classifier';

export function getTxnData(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const section = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  if (!section?.data) return null;
  return section.data as TransactionsSummaryData;
}


export function getSnapData(ctx: SpaceContext_AI): SnapshotSectionData | null {
  const section = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY];
  if (!section?.data) return null;
  return section.data as SnapshotSectionData;
}


export function getAcctsData(ctx: SpaceContext_AI): AccountsSectionData | null {
  const section = ctx.domains[FinanceDomains.ACCOUNTS];
  if (!section?.data) return null;
  return section.data as AccountsSectionData;
}


export function getGoalsData(ctx: SpaceContext_AI): GoalsSectionData | null {
  const section = ctx.domains[FinanceDomains.GOALS];
  if (!section?.data) return null;
  return section.data as GoalsSectionData;
}

// ── Heuristic derivation ──────────────────────────────────────────────────────


export function classifySpendingCategory(category: string): SpendingCategoryClassification | null {
  // FlowType P5 Slice 5 — the eligibility gate is flow semantics: a category
  // enters opportunity analysis only when its rows classify as a spending flow
  // (flowType ∈ {SPENDING, REFUND}). The probe uses amount −1 because
  // byCategory `total` is the KD-17 debit-only population this section ranks.
  // Parity with the legacy {Income, Interest, Transfer, Payment} exclusion set
  // over banking categories was
  // proven by the P1 harness (flow-classifier.test.ts §3a); the deliberate
  // divergence: post-Slice-4 Fee entries (flowType=FEE) are now gated out
  // instead of surfacing as REVIEW_NEEDED — a fee is not a spending-reduction
  // opportunity. The discretionary/fixed sub-classing below stays
  // category-based by design (flowType does not encode discretionary-ness).
  if (isExcludedFromSpending(classifyFlow({ category, amount: -1 }))) return null;
  if (SPENDING_DISCRETIONARY.has(category))        return 'DISCRETIONARY';
  if (SPENDING_SEMI_DISCRETIONARY.has(category))   return 'SEMI_DISCRETIONARY';
  if (SPENDING_FIXED.has(category))                return 'FIXED';
  return 'REVIEW_NEEDED'; // Other and any future categories
}

/**
 * Classifies and ranks expense categories by monthly equivalent.
 * Pure function. No DB queries. Excludes income, transfer, and debt-payment categories.
 */

export function computeSpendingOpportunities(
  txn:         TransactionsSummaryData | null,
  dataQuality: DataQualitySection,
): SpendingOpportunitySection {
  if (!txn || txn.transactionCount === 0) {
    return {
      confidence:              'LOW',
      windowDays:              txn?.windowDays ?? 0,
      topCategories:           [],
      discretionaryTotal:      0,
      topReductionOpportunity: null,
      categoriesNeedingReview: [],
      hasTransactionData:      false,
    };
  }

  const windowDays = txn.windowDays > 0 ? txn.windowDays : 90;

  const categories: SpendingCategoryOpportunity[] = [];
  for (const cat of txn.byCategory) {
    const classification = classifySpendingCategory(cat.category);
    if (classification === null) continue;
    const monthlyEquivalent = Math.round((cat.total / windowDays * 30) * 100) / 100;
    if (monthlyEquivalent < 1) continue; // skip negligible amounts
    categories.push({
      category: cat.category,
      monthlyEquivalent,
      classification,
      transactionCount: cat.count,
    });
  }

  categories.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);

  const discretionaryTotal = Math.round(
    categories
      .filter((c) => c.classification === 'DISCRETIONARY')
      .reduce((sum, c) => sum + c.monthlyEquivalent, 0) * 100,
  ) / 100;

  const topReductionOpportunity =
    categories.find((c) => c.classification === 'DISCRETIONARY') ?? null;

  const categoriesNeedingReview = categories
    .filter((c) => c.classification === 'REVIEW_NEEDED' && c.monthlyEquivalent >= REVIEW_MIN_MONTHLY)
    .map((c) => c.category);

  return {
    confidence:              dataQuality.transactionHistoryCompleteness,
    windowDays,
    topCategories:           categories,
    discretionaryTotal,
    topReductionOpportunity,
    categoriesNeedingReview,
    hasTransactionData:      true,
  };
}

// ── 2.3B Spending Trends computation (D6.3B-1) ────────────────────────────────

/** ±% band around zero within which a month-over-month move is reported as FLAT. */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Value of a single cash-flow metric for one month.
 *
 * `net` is the canonical refund-inclusive net cash flow — byte-identical to the
 * assembler's window `netCashFlow` formula (lib/ai/assemblers/transactions.ts:
 * `incomeTotal + refundTotal - expenseTotal - debtPaymentTotal`), applied per
 * month. `refundTotal` MUST be added: expenseTotal is the gross cost-flow sum
 * (refunds are never netted into it — the KD-17 debit-only rule), so a net that
 * dropped refunds would understate cash flow by the month's refund total and no
 * longer mirror the top-level measure it advertises. Transfers stay excluded.
 * This is the sole trend/annotation net definition site; the parity test
 * (spending-trends-net.test.ts) pins it to the assembler formula so the two
 * same-named measures can never drift apart again.
 *
 * Exported for that doctrine/parity test — no runtime consumer outside this module.
 */

export function metricValue(m: MonthlyBreakdownEntry, metric: SpendingTrendMetric): number {
  if (metric === 'income')  return m.incomeTotal;
  if (metric === 'expense') return m.expenseTotal;
  return m.incomeTotal + m.refundTotal - m.expenseTotal - m.debtPaymentTotal; // net
}

/**
 * Build the deterministic MoM / rolling trend for one metric from the ordered
 * list of COMPLETE months (oldest → newest). Callers must pass complete months
 * only — partial months are filtered upstream.
 */

export function computeMetricTrend(
  metric:   SpendingTrendMetric,
  complete: MonthlyBreakdownEntry[],
): MetricTrend {
  const n = complete.length;

  if (n === 0) {
    return {
      metric,
      latestCompleteMonth:   null,
      previousCompleteMonth: null,
      momDeltaAbs:           null,
      momDeltaPct:           null,
      rolling3moAvg:         null,
      direction:             'INSUFFICIENT_DATA',
    };
  }

  const latest    = complete[n - 1];
  const latestVal = metricValue(latest, metric);

  let previousCompleteMonth: string | null = null;
  let momDeltaAbs: number | null = null;
  let momDeltaPct: number | null = null;
  let direction: TrendDirection  = 'INSUFFICIENT_DATA';

  // MoM requires ≥ 2 complete months.
  if (n >= 2) {
    const prev    = complete[n - 2];
    const prevVal = metricValue(prev, metric);
    previousCompleteMonth = prev.month;
    momDeltaAbs = round2(latestVal - prevVal);
    // |previous| as denominator so pct sign follows the delta; undefined at 0.
    momDeltaPct = prevVal !== 0 ? round2((momDeltaAbs / Math.abs(prevVal)) * 100) : null;

    direction =
      momDeltaPct !== null && Math.abs(momDeltaPct) < TREND_FLAT_PCT ? 'FLAT' :
      momDeltaAbs > 0 ? 'RISING' :
      momDeltaAbs < 0 ? 'FALLING' :
      'FLAT';
  }

  // Rolling 3-month average requires ≥ 3 complete months.
  let rolling3moAvg: number | null = null;
  if (n >= 3) {
    const last3 = complete.slice(n - 3);
    const sum   = last3.reduce((s, m) => s + metricValue(m, metric), 0);
    rolling3moAvg = round2(sum / 3);
  }

  return {
    metric,
    latestCompleteMonth: latest.month,
    previousCompleteMonth,
    momDeltaAbs,
    momDeltaPct,
    rolling3moAvg,
    direction,
  };
}

/**
 * KD-10: reliable months for spending derivations — complete calendar months
 * that were NOT truncated by the KD-7 fetch cap. This is the single predicate
 * both the assessment and the prompt context block use, so they can never drift.
 */

export function reliableMonths(
  txn: TransactionsSummaryData | null,
): MonthlyBreakdownEntry[] {
  return (txn?.monthlyBreakdown ?? []).filter((m) => !m.partial && !m.truncated);
}

/**
 * KD-10: the single authoritative monthly-spending value — the average of each
 * reliable month's expenseTotal. Returns null when no reliable month exists, so
 * every caller preserves the "no complete month => UNKNOWN" behavior instead of
 * falling back to a window-normalized estimate (the old competing figure).
 */

export function computeAverageMonthlySpending(
  txn: TransactionsSummaryData | null,
): number | null {
  const months = reliableMonths(txn);
  if (months.length === 0) return null;
  const total = months.reduce((s, m) => s + m.expenseTotal, 0);
  return Math.round((total / months.length) * 100) / 100;
}

/**
 * 2.3B Spending Trends Engine.
 *
 * Deterministically derives month-over-month deltas, a 3-month rolling average,
 * and a direction classification for income, expense, and net — reading ONLY
 * TransactionsSummaryData.monthlyBreakdown. Partial months are excluded from all
 * comparisons and reported separately. No seasonality, no category drift, no LLM.
 *
 * Pure function. No DB queries, no side effects.
 */

export function computeSpendingTrends(
  txn: TransactionsSummaryData | null,
): SpendingTrendsSection {
  const breakdown = txn?.monthlyBreakdown ?? [];

  // monthlyBreakdown is already ordered oldest → newest by the assembler.
  // KD-7: fetch-cap truncated months have incomplete data and are excluded from
  // trend analysis exactly like calendar-partial months.
  const partialMonthsExcluded = breakdown
    .filter((m) => m.partial || m.truncated)
    .map((m) => m.month);
  const complete              = breakdown.filter((m) => !m.partial && !m.truncated);
  const completeMonthsAnalyzed = complete.length;

  // Confidence reflects available complete-month history for this slice:
  //   < 2 → LOW  (no MoM), 2 → MEDIUM (MoM only), ≥ 3 → HIGH (MoM + rolling).
  const confidence: ConfidenceLevel =
    completeMonthsAnalyzed < 2 ? 'LOW' :
    completeMonthsAnalyzed < 3 ? 'MEDIUM' :
    'HIGH';

  const metricTrends: MetricTrend[] = (['income', 'expense', 'net'] as const).map(
    (metric) => computeMetricTrend(metric, complete),
  );

  return {
    confidence,
    completeMonthsAnalyzed,
    partialMonthsExcluded,
    metricTrends,
  };
}

// ── 2.4 Goal Alignment computation ───────────────────────────────────────────

/**
 * Cross-references active goal state against observable spending, debt, and
 * snapshot behavior.
 * Pure function. No DB queries. Alignment is determined from assembled domain
 * data — no LLM inference.
 */

export function computeDebtStrategy(
  accts: AccountsSectionData | null,
  debt:  DebtSection,
): DebtStrategySection {
  if (!accts || debt.totalLiabilities === 0) {
    return {
      confidence:                 debt.totalLiabilities === 0 ? 'HIGH' : 'LOW',
      payoffUrgency:              debt.totalLiabilities === 0 ? 'NONE'  : 'UNKNOWN',
      avalancheCandidate:         null,
      snowballCandidate:          null,
      weightedAvgApr:             null,
      knownMonthlyInterestBurden: null,
      missingAprAccountNames:     [],
      hasBalanceOnlyDebt:         false,
    };
  }

  const debtAccounts = (accts.accounts ?? []).filter((a) => a.type === 'debt');

  // P2-7D — every cross-account monetary comparison below uses reportingBalance
  // (Space reporting currency), NEVER native balance: ranking, weighting, and the
  // candidate balances must be currency-commensurable. APR stays dimensionless and
  // is untouched. Native balance/currency remain on AccountSummaryItem for detail.

  // V25-FINAL-1 — cross-account balance comparisons need a reporting-currency
  // value; an account whose balance could NOT be converted (reportingBalance null)
  // is excluded from ranking/weighting (it would otherwise poison Math.abs). This
  // is disclosed via AccountsSectionData.totalsUnconverted.
  const valuedDebt = debtAccounts.filter(
    (a): a is typeof a & { reportingBalance: number } => a.reportingBalance !== null,
  );

  // Avalanche target: highest APR — FULL visibility, APR known and positive.
  const fullWithApr = [...valuedDebt]
    .filter((a) => a.visibilityLevel === 'FULL' && a.apr != null && a.apr > 0)
    .sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));

  const avalancheCandidate: DebtCandidate | null = fullWithApr.length > 0
    ? { accountName: fullWithApr[0].name, balance: Math.abs(fullWithApr[0].reportingBalance), apr: fullWithApr[0].apr! }
    : null;

  // Snowball target: lowest absolute REPORTING balance — any debt account. Ranking
  // native magnitudes here would compare unlike currencies (e.g. AED 20,000 vs
  // USD 10,000) and pick the wrong "smallest" account.
  const byBalance = [...valuedDebt].sort(
    (a, b) => Math.abs(a.reportingBalance) - Math.abs(b.reportingBalance),
  );
  const snowballCandidate: DebtCandidate | null = byBalance.length > 0
    ? {
        accountName: byBalance[0].name,
        balance:     Math.abs(byBalance[0].reportingBalance),
        apr:         byBalance[0].apr ?? null,
      }
    : null;

  // Weighted average APR across accounts where APR is known — weighted by REPORTING
  // balance so a larger true (reporting-currency) balance carries more weight.
  let totalWeighted    = 0;
  let totalForWeighting = 0;
  for (const a of fullWithApr) {
    const bal         = Math.abs(a.reportingBalance);
    totalWeighted    += (a.apr ?? 0) * bal;
    totalForWeighting += bal;
  }
  const weightedAvgApr: number | null = totalForWeighting > 0
    ? Math.round((totalWeighted / totalForWeighting) * 100) / 100
    : null;

  // P2-7D honesty: taint the strategy when any driving debt account had an
  // estimated reporting balance (missing/walked-back FX) — the ranking/weighting is
  // then not exact. Mirrors AccountsSectionData.totalsEstimated; omitted when false.
  const balancesEstimated = debtAccounts.some((a) => a.reportingBalanceEstimated === true);

  const payoffUrgency: DebtPayoffUrgency =
    debt.classification === 'CRITICAL'         ? 'CRITICAL' :
    debt.classification === 'WARNING'           ? 'HIGH'     :
    debt.classification === 'IMPROVING'         ? 'LOW'      :
    debt.classification === 'HEALTHY'           ? 'MODERATE' :
    debt.classification === 'INSUFFICIENT_DATA' ? 'UNKNOWN'  :
    'NONE';

  return {
    confidence:                 debt.confidence,
    payoffUrgency,
    avalancheCandidate,
    snowballCandidate,
    weightedAvgApr,
    knownMonthlyInterestBurden: debt.monthlyInterestBurden,
    missingAprAccountNames:     debt.aprGapAccountNames,
    hasBalanceOnlyDebt:         debt.hasBalanceOnlyDebt,
    ...(balancesEstimated ? { balancesEstimated: true } : {}),
  };
}

// ── 2.1 Capital Allocation computation ───────────────────────────────────────

/**
 * Derives capital allocation context from liquidity, debt, cash flow, and
 * the already-computed DebtStrategySection.
 *
 * Pure function. No DB queries. Must be called after computeDebtStrategy().
 * Uses MARKET_RETURN_THRESHOLD (7%) as the passive-index reference return.
 *
 * Outputs evidence (concrete numbers the LLM can quote) and
 * primaryEvidence/ignoredEvidence (which data domains drove the recommendation).
 */
