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
import type { SpaceContext_AI, TransactionsSummaryData, MonthlyBreakdownEntry, SnapshotSectionData, AccountsSectionData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { classifyFlow, isExcludedFromSpending } from '@/lib/transactions/flow-classifier';
// REVIEW-3 C-1/C-3 — the ONE spend-clamp authority; the monthly trend `net`
// applies the same clamp the headline netCashFlow and the workspace use.
import { clampEconomicSpend, meanMonthlyEconomicSpend, type MonthlyEconomicSpend } from '@/lib/transactions/cash-flow';
import { amountOwed, hasOutstandingDebt } from '@/lib/debt/balance-semantics';
import { computeDebtAggregate, type DebtAggregateRow } from '@/lib/debt/aggregates';

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


// W2 — getGoalsData deleted (Goals retired; the 'goals' domain and its
// GoalsSectionData payload no longer exist).

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
 *
 * post-M1 D2 — `monthlyEquivalent` is the mean over the assessment's RELIABLE
 * MONTHS (`meanPerReliableMonth` — the one month-normalisation in this layer),
 * read from each month's own `byCategory`. It used to be a day-normalised share
 * of the 90-day window total — a window that includes two clipped months —
 * printed beside, and graded against thresholds calibrated like, the
 * complete-month expense mean. It FEEDS CLASSIFICATION (the opportunity impact
 * rungs in engines.ts, and REVIEW_MIN_MONTHLY below), so the basis is not
 * cosmetic.
 *
 * Three consequences, all deliberate:
 *   · The category figures and `estimatedMonthlyExpenses` are means of the SAME
 *     months, so they reconcile instead of describing two populations.
 *   · A month in which a category has no row contributes ZERO to that
 *     category's mean. That is arithmetic over a stated population, not an
 *     invented $0 row: the denominator is the reliable months named in
 *     `monthsAnalyzed`, never "the months this category happened to appear in".
 *   · The per-month lists are complete at every scope hint, so the brief
 *     transport cap on the window-level `byCategory` no longer reaches this
 *     section (the documented W4 residual is gone).
 *
 * NO RELIABLE MONTH ⇒ REFUSAL. `monthsAnalyzed: []`, no categories, no top
 * opportunity, `discretionaryTotal: null`. Never an extrapolation from a partial
 * month. Downstream that means no CUT_TOP_DISCRETIONARY_CATEGORY and no
 * REVIEW_OTHER_CATEGORY opportunity is graded at all — silence, not a severity
 * computed from a guess. `hasTransactionData` stays true: rows exist; what is
 * missing is a complete month to measure them over.
 */

export function computeSpendingOpportunities(
  txn:         TransactionsSummaryData | null,
  dataQuality: DataQualitySection,
): SpendingOpportunitySection {
  if (!txn || txn.transactionCount === 0) {
    return {
      confidence:              'LOW',
      windowDays:              txn?.windowDays ?? 0,
      monthsAnalyzed:          [],
      topCategories:           [],
      discretionaryTotal:      null,
      topReductionOpportunity: null,
      categoriesNeedingReview: [],
      hasTransactionData:      false,
    };
  }

  const months         = reliableMonths(txn);
  const monthsAnalyzed = months.map((m) => m.month);

  // Every category that appears in ANY reliable month, with its row count over
  // those same months (the population the figure beside it is a mean of).
  // `?? []` is for hand-built payloads only — the assembler always emits the list.
  const counts = new Map<string, number>();
  for (const m of months) {
    for (const c of m.byCategory ?? []) counts.set(c.category, (counts.get(c.category) ?? 0) + c.count);
  }

  const categories: SpendingCategoryOpportunity[] = [];
  for (const [category, transactionCount] of counts) {
    const classification = classifySpendingCategory(category);
    if (classification === null) continue;
    // FM-AUDIT-004 — what the category COST each month (the canonical ledger's
    // net: charges less the refunds and reversals dated in that month), not what
    // was charged — the same basis as the expense baseline it is ranked beside.
    const monthlyEquivalent = meanPerReliableMonth(txn, (m) => {
      const c = (m.byCategory ?? []).find((x) => x.category === category);
      return c ? (c.netTotal ?? c.total) : 0;
    });
    if (monthlyEquivalent === null || monthlyEquivalent < 1) continue; // skip negligible amounts
    categories.push({ category, monthlyEquivalent, classification, transactionCount });
  }

  categories.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);

  const discretionaryTotal = months.length === 0 ? null : Math.round(
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
    windowDays:              txn.windowDays,
    monthsAnalyzed,
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
 * `net` mirrors the assembler's headline `netCashFlow` — which since REVIEW-3
 * C-3 is THE canonical economic net: income − clampEconomicSpend(gross spend,
 * refunds), the same clamp authority the Cash Flow workspace folds with. Debt
 * payments are movement toward a goal, not cash flow, and are EXCLUDED (the old
 * formula subtracted them, making the trend "net" a fourth definition).
 * Transfers stay excluded. This is the sole trend/annotation net definition
 * site; the parity test (spending-trends-net.test.ts) pins it to the assembler
 * formula so the two same-named measures can never drift apart again.
 *
 * Exported for that doctrine/parity test — no runtime consumer outside this module.
 */

export function metricValue(m: MonthlyBreakdownEntry, metric: SpendingTrendMetric): number {
  if (metric === 'income')  return m.incomeTotal;
  // NET-BASELINE-1 — the expense TREND is economic spend too, so the three rows
  // reconcile: income − expense = net, month by month (it used to print a gross
  // expense beside a net that had already taken refunds off).
  if (metric === 'expense') return clampEconomicSpend(m.expenseTotal, m.refundTotal);
  return m.incomeTotal - clampEconomicSpend(m.expenseTotal, m.refundTotal); // net — canonical
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
 * THE one month-normalisation in the assessment: the mean of a per-month figure
 * over the RELIABLE months (complete calendar months the fetch cap did not
 * truncate). Every "monthly" money figure this layer emits goes through here —
 * spending, income, debt payments, each category — so they share one month
 * population and can be printed side by side under one label.
 *
 * NULL when no reliable month exists. That is a REFUSAL, and every caller must
 * keep it one: never fall back to a window total normalised by days (the
 * retired day-normalisation, which a source scan now forbids anywhere in this
 * directory), and never average a partial month.
 */
export function meanPerReliableMonth(
  txn:  TransactionsSummaryData | null,
  pick: (month: MonthlyBreakdownEntry) => number,
): number | null {
  const months = reliableMonths(txn);
  if (months.length === 0) return null;
  const total = months.reduce((s, m) => s + pick(m), 0);
  return Math.round((total / months.length) * 100) / 100;
}

/**
 * KD-10: the single authoritative monthly-spending value. Returns null when no
 * reliable month exists, so every caller preserves the "no complete month =>
 * UNKNOWN" behavior instead of falling back to a window-normalized estimate (the
 * old competing figure).
 *
 * NET-BASELINE-1 — it is NET ECONOMIC spending: each reliable month's gross
 * charges less the refunds dated in that month, floored at 0, then averaged
 * (`meanMonthlyEconomicSpend`, lib/transactions/cash-flow — the one definition).
 * It was the mean of gross `expenseTotal`, so after REFUND-1 the Spending-by-
 * category view netted refunds while runway, savings rate, the liquid floor and
 * every "N months of expenses" still divided by what was CHARGED. Every caller
 * of this function asks "how much do I spend", so every caller moves together.
 * `computeMonthlySpendingBasis` carries the gross figure and the refund effect
 * for a surface that needs to explain the difference.
 *
 * ⚠️ IT DOES NOT ROUTE THROUGH `meanPerReliableMonth`, AND THAT IS DELIBERATE.
 * Both average over the SAME month population (`reliableMonths`); this one
 * clamps each month's net at 0 before averaging, which is the refund authority's
 * rule and lives with it. Routing it through the generic helper would put a
 * second copy of that rule here.
 */
export function computeAverageMonthlySpending(
  txn: TransactionsSummaryData | null,
): number | null {
  return computeMonthlySpendingBasis(txn)?.net ?? null;
}

/** The same figure WITH its gross charges and refund effect — never re-derived by a caller. */
export function computeMonthlySpendingBasis(
  txn: TransactionsSummaryData | null,
): MonthlyEconomicSpend | null {
  return meanMonthlyEconomicSpend(reliableMonths(txn));
}


/**
 * M1 — the single authoritative monthly-INCOME figure, over the SAME reliable
 * months as spending. Replaces the day-normalised window total, which divided
 * a 90-day window by days while spending was a calendar-month mean — so the two
 * figures the Brief printed side by side were on different bases, and a window
 * holding seven biweekly paychecks read as a higher "monthly" income than any
 * month actually delivered. Null when no reliable month exists; a month can still
 * hold two or three paychecks, which is a property of the month, not of a divisor.
 */
export function computeAverageMonthlyIncome(
  txn: TransactionsSummaryData | null,
): number | null {
  return meanPerReliableMonth(txn, (m) => m.incomeTotal);
}

/**
 * post-M1 D1 — mean OBSERVED card-and-debt payment flow per reliable month: the
 * debt-payment authority's counted CASH legs (`MonthlyBreakdownEntry.
 * debtPaymentTotal`), over the SAME months as the income and spending figures it
 * is printed beside. Replaces the last day-normalised money figure in the
 * assessment. Agrees with `measure_flows(cardAndDebtPayments).perCompleteMonth`
 * over the same months.
 *
 * Null when no reliable month exists. ZERO when the reliable months hold no
 * payment — a measurement ("none observed"), where the old figure said null.
 *
 * ⚠️ This is ONE of four quantities that share the words "monthly debt payment",
 * and it must never stand in for the other three:
 *   1. THIS — observed historical flow. It includes card payments that merely
 *      settle purchases already counted in spending, so it is NOT debt burden
 *      and must never be added to, or subtracted alongside, monthly expenses
 *      (see lib/transactions/debt-service.ts for the part that is real paydown).
 *   2. Σ stated minimums now — lib/debt/aggregates.ts. The contractual floor.
 *   3. The payoff planner's chosen payment — lib/debt/payoff.ts. A user budget.
 *   4. L1's projected minimums — lib/ai/conversation/scenario-ledger.ts. A forecast.
 */
export function computeAverageMonthlyDebtPayments(
  txn: TransactionsSummaryData | null,
): number | null {
  return meanPerReliableMonth(txn, (m) => m.debtPaymentTotal);
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

// ── 2.2 Debt Strategy computation ────────────────────────────────────────────

/**
 * Derives avalanche/snowball candidates and payoff urgency from the assembled
 * accounts list + the already-computed DebtSection.
 * Pure function. No DB queries. Must be called after Step 3 (DebtSection).
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
  // V25-SIDE-1 — PAYOFF ELIGIBILITY. Only accounts that actually OWE may be
  // ranked as payoff targets. The former `Math.abs(reportingBalance)` ordering
  // made an OVERPAID card the smallest "balance" and therefore the recommended
  // first snowball target — telling the user to pay off a card that already owes
  // THEM money. Settled and credit-balance accounts are excluded here (from
  // TARGETING only — they remain full members of the Debt workspace).
  const valuedDebt = debtAccounts.filter(
    (a): a is typeof a & { reportingBalance: number } =>
      a.reportingBalance !== null && hasOutstandingDebt(a.reportingBalance),
  );

  // Avalanche target: highest APR — FULL visibility, APR known and positive.
  const fullWithApr = [...valuedDebt]
    .filter((a) => a.visibilityLevel === 'FULL' && a.apr != null && a.apr > 0)
    .sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));

  const avalancheCandidate: DebtCandidate | null = fullWithApr.length > 0
    ? { accountName: fullWithApr[0].name, balance: amountOwed(fullWithApr[0].reportingBalance), apr: fullWithApr[0].apr! }
    : null;

  // Snowball target: lowest REPORTING amount owed — any indebted debt account.
  // Ranking native magnitudes here would compare unlike currencies (e.g. AED
  // 20,000 vs USD 10,000) and pick the wrong "smallest" account.
  const byBalance = [...valuedDebt].sort(
    (a, b) => amountOwed(a.reportingBalance) - amountOwed(b.reportingBalance),
  );
  const snowballCandidate: DebtCandidate | null = byBalance.length > 0
    ? {
        accountName: byBalance[0].name,
        balance:     amountOwed(byBalance[0].reportingBalance),
        apr:         byBalance[0].apr ?? null,
      }
    : null;

  // Weighted average APR across accounts where APR is known — weighted by REPORTING
  // amount owed so a larger true (reporting-currency) debt carries more weight.
  //
  // v2.6-DEBT-1 — one authority, and two changes came with it:
  //
  //   · The population is now "an APR is on file", not `apr > 0`. A 0%
  //     promotional balance is a KNOWN rate and genuinely lowers what the
  //     borrower pays; excluding it overstated the blended rate.
  //   · The 2dp rounding is GONE. `engine.ts` derived the same number from the
  //     same population and did not round, so the assessment carried one figure
  //     at two precisions. Rounding is presentation — every consumer already
  //     calls `.toFixed(2)`.
  const weightedAvgApr: number | null = computeDebtAggregate(
    valuedDebt
      .filter((a) => a.visibilityLevel === 'FULL' && a.apr != null)
      .map((a): DebtAggregateRow => ({
        balance:        a.reportingBalance,
        apr:            a.apr ?? null,
        minimumPayment: null,   // the strategy does not state a monthly obligation
      })),
  ).weightedApr;

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
