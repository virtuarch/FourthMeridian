/**
 * lib/ai/intelligence/annotations/engines.ts
 *
 * Domain section engines: goal alignment, investment readiness, capital
 * allocation, and risk/opportunity aggregation. Each consumes Section inputs.
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
  GoalAlignmentStatus,
  GoalAlignmentItem,
  GoalAlignmentSection,
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
  HABIT_STALE_DAYS,
  OPP_DISCRETIONARY_HIGH_MONTHLY,
  OPP_DISCRETIONARY_MED_MONTHLY,
  SEVERITY_RANK,
  IMPACT_RANK,
  CONFIDENCE_RANK,
} from './constants';
import type { SpaceContext_AI, TransactionsSummaryData, SnapshotSectionData, GoalsSectionData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';

export function computeGoalAlignment(
  goals:    GoalsSectionData | null,
  cashFlow: CashFlowSection,
  debt:     DebtSection,
  txn:      TransactionsSummaryData | null,
  snap:     SnapshotSectionData | null,
): GoalAlignmentSection {
  const noGoals: GoalAlignmentSection = {
    confidence:      'LOW',
    overallStatus:   'INSUFFICIENT_DATA',
    alignedCount:    0,
    misalignedCount: 0,
    blockedCount:    0,
    goalAlignments:  [],
    hasGoalsDomain:  goals !== null,
    activeGoalCount: 0,
  };

  if (!goals) return noGoals;

  const activeGoals = goals.goals.filter((g) => g.status === 'ACTIVE');
  if (activeGoals.length === 0) return { ...noGoals, hasGoalsDomain: true };

  const goalAlignments: GoalAlignmentItem[] = [];
  const isLiabilitiesDeclining =
    (snap?.history?.length ?? 0) >= 2 &&
    snap!.history[snap!.history.length - 1].liabilities < snap!.history[0].liabilities;

  for (const goal of activeGoals) {
    let status:  GoalAlignmentStatus;
    let evidence: string;
    let blocker: string | undefined;

    switch (goal.goalType) {
      case 'DEBT_REDUCTION': {
        const hasDebt       = debt.totalLiabilities > 0;
        const makingPayments = (txn?.debtPaymentTotal ?? 0) > 0;

        if (!hasDebt) {
          status   = 'ALIGNED';
          evidence = 'No outstanding liabilities — debt reduction goal may already be met';
        } else if (makingPayments && isLiabilitiesDeclining) {
          status   = 'ALIGNED';
          evidence = 'Debt payments detected and total liabilities are declining';
        } else if (makingPayments) {
          status   = 'LIKELY_ALIGNED';
          evidence = 'Debt payments detected in the current transaction window';
          blocker  = 'Insufficient snapshot history to confirm a declining balance trend';
        } else if (!txn) {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No transaction data — cannot assess debt payment behavior';
          blocker  = 'Connect bank accounts and allow transaction history to accumulate';
        } else {
          status   = 'MISALIGNED';
          evidence = 'No debt payments visible in the current transaction window';
        }
        break;
      }

      case 'FINANCIAL': {
        const progressPct   = goal.progressPct   ?? null;
        const targetAmount  = goal.targetAmount  ?? null;
        const currentAmount = goal.currentAmount ?? null;

        if (progressPct !== null) {
          if (progressPct >= 80) {
            status   = 'ALIGNED';
            evidence = `Goal is ${progressPct}% funded`;
          } else if (progressPct >= 40) {
            status   = 'LIKELY_ALIGNED';
            evidence = `Goal is ${progressPct}% funded — progress is active`;
          } else if (goal.targetDate) {
            status   = 'MISALIGNED';
            evidence = `Goal is only ${progressPct}% funded with a target date set`;
          } else {
            status   = 'LIKELY_ALIGNED';
            evidence = `Goal is ${progressPct}% funded`;
          }
        } else if (currentAmount !== null && targetAmount !== null) {
          if (currentAmount >= targetAmount) {
            status   = 'ALIGNED';
            evidence = `Current amount meets target`;
          } else {
            status   = 'LIKELY_ALIGNED';
            evidence = `Tracking toward target amount`;
          }
        } else {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No progress data available for this goal';
          blocker  = 'Set a target amount or link a savings account to track progress';
        }
        break;
      }

      case 'SPENDING_LIMIT': {
        const progressPct   = goal.progressPct   ?? null;
        const targetAmount  = goal.targetAmount  ?? null;
        const currentAmount = goal.currentAmount ?? null;

        if (progressPct !== null) {
          if (progressPct > 100) {
            status   = 'MISALIGNED';
            evidence = `Spending limit exceeded (${progressPct}% of limit used)`;
          } else if (progressPct >= 80) {
            status   = 'LIKELY_ALIGNED';
            evidence = `Approaching spending limit (${progressPct}% used)`;
          } else {
            status   = 'ALIGNED';
            evidence = `Within spending limit (${progressPct}% used)`;
          }
        } else if (currentAmount !== null && targetAmount !== null) {
          status   = currentAmount > targetAmount ? 'MISALIGNED' : 'ALIGNED';
          evidence = currentAmount > targetAmount ? 'Spend exceeds limit' : 'Spend is within limit';
        } else {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No spending limit data available for comparison';
          blocker  = 'Allow spending history to accumulate for assessment';
        }
        break;
      }

      case 'HABIT': {
        const streak      = goal.currentStreak ?? 0;
        const lastCheckIn = goal.lastCheckIn   ?? null;

        if (!lastCheckIn) {
          status   = 'INSUFFICIENT_DATA';
          evidence = 'No check-in recorded for this habit';
          blocker  = 'Complete the first check-in to start tracking';
        } else {
          const daysSince = Math.floor(
            (Date.now() - new Date(lastCheckIn).getTime()) / (1000 * 60 * 60 * 24),
          );
          if (streak > 0 && daysSince <= HABIT_STALE_DAYS) {
            status   = 'ALIGNED';
            evidence = `Active streak of ${streak} — last check-in ${daysSince} day(s) ago`;
          } else if (daysSince > HABIT_STALE_DAYS) {
            status   = 'MISALIGNED';
            evidence = `No check-in for ${daysSince} days`;
          } else {
            status   = 'LIKELY_ALIGNED';
            evidence = `Recent check-in (${daysSince} day(s) ago) — streak: ${streak}`;
          }
        }
        break;
      }

      default: {
        status   = 'INSUFFICIENT_DATA';
        evidence = `Goal type not yet assessable deterministically`;
        break;
      }
    }

    const item: GoalAlignmentItem = { goalId: goal.id, goalName: goal.name, goalType: goal.goalType, status, evidence };
    if (blocker !== undefined) item.blocker = blocker;
    goalAlignments.push(item);
  }

  const alignedCount    = goalAlignments.filter((g) => g.status === 'ALIGNED' || g.status === 'LIKELY_ALIGNED').length;
  const misalignedCount = goalAlignments.filter((g) => g.status === 'MISALIGNED').length;
  const blockedCount    = goalAlignments.filter((g) => g.status === 'INSUFFICIENT_DATA').length;

  const overallStatus: GoalAlignmentSection['overallStatus'] = (() => {
    if (blockedCount === goalAlignments.length)  return 'INSUFFICIENT_DATA';
    if (misalignedCount === 0)                   return 'ALIGNED';
    if (alignedCount > 0 && misalignedCount > 0) return 'MIXED';
    return 'MISALIGNED';
  })();

  const confidence: ConfidenceLevel =
    blockedCount === goalAlignments.length ? 'LOW' :
    alignedCount + misalignedCount > blockedCount ? 'MEDIUM' :
    'LOW';

  return {
    confidence,
    overallStatus,
    alignedCount,
    misalignedCount,
    blockedCount,
    goalAlignments,
    hasGoalsDomain:  true,
    activeGoalCount: activeGoals.length,
  };
}

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
  goalAlignment:         GoalAlignmentSection,
  investmentReadiness:   InvestmentReadinessSection,
  // TI2-W2 — the raw transaction summary, for the amount-based INCOMPLETE_INCOME_DATA
  // wording ("$X of $Y income … has no identified source"). Optional so absent-domain
  // callers still resolve; the evidence falls back to the count-only phrasing.
  txn?:                  TransactionsSummaryData | null,
): RiskOpportunitySection {
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
      ? `$${unknownInflowTotal.toFixed(2)} of $${incomeTotal.toFixed(2)} income in-window has no identified source (${dataQuality.incomeTransactionCount} income transaction(s) captured) — income confidence LOW`
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
      ? `, ~$${debt.monthlyInterestBurden.toFixed(2)}/mo interest`
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

  // GOALS_MISALIGNED — one or more active goals conflict with observed behavior.
  if (goalAlignment.hasGoalsDomain && goalAlignment.misalignedCount > 0) {
    risks.push({
      code:             'GOALS_MISALIGNED',
      severity:         'warning',
      confidence:       goalAlignment.confidence,
      evidence:         `${goalAlignment.misalignedCount} goal(s) misaligned with observed behavior (overall ${goalAlignment.overallStatus})`,
      affectedSections: ['goalAlignment'],
    });
  }

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
      evidence:         `Transaction history completeness LOW (${dataQuality.snapshotSpanDays}-day span in 90-day window)`,
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
      evidence:         `Top discretionary category ${top.category} at $${top.monthlyEquivalent.toFixed(2)}/mo`,
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

  // ALIGN_SPENDING_WITH_GOALS — misaligned goals suggest a spending adjustment.
  if (goalAlignment.hasGoalsDomain && goalAlignment.misalignedCount > 0) {
    opportunities.push({
      code:             'ALIGN_SPENDING_WITH_GOALS',
      impact:           'medium',
      confidence:       goalAlignment.confidence,
      evidence:         `${goalAlignment.misalignedCount} goal(s) misaligned — adjusting spending can realign them`,
      affectedSections: ['goalAlignment', 'spendingOpportunities'],
    });
  }

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
