/**
 * lib/ai/intelligence/annotations/engines.ts
 *
 * Domain section engines: investment readiness, capital allocation, and
 * risk/opportunity aggregation. Each consumes Section inputs.
 * (W2 — the goal-alignment engine was deleted with the Goals retirement.)
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

import type {
  ConfidenceLevel,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
  CapitalAllocationRecommendation,
  CapitalAllocationSection,
  DebtStrategySection,
  AllocationEvidenceDomain,
  CapitalAllocationEvidence,
  SpendingOpportunitySection,
  InvestmentReadinessClassification,
  InvestmentReadinessSection,
  OpportunityImpact,
  AssessmentRisk,
  AssessmentOpportunity,
  RiskOpportunitySection,
} from './types';
import {
  MARKET_RETURN_THRESHOLD,
  LIQUIDITY_WARNING_MONTHS,
  OPP_DISCRETIONARY_HIGH_MONTHLY,
  OPP_DISCRETIONARY_MED_MONTHLY,
  SEVERITY_RANK,
  IMPACT_RANK,
  CONFIDENCE_RANK,
} from './constants';
import type { SpaceContext_AI, TransactionsSummaryData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import { fmtMoney } from '@/lib/ai/prompts/format';

// W2 — computeGoalAlignment (engine 2.4) DELETED with the Goals retirement:
// with no goal rows and no declaration mechanism there is nothing to align.
// Its 'MIXED' overall status and per-goal alignment items died with it.

// ── 2.5 Investment Readiness computation ──────────────────────────────────────

/**
 * Determines investment readiness from liquidity and debt — no holdings data required.
 * Detects whether the HOLDINGS_SUMMARY domain was assembled as a presence flag only.
 * Does not give investment advice — only whether the financial context supports investing.
 */

export function computeInvestmentReadiness(
  liquidity:    LiquiditySection,
  debt:         DebtSection,
  debtStrategy: DebtStrategySection,
  ctx:          SpaceContext_AI,
): InvestmentReadinessSection {
  const blockers: string[] = [];

  const holdingsDomainPresent = !!ctx.domains[FinanceDomains.HOLDINGS_SUMMARY]?.data;

  const liquiditySafe =
    liquidity.classification === 'SAFE' || liquidity.classification === 'EXCELLENT';

  const highAprDebtPresent =
    debt.classification === 'CRITICAL' || debt.classification === 'WARNING';

  const debtBeatsMarket: boolean | null =
    debtStrategy.weightedAvgApr !== null && !debt.hasNullAPR
      ? debtStrategy.weightedAvgApr > MARKET_RETURN_THRESHOLD
      : null;

  if (!liquidity.hasAccountsDomain) {
    blockers.push('No accounts linked — liquidity status unknown');
  }
  if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    blockers.push('APR missing for some debt accounts — full carry cost unknown');
  }

  let classification: InvestmentReadinessClassification;
  let confidence: ConfidenceLevel;

  if (!liquidity.hasAccountsDomain) {
    classification = 'BLOCKED_BY_DATA';
    confidence     = 'LOW';
  } else if (liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING') {
    classification = 'BUILD_LIQUIDITY_FIRST';
    confidence     = liquidity.confidence;
  } else if (highAprDebtPresent) {
    classification = 'DEBT_FIRST';
    confidence     = debt.confidence;
  } else if (debtBeatsMarket === true) {
    // APR confirmed above market return reference but below CRITICAL/WARNING threshold.
    classification = 'DEBT_FIRST';
    confidence     = 'MEDIUM';
  } else if (debtBeatsMarket === null && debt.totalLiabilities > 0) {
    // APR unknown — cannot confirm debt cost vs. investing trade-off.
    classification = 'CONDITIONALLY_READY';
    confidence     = 'LOW';
    blockers.push('APR unknown — cannot confirm debt vs. investing trade-off');
  } else {
    classification = (liquiditySafe && debt.totalLiabilities === 0) ? 'READY' : 'CONDITIONALLY_READY';
    confidence     = 'MEDIUM';
  }

  return {
    classification,
    confidence,
    holdingsDomainPresent,
    liquiditySafe,
    highAprDebtPresent,
    debtBeatsMarket,
    blockers,
  };
}

// ── 2.2 Debt Strategy computation ────────────────────────────────────────────

/**
 * Derives avalanche/snowball candidates and payoff urgency from the assembled
 * accounts list + the already-computed DebtSection.
 *
 * Pure function. No DB queries. Must be called after Step 3 (DebtSection).
 */

export function computeCapitalAllocation(
  liquidity:    LiquiditySection,
  debt:         DebtSection,
  cashFlow:     CashFlowSection,
  debtStrategy: DebtStrategySection,
): CapitalAllocationSection {
  const blockers: string[] = [];

  const liquidityFirstRequired =
    liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING';

  const highInterestDebtPresent =
    debt.classification === 'CRITICAL' || debt.classification === 'WARNING';

  const missingAprPreventsComparison = debt.hasNullAPR && debt.totalLiabilities > 0;

  if (cashFlow.confidence === 'LOW') {
    blockers.push('Income history incomplete — cash flow not primary to this recommendation');
  }
  if (missingAprPreventsComparison) {
    blockers.push('APR missing for one or more debt accounts — debt vs. investing comparison blocked');
  }
  if (!liquidity.hasAccountsDomain) {
    blockers.push('No accounts linked to this Space — liquidity unknown');
  }

  // ── Evidence: concrete numbers the LLM can quote ─────────────────────────

  const guaranteedReturnAdvantage: number | null =
    debtStrategy.weightedAvgApr !== null && !debt.hasNullAPR
      ? Math.round((debtStrategy.weightedAvgApr - MARKET_RETURN_THRESHOLD) * 100) / 100
      : null;

  const evidence: CapitalAllocationEvidence = {
    weightedDebtApr:           debtStrategy.weightedAvgApr,
    expectedMarketReturn:      MARKET_RETURN_THRESHOLD,
    guaranteedReturnAdvantage,
    aprCompleteness:           debt.aprCompleteness,
    liquidityMonths:           liquidity.coverageMonths,
    monthlyInterestBurden:     debt.monthlyInterestBurden,
  };

  // ── Recommendation ───────────────────────────────────────────────────────

  let recommendation: CapitalAllocationRecommendation;
  let confidence: ConfidenceLevel;

  if (!liquidity.hasAccountsDomain && cashFlow.confidence === 'LOW') {
    recommendation = 'BLOCKED_BY_DATA';
    confidence     = 'LOW';
  } else if (liquidityFirstRequired) {
    recommendation = 'BUILD_LIQUIDITY';
    confidence     = liquidity.confidence;
  } else if (highInterestDebtPresent) {
    recommendation = 'PAY_HIGH_APR_DEBT';
    confidence     = debt.confidence;
  } else if (missingAprPreventsComparison) {
    recommendation = 'BLOCKED_BY_DATA';
    confidence     = 'MEDIUM';
  } else if (guaranteedReturnAdvantage !== null && guaranteedReturnAdvantage > 0) {
    recommendation = 'DEBT_BEFORE_INVESTING';
    confidence     = 'MEDIUM'; // market returns are variable — cap at MEDIUM
  } else {
    recommendation = 'INVEST_ELIGIBLE';
    confidence     = debt.totalLiabilities === 0 ? 'HIGH' : 'MEDIUM';
  }

  // ── Primary / ignored evidence ───────────────────────────────────────────
  // Tells the LLM which data domains drove the recommendation and which to
  // de-emphasise — enables "although income data is incomplete, this is driven by
  // your APR and liquid coverage" framing.

  const primaryEvidence: AllocationEvidenceDomain[] = [];
  const ignoredEvidence: AllocationEvidenceDomain[] = [];

  if (liquidityFirstRequired) {
    primaryEvidence.push('liquidity');
    if (debt.totalLiabilities > 0) primaryEvidence.push('debt');
  } else if (highInterestDebtPresent || recommendation === 'DEBT_BEFORE_INVESTING') {
    primaryEvidence.push('debt', 'liquidity');
  } else {
    primaryEvidence.push('liquidity', 'debt');
  }

  // Cash flow: note whether it was relied on or sidelined.
  // Recommendations driven by balance-sheet data (APR, liabilities, liquid cash)
  // do not depend on income/expense reliability.
  const cashFlowIsDecidingFactor =
    recommendation === 'INVEST_ELIGIBLE' && cashFlow.confidence !== 'LOW';

  if (!cashFlowIsDecidingFactor) {
    ignoredEvidence.push('cashFlow');
  }

  return {
    recommendation,
    confidence,
    liquidCashAvailable:          liquidity.liquidCashTotal,
    highInterestDebtPresent,
    liquidityFirstRequired,
    missingAprPreventsComparison,
    blockers,
    evidence,
    primaryEvidence,
    ignoredEvidence,
  };
}

// ── 2.6 Risk & Opportunity computation ───────────────────────────────────────


export function computeRiskOpportunities(
  dataQuality:           DataQualitySection,
  cashFlow:              CashFlowSection,
  debt:                  DebtSection,
  liquidity:             LiquiditySection,
  debtStrategy:          DebtStrategySection,
  spendingOpportunities: SpendingOpportunitySection,
  // W2 — the goalAlignment parameter was deleted with the goal-alignment engine.
  investmentReadiness:   InvestmentReadinessSection,
  // TI2-W2 — the raw transaction summary, for the amount-based INCOMPLETE_INCOME_DATA
  // wording ("$X of $Y income … has no identified source"). Optional so absent-domain
  // callers still resolve; the evidence falls back to the count-only phrasing.
  txn?:                  TransactionsSummaryData | null,
  // REVIEW-3 C-6 — the Space's reporting currency for evidence strings that
  // carry money. USD default keeps fixtures identical; no hard-coded `$`.
  reportingCurrency?:    string,
): RiskOpportunitySection {
  const money = (n: number) => fmtMoney(n, reportingCurrency);
  const risks:         AssessmentRisk[]        = [];
  const opportunities: AssessmentOpportunity[] = [];

  // ── Risks ─────────────────────────────────────────────────────────────────

  // LOW_LIQUIDITY — liquidity coverage at or below the warning band.
  if (liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING') {
    const coverage = liquidity.coverageMonths !== null
      ? `${liquidity.coverageMonths.toFixed(1)} months of liquid coverage`
      : 'liquid coverage below target';
    risks.push({
      code:             'LOW_LIQUIDITY',
      severity:         liquidity.classification === 'CRITICAL' ? 'critical' : 'warning',
      confidence:       liquidity.confidence,
      evidence:         `${coverage} (${liquidity.classification})`,
      affectedSections: ['liquidity'],
    });
  }

  // INCOMPLETE_INCOME_DATA — income confidence is LOW.
  if (dataQuality.incomeConfidence === 'LOW') {
    // TI2-W2 — when in-window income has unidentified-source inflow, state the
    // amount ("$X of $Y … has no identified source") rather than only a row
    // count: the whole point of the slice is that a count cannot express how much
    // income is unproven. Falls back to the count phrasing when there is no
    // unidentified inflow (e.g. LOW purely from too few income rows).
    const unknownInflowTotal = txn?.needsClassification?.unknownInflowTotal ?? 0;
    const incomeTotal        = txn?.incomeTotal ?? 0;
    const evidence = unknownInflowTotal > 0 && incomeTotal > 0
      ? `${money(unknownInflowTotal)} of ${money(incomeTotal)} income in-window has no identified source (${dataQuality.incomeTransactionCount} income transaction(s) captured) — income confidence LOW`
      : `Only ${dataQuality.incomeTransactionCount} income transaction(s) captured — income confidence LOW`;
    risks.push({
      code:             'INCOMPLETE_INCOME_DATA',
      severity:         'warning',
      confidence:       'HIGH',
      evidence,
      affectedSections: ['dataQuality', 'cashFlow'],
    });
  }

  // CASH_FLOW_UNRELIABLE — cash flow reliability degraded by income gaps.
  if (cashFlow.reliability === 'UNRELIABLE') {
    risks.push({
      code:             'CASH_FLOW_UNRELIABLE',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         'Cash flow reliability is UNRELIABLE — apparent deficits may be data artifacts, not real',
      affectedSections: ['cashFlow', 'dataQuality'],
    });
  }

  // HIGH_INTEREST_DEBT — debt classification flags elevated/critical APR.
  if (debt.classification === 'CRITICAL' || debt.classification === 'WARNING') {
    const apr = debtStrategy.weightedAvgApr !== null
      ? `weighted APR ${debtStrategy.weightedAvgApr.toFixed(2)}%`
      : 'elevated APR';
    const burden = debt.monthlyInterestBurden !== null
      ? `, ~${money(debt.monthlyInterestBurden)}/mo interest`
      : '';
    risks.push({
      code:             'HIGH_INTEREST_DEBT',
      severity:         debt.classification === 'CRITICAL' ? 'critical' : 'warning',
      confidence:       debt.confidence,
      evidence:         `${debt.classification} debt — ${apr}${burden}`,
      affectedSections: ['debt', 'debtStrategy'],
    });
  }

  // APR_MISSING_FOR_DEBT — outstanding debt with one or more missing APRs.
  if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    const which = debt.aprGapAccountNames.length > 0
      ? `APR missing for: ${debt.aprGapAccountNames.join(', ')}`
      : 'APR missing for one or more debt accounts';
    const balOnly = debt.hasBalanceOnlyDebt
      ? ' (some are balance-only — APR structurally inaccessible in this Space)'
      : '';
    risks.push({
      code:             'APR_MISSING_FOR_DEBT',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         `${which}${balOnly}`,
      affectedSections: ['debt', 'debtStrategy'],
    });
  }

  // DEBT_PAYOFF_BLOCKED_BY_DATA — debt health cannot be classified from data.
  if (debt.classification === 'INSUFFICIENT_DATA' && debt.totalLiabilities > 0) {
    risks.push({
      code:             'DEBT_PAYOFF_BLOCKED_BY_DATA',
      severity:         'warning',
      confidence:       'HIGH',
      evidence:         `Debt health cannot be classified — APR completeness ${debt.aprCompleteness}; precise payoff comparison blocked`,
      affectedSections: ['debt', 'debtStrategy', 'capitalAllocation'],
    });
  }

  // W2 — the GOALS_MISALIGNED risk rule was deleted with the goal-alignment
  // engine (nothing produces the section it aggregated).

  // INVESTING_NOT_READY — pre-conditions for investing are not met.
  if (
    investmentReadiness.classification === 'DEBT_FIRST' ||
    investmentReadiness.classification === 'BUILD_LIQUIDITY_FIRST' ||
    investmentReadiness.classification === 'BLOCKED_BY_DATA'
  ) {
    risks.push({
      code:             'INVESTING_NOT_READY',
      severity:         investmentReadiness.classification === 'BLOCKED_BY_DATA' ? 'info' : 'warning',
      confidence:       investmentReadiness.confidence,
      evidence:         `Investment readiness: ${investmentReadiness.classification}`,
      affectedSections: ['investmentReadiness'],
    });
  }

  // HISTORY_INCOMPLETE — transaction history too sparse for confident analysis.
  if (dataQuality.transactionHistoryCompleteness === 'LOW') {
    risks.push({
      code:             'HISTORY_INCOMPLETE',
      severity:         'info',
      confidence:       'HIGH',
      // REVIEW-3 C-8 (KD-16) — the ACTUAL analysis window, never a hard-coded
      // "90-day" that disagrees with a 30-day brief or explicit window.
      evidence:         `Transaction history completeness LOW (${dataQuality.snapshotSpanDays}-day snapshot span${txn?.windowDays ? ` in ${txn.windowDays}-day analysis window` : ''})`,
      affectedSections: ['dataQuality'],
    });
  }

  // ── Opportunities ─────────────────────────────────────────────────────────

  // CUT_TOP_DISCRETIONARY_CATEGORY — largest reducible discretionary category.
  if (spendingOpportunities.hasTransactionData && spendingOpportunities.topReductionOpportunity) {
    const top = spendingOpportunities.topReductionOpportunity;
    const impact: OpportunityImpact =
      top.monthlyEquivalent >= OPP_DISCRETIONARY_HIGH_MONTHLY ? 'high' :
      top.monthlyEquivalent >= OPP_DISCRETIONARY_MED_MONTHLY  ? 'medium' :
      'low';
    opportunities.push({
      code:             'CUT_TOP_DISCRETIONARY_CATEGORY',
      impact,
      confidence:       spendingOpportunities.confidence,
      evidence:         `Top discretionary category ${top.category} at ${money(top.monthlyEquivalent)}/mo`,
      affectedSections: ['spendingOpportunities'],
    });
  }

  // REVIEW_OTHER_CATEGORY — uncategorized spend worth review.
  if (spendingOpportunities.categoriesNeedingReview.length > 0) {
    opportunities.push({
      code:             'REVIEW_OTHER_CATEGORY',
      impact:           'low',
      confidence:       spendingOpportunities.confidence,
      evidence:         `Uncategorized spend to review: ${spendingOpportunities.categoriesNeedingReview.join(', ')}`,
      affectedSections: ['spendingOpportunities'],
    });
  }

  // PAY_HIGH_APR_DEBT — high-APR debt payoff yields a guaranteed return.
  if (debt.classification === 'CRITICAL' || debt.classification === 'WARNING') {
    const target = debtStrategy.avalancheCandidate
      ? `; highest-APR target ${debtStrategy.avalancheCandidate.accountName} (${debtStrategy.avalancheCandidate.apr!.toFixed(2)}%)`
      : '';
    const apr = debtStrategy.weightedAvgApr !== null
      ? `weighted APR ${debtStrategy.weightedAvgApr.toFixed(2)}%`
      : 'elevated APR';
    opportunities.push({
      code:             'PAY_HIGH_APR_DEBT',
      impact:           debt.classification === 'CRITICAL' ? 'high' : 'medium',
      confidence:       debt.confidence,
      evidence:         `Paying down ${apr} debt is a guaranteed return${target}`,
      affectedSections: ['debt', 'debtStrategy', 'capitalAllocation'],
    });
  }

  // BUILD_EMERGENCY_FUND — liquidity below target invites reserve building.
  if (liquidity.classification === 'CRITICAL' || liquidity.classification === 'WARNING') {
    const coverage = liquidity.coverageMonths !== null
      ? `currently ${liquidity.coverageMonths.toFixed(1)} months`
      : 'currently below target';
    opportunities.push({
      code:             'BUILD_EMERGENCY_FUND',
      impact:           liquidity.classification === 'CRITICAL' ? 'high' : 'medium',
      confidence:       liquidity.confidence,
      evidence:         `Liquid coverage ${coverage} — building toward ${LIQUIDITY_WARNING_MONTHS}+ months reduces risk`,
      affectedSections: ['liquidity', 'capitalAllocation'],
    });
  }

  // IMPROVE_DATA_QUALITY — closing income/APR gaps sharpens every downstream analysis.
  {
    const dataGaps: string[] = [];
    const dataSections = new Set<string>();
    if (dataQuality.incomeConfidence === 'LOW') {
      dataGaps.push('connect all income accounts');
      dataSections.add('dataQuality');
      dataSections.add('cashFlow');
    }
    if (debt.hasNullAPR && debt.totalLiabilities > 0) {
      dataGaps.push('enter missing debt APRs');
      dataSections.add('debt');
    }
    if (dataGaps.length > 0) {
      opportunities.push({
        code:             'IMPROVE_DATA_QUALITY',
        impact:           'medium',
        confidence:       'HIGH',
        evidence:         `Sharpen analysis: ${dataGaps.join('; ')}`,
        affectedSections: [...dataSections],
      });
    }
  }

  // W2 — the ALIGN_SPENDING_WITH_GOALS opportunity rule was deleted with the
  // goal-alignment engine.

  // READY_TO_INVEST — pre-conditions for investing are satisfied.
  if (investmentReadiness.classification === 'READY') {
    opportunities.push({
      code:             'READY_TO_INVEST',
      impact:           'high',
      confidence:       investmentReadiness.confidence,
      evidence:         'Liquidity is safe and debt is manageable — conditions support investing',
      affectedSections: ['investmentReadiness'],
    });
  }

  // EXPAND_TRANSACTION_HISTORY — more history improves confidence across sections.
  if (dataQuality.transactionHistoryCompleteness !== 'HIGH') {
    opportunities.push({
      code:             'EXPAND_TRANSACTION_HISTORY',
      impact:           dataQuality.transactionHistoryCompleteness === 'LOW' ? 'medium' : 'low',
      confidence:       'HIGH',
      evidence:         `Transaction history completeness ${dataQuality.transactionHistoryCompleteness} — more history raises confidence across the assessment`,
      affectedSections: ['dataQuality'],
    });
  }

  // ── Sorting ───────────────────────────────────────────────────────────────

  risks.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
  );

  opportunities.sort((a, b) =>
    IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
  );

  // ── Section confidence ────────────────────────────────────────────────────
  // Tracks the completeness of the underlying data the aggregation relies on —
  // data quality gates the reliability of every risk and opportunity above.
  const confidence: ConfidenceLevel =
    (dataQuality.incomeConfidence === 'LOW' ||
     dataQuality.transactionHistoryCompleteness === 'LOW')     ? 'LOW'    :
    (dataQuality.incomeConfidence === 'MEDIUM' ||
     dataQuality.transactionHistoryCompleteness === 'MEDIUM')  ? 'MEDIUM' :
    'HIGH';

  return { risks, opportunities, confidence };
}

// ── Main computation ──────────────────────────────────────────────────────────

/**
 * Compute a structured financial assessment for a fully-assembled SpaceContext_AI.
 *
 * Pure function — no DB queries, no side effects, no LLM calls.
 * Call this after buildContext() and before prompt construction.
 */
