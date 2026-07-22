/**
 * lib/ai/intelligence/annotations/engine.ts
 *
 * computeAssessment — the orchestrator. Wires the deterministic engines into a
 * single FinancialAssessment over an assembled SpaceContext_AI.
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

import type {
  CompletenessLevel,
  ConfidenceLevel,
  CashFlowReliability,
  DeficitCauseClassification,
  DebtHealthClassification,
  LiquidityCoverageClassification,
  CurrentStatePriority,
  AprCompleteness,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
  FinancialAssessment,
} from './types';
import {
  SNAPSHOT_LOW_THRESHOLD,
  SNAPSHOT_HIGH_THRESHOLD,
  TXN_COUNT_MINIMUM,
  INCOME_PLAUS_RATIO_LOW,
  INCOME_TXN_HIGH_THRESHOLD,
  APR_CRITICAL_THRESHOLD,
  APR_WARNING_THRESHOLD,
  LIQUIDITY_CRITICAL_MONTHS,
  LIQUIDITY_WARNING_MONTHS,
  LIQUIDITY_EXCELLENT_MONTHS,
  DEBT_FRACTION_DOMINANT,
  DEBT_FRACTION_PARTIAL,
} from './constants';
import { computeAverageMonthlySpending, computeDebtStrategy, computeSpendingOpportunities, computeSpendingTrends, getAcctsData, getGoalsData, getSnapData, getTxnData } from './metrics';
import { deriveHeuristics, derivePriorities } from './rules';
import { computeCapitalAllocation, computeGoalAlignment, computeInvestmentReadiness, computeRiskOpportunities } from './engines';
import type { SpaceContext_AI } from '@/lib/ai/types';
import { MATERIAL_UNIDENTIFIED_INFLOW_SHARE, deriveUnidentifiedInflowShare } from '@/lib/ai/types';
import { amountOwed, hasOutstandingDebt } from '@/lib/debt/balance-semantics';

export function computeAssessment(ctx: SpaceContext_AI): FinancialAssessment {
  const txn   = getTxnData(ctx);
  const snap  = getSnapData(ctx);
  const accts = getAcctsData(ctx);
  const goals = getGoalsData(ctx);

  // ── Raw inputs (with safe defaults for absent domains) ───────────────────

  const snapshotCount    = snap?.snapshotCount    ?? 0;
  const windowDays       = txn?.windowDays         ?? 90;
  const transactionCount = txn?.transactionCount   ?? 0;
  const incomeTotal      = txn?.incomeTotal        ?? 0;
  const expenseTotal     = txn?.expenseTotal       ?? 0;
  const debtPaymentTotal = txn?.debtPaymentTotal   ?? 0;
  const netCashFlow      = txn?.netCashFlow        ?? 0;
  const totalLiquid      = accts?.totalLiquid      ?? 0;
  const totalLiabilities = accts?.totalLiabilities ?? 0;

  const incomeEntry          = txn?.byCategory.find((c) => c.category === 'Income');
  const incomeTransactionCount = incomeEntry?.count ?? 0;

  const totalOutflows    = expenseTotal + debtPaymentTotal;
  const incomePlausRatio = totalOutflows > 0 ? incomeTotal / totalOutflows : 1;

  // ── Step 1: Data quality ─────────────────────────────────────────────────

  const transactionHistoryCompleteness: CompletenessLevel = (() => {
    if (transactionCount === 0 || snapshotCount < SNAPSHOT_LOW_THRESHOLD) return 'LOW';
    if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD || transactionCount < TXN_COUNT_MINIMUM) return 'MEDIUM';
    return 'HIGH';
  })();

  // TI2-W2 — unidentified-inflow share (null when no in-window income). Guarded
  // divide (deriveUnidentifiedInflowShare) so a zero-income window is null, never
  // NaN/Infinity. Defensive against fixtures predating the W1 aggregate block.
  const unidentifiedInflowShare = txn ? deriveUnidentifiedInflowShare(txn) : null;
  const unidentifiedInflowMaterial =
    unidentifiedInflowShare !== null && unidentifiedInflowShare >= MATERIAL_UNIDENTIFIED_INFLOW_SHARE;

  const incomeConfidence: ConfidenceLevel = (() => {
    const base: ConfidenceLevel = (() => {
      if (transactionHistoryCompleteness === 'LOW' || incomeTransactionCount === 0) return 'LOW';
      if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD) {
        if (incomeTransactionCount <= 1 || incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
        return 'MEDIUM';
      }
      if (incomeTransactionCount <= 1 && incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
      if (incomeTransactionCount >= INCOME_TXN_HIGH_THRESHOLD && incomePlausRatio >= INCOME_PLAUS_RATIO_LOW) return 'HIGH';
      return 'MEDIUM';
    })();
    // TI2-W2 downgrade: a material unidentified-inflow share caps confidence at
    // MEDIUM. This lets an honesty fact the row-count proxy cannot see pull a
    // window down from HIGH — three unidentified deposits pass the count test but
    // should not read as high-confidence income.
    if (base === 'HIGH' && unidentifiedInflowMaterial) return 'MEDIUM';
    return base;
  })();

  const dataQuality: DataQualitySection = {
    transactionHistoryCompleteness,
    snapshotSpanDays: snapshotCount,
    incomeConfidence,
    incomeTransactionCount,
    unidentifiedInflowShare,
  };

  // ── Step 2: Cash flow ────────────────────────────────────────────────────

  const impliedMonthlyIncome: number | null = txn && windowDays > 0
    ? Math.round((incomeTotal / windowDays * 30) * 100) / 100
    : null;

  // KD-10: authoritative monthly spending (reliable-month average). Replaces the
  // window-normalized estimate that competed with the prompt context block.
  const estimatedMonthlyExpenses: number | null = computeAverageMonthlySpending(txn);

  const estimatedMonthlyDebtPayments: number | null = txn && windowDays > 0 && debtPaymentTotal > 0
    ? Math.round((debtPaymentTotal / windowDays * 30) * 100) / 100
    : null;

  const hasActiveDebtGoal = (goals?.goals ?? []).some(
    (g) => g.status === 'ACTIVE' && g.goalType === 'DEBT_REDUCTION',
  );

  const deficitCause: DeficitCauseClassification = (() => {
    if (netCashFlow >= 0)           return 'NOT_APPLICABLE';
    if (incomeConfidence === 'LOW') return 'LOW_INCOME_SAMPLE';
    const deficit      = Math.abs(netCashFlow);
    const debtFraction = deficit > 0 ? debtPaymentTotal / deficit : 0;
    if (debtFraction >= DEBT_FRACTION_DOMINANT && hasActiveDebtGoal) return 'INTENTIONAL_DEBT_PAYOFF';
    if (debtFraction >= DEBT_FRACTION_PARTIAL && hasActiveDebtGoal)  return 'MIXED';
    return 'POSSIBLE_OVERSPENDING';
  })();

  const cashFlowReliability: CashFlowReliability =
    incomeConfidence === 'LOW'    ? 'UNRELIABLE' :
    incomeConfidence === 'MEDIUM' ? 'PARTIAL'    :
    'RELIABLE';

  const cashFlow: CashFlowSection = {
    reliability:                  cashFlowReliability,
    confidence:                   incomeConfidence,
    deficitCause,
    transactionCompleteness:      transactionHistoryCompleteness,
    impliedMonthlyIncome,
    estimatedMonthlyExpenses,
    estimatedMonthlyDebtPayments,
    incomeTransactionCount,
    incompleteIncomeWarning:      incomeConfidence === 'LOW',
  };

  // ── Step 3: Debt ─────────────────────────────────────────────────────────

  let debtSection: DebtSection;

  if (!accts) {
    debtSection = {
      classification:        'INSUFFICIENT_DATA',
      confidence:            'LOW',
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'NONE',
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else if (totalLiabilities === 0) {
    debtSection = {
      classification:        'NO_DEBT',
      confidence:            'HIGH',
      totalLiabilities:      0,
      monthlyInterestBurden: null,
      aprCompleteness:       'FULL', // vacuously: no debt accounts to be incomplete
      hasNullAPR:            false,
      hasBalanceOnlyDebt:    false,
      aprGapAccountNames:    [],
    };
  } else {
    const debtAccounts = (accts.accounts ?? []).filter((a) => a.type === 'debt');

    let interestBurden    = 0;
    let totalDebtWithAPR  = 0;
    let hasNullAPR        = false;
    let fullVisDebtCount  = 0;
    let fullVisWithAPR    = 0;

    const hasBalanceOnlyDebt = debtAccounts.some((a) => a.visibilityLevel === 'BALANCE_ONLY');

    for (const acct of debtAccounts) {
      if (acct.visibilityLevel === 'BALANCE_ONLY') {
        // APR is structurally inaccessible — counts as missing for classification.
        hasNullAPR = true;
        continue;
      }
      // FULL-visibility debt account
      fullVisDebtCount++;
      if (acct.apr == null) {
        hasNullAPR = true;
      } else {
        fullVisWithAPR++;
        // V25-FINAL-1 — only accounts with a reporting-currency value can enter the
        // cross-account interest-burden sum; an unconvertible balance (null) is
        // excluded (disclosed via totalsUnconverted) rather than summed as a fake 0.
        // V25-SIDE-1 — only real outstanding debt accrues interest. A credit
        // balance previously entered here via Math.abs and generated phantom
        // interest burden on money the issuer owes the USER.
        if (acct.apr > 0 && acct.reportingBalance !== null && hasOutstandingDebt(acct.reportingBalance)) {
          // P2-7D — reporting-currency balance: monthlyInterestBurden and the
          // APR-weighting denominator sum across accounts, so mixed-currency
          // native balances would be an invalid sum. APR stays dimensionless.
          const balance   = amountOwed(acct.reportingBalance);
          interestBurden   += balance * acct.apr / 100 / 12;
          totalDebtWithAPR += balance;
        }
      }
    }

    // APR completeness across FULL-visibility debt accounts only.
    const aprCompleteness: AprCompleteness =
      fullVisDebtCount === 0         ? 'NONE'    :
      fullVisWithAPR === 0           ? 'NONE'    :
      fullVisWithAPR === fullVisDebtCount ? 'FULL' :
      'PARTIAL';

    // APR gap account names (FULL-visibility only — privacy enforced by assembler).
    const aprGapAccountNames: string[] = (accts.knowledgeGaps ?? [])
      .filter((g) => g.field === 'apr')
      .map((g) => g.accountName);

    // Debt health classification.
    let debtHealthClassification: DebtHealthClassification;
    if (hasNullAPR) {
      debtHealthClassification = 'INSUFFICIENT_DATA';
    } else {
      const weightedAvgAPR = totalDebtWithAPR > 0
        ? (interestBurden * 12 / totalDebtWithAPR) * 100
        : 0;
      const history = snap?.history ?? [];
      const isLiabilitiesDeclining =
        history.length >= 7 &&
        history[history.length - 1].liabilities < history[0].liabilities;

      if (weightedAvgAPR > APR_CRITICAL_THRESHOLD) {
        debtHealthClassification = 'CRITICAL';
      } else if (weightedAvgAPR > APR_WARNING_THRESHOLD) {
        debtHealthClassification = 'WARNING';
      } else if (isLiabilitiesDeclining) {
        debtHealthClassification = 'IMPROVING';
      } else {
        debtHealthClassification = 'HEALTHY';
      }
    }

    // Debt confidence: how reliable is the classification?
    // Balance data is always reliable; the uncertainty is APR completeness.
    const debtConfidence: ConfidenceLevel =
      debtHealthClassification !== 'INSUFFICIENT_DATA' ? 'HIGH' :
      aprCompleteness === 'PARTIAL'                    ? 'MEDIUM' :
      'LOW';

    debtSection = {
      classification:        debtHealthClassification,
      confidence:            debtConfidence,
      totalLiabilities,
      monthlyInterestBurden: interestBurden > 0
        ? Math.round(interestBurden * 100) / 100
        : null,
      aprCompleteness,
      hasNullAPR,
      hasBalanceOnlyDebt,
      aprGapAccountNames,
    };
  }

  // ── Step 4: Liquidity ────────────────────────────────────────────────────

  const liquidAccountCount: number = accts?.counts.liquid ?? 0;
  const hasAccountsDomain:  boolean = accts !== null;
  const noLiquidAccountsInSpace = hasAccountsDomain && liquidAccountCount === 0;

  // KD-10: same authoritative value as cash flow — one source of truth. Coverage
  // below divides liquid cash by this figure, so both stay consistent.
  const estimatedMonthlyExpense: number | null = computeAverageMonthlySpending(txn);

  let liquidityCoverageMonths: number | null = null;
  let liquidityCoverageClassification: LiquidityCoverageClassification;

  if (liquidAccountCount === 0 || estimatedMonthlyExpense === null) {
    liquidityCoverageClassification = 'UNKNOWN';
  } else {
    liquidityCoverageMonths = Math.round((totalLiquid / estimatedMonthlyExpense) * 100) / 100;
    liquidityCoverageClassification =
      liquidityCoverageMonths < LIQUIDITY_CRITICAL_MONTHS  ? 'CRITICAL' :
      liquidityCoverageMonths < LIQUIDITY_WARNING_MONTHS   ? 'WARNING'  :
      liquidityCoverageMonths < LIQUIDITY_EXCELLENT_MONTHS ? 'SAFE'     :
      'EXCELLENT';
  }

  // Liquidity confidence: balance data is always reliable when accounts are present.
  const liquidityConfidence: ConfidenceLevel =
    !hasAccountsDomain      ? 'LOW'    :
    noLiquidAccountsInSpace ? 'MEDIUM' : // accounts present but liquid ones missing from Space
    'HIGH';

  const liquidity: LiquiditySection = {
    classification:          liquidityCoverageClassification,
    confidence:              liquidityConfidence,
    liquidCashTotal:         totalLiquid,
    liquidAccountCount,
    coverageMonths:          liquidityCoverageMonths,
    estimatedMonthlyExpense,
    noLiquidAccountsInSpace,
    hasAccountsDomain,
  };

  // ── Step 5: Current state priority ──────────────────────────────────────

  const currentStatePriority: CurrentStatePriority = (() => {
    if (
      transactionHistoryCompleteness === 'LOW' ||
      incomeConfidence === 'LOW'
    ) return 'DATA_QUALITY';

    if (liquidityCoverageClassification === 'CRITICAL') return 'LIQUIDITY';
    if (debtSection.classification === 'CRITICAL')      return 'DEBT';

    if (deficitCause === 'POSSIBLE_OVERSPENDING') return 'CASH_FLOW';
    if (debtSection.classification === 'WARNING') return 'DEBT';

    if (deficitCause === 'INTENTIONAL_DEBT_PAYOFF' || deficitCause === 'MIXED') return 'CASH_FLOW';

    return 'LIQUIDITY';
  })();

  // ── Step 6: Debt Strategy (2.2) ─────────────────────────────────────────

  const debtStrategy = computeDebtStrategy(accts, debtSection);

  // ── Step 7: Capital Allocation (2.1) ────────────────────────────────────
  // Must follow debtStrategy — uses its weightedAvgApr output.

  const capitalAllocation = computeCapitalAllocation(liquidity, debtSection, cashFlow, debtStrategy);

  // ── Step 8: Spending Opportunities (2.3) ────────────────────────────────

  const spendingOpportunities = computeSpendingOpportunities(txn, dataQuality);

  // ── Step 8B: Spending Trends (2.3B) ─────────────────────────────────────
  // Deterministic MoM / rolling trends from monthlyBreakdown complete months.

  const spendingTrends = computeSpendingTrends(txn);

  // ── Step 9: Goal Alignment (2.4) ────────────────────────────────────────

  const goalAlignment = computeGoalAlignment(goals, cashFlow, debtSection, txn, snap);

  // ── Step 10: Investment Readiness (2.5) ─────────────────────────────────

  const investmentReadiness = computeInvestmentReadiness(liquidity, debtSection, debtStrategy, ctx);

  // ── Step 11: Risk & Opportunity (2.6) ────────────────────────────────────
  // Aggregates the sections above — must run after all of them are computed.

  const riskOpportunities = computeRiskOpportunities(
    dataQuality,
    cashFlow,
    debtSection,
    liquidity,
    debtStrategy,
    spendingOpportunities,
    goalAlignment,
    investmentReadiness,
    txn, // TI2-W2 — amount-based INCOMPLETE_INCOME_DATA wording
  );

  // ── Step 12: Heuristics and priorities ──────────────────────────────────

  const advisorHeuristics = deriveHeuristics(dataQuality, cashFlow, debtSection, liquidity);
  const priorities        = derivePriorities(dataQuality, cashFlow, debtSection, liquidity);

  return {
    dataQuality,
    cashFlow,
    debt:                  debtSection,
    liquidity,
    capitalAllocation,
    debtStrategy,
    spendingOpportunities,
    spendingTrends,
    goalAlignment,
    investmentReadiness,
    riskOpportunities,
    currentStatePriority,
    advisorHeuristics,
    priorities,
  };
}


