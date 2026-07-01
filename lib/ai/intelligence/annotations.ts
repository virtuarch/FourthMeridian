/**
 * lib/ai/intelligence/annotations.ts
 *
 * Layer 2 Financial Intelligence — D4 v2.
 *
 * computeAssessment() runs a deterministic, single-pass analysis over an
 * already-assembled SpaceContext_AI and returns a FinancialAssessment object.
 * The assessment is injected into the system prompt as a === FINANCIAL ASSESSMENT ===
 * block, giving the LLM interpreted financial state before it reads raw context numbers.
 *
 * Changes from Slice 1:
 *   - Flat FinancialAnnotations replaced by typed sections:
 *       dataQuality, cashFlow, debt, liquidity
 *   - Each section carries its own confidence level.
 *   - New: advisorHeuristics — deterministic typed flags (no prose).
 *   - New: priorities — ranked, severity-coded hints for the LLM.
 *   - computeAnnotations is kept as a backward-compat alias.
 *
 * Design constraints (unchanged from Slice 1):
 *   - Pure function. No DB queries, no LLM calls, no side effects.
 *   - Called after buildContext() and before prompt construction.
 *   - All classification thresholds are named constants.
 *   - Never import from lib/plaid/encryption or any decrypt function.
 *
 * Principle:
 *   The deterministic layer computes math, classifications, confidence, and
 *   explainability. The LLM decides how to phrase, prioritize, and recommend
 *   based on the user's actual question.
 */

import type {
  SpaceContext_AI,
  TransactionsSummaryData,
  SnapshotSectionData,
  AccountsSectionData,
  GoalsSectionData,
} from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';

// ── Primitive classification types ────────────────────────────────────────────

export type CompletenessLevel  = 'LOW' | 'MEDIUM' | 'HIGH';
export type ConfidenceLevel    = 'LOW' | 'MEDIUM' | 'HIGH';
export type CashFlowReliability = 'UNRELIABLE' | 'PARTIAL' | 'RELIABLE';

export type DeficitCauseClassification =
  | 'INTENTIONAL_DEBT_PAYOFF'  // debt payments dominate + active debt goal confirms strategy
  | 'POSSIBLE_OVERSPENDING'    // deficit not explained by intentional debt payoff
  | 'LOW_INCOME_SAMPLE'        // income data is incomplete — deficit is a data artifact
  | 'MIXED'                    // significant debt payments but not dominant cause
  | 'NOT_APPLICABLE';          // no deficit (cash flow ≥ 0)

export type DebtHealthClassification =
  | 'CRITICAL'          // high-APR debt needing urgent attention
  | 'WARNING'           // elevated APR worth active management
  | 'IMPROVING'         // liabilities declining over snapshot window
  | 'HEALTHY'           // APR manageable and not rising
  | 'INSUFFICIENT_DATA' // APR missing for one or more debt accounts
  | 'NO_DEBT';          // no liabilities in context

export type LiquidityCoverageClassification =
  | 'CRITICAL'   // < 1 month
  | 'WARNING'    // 1 – 2 months
  | 'SAFE'       // 3 – 5 months
  | 'EXCELLENT'  // ≥ 6 months
  | 'UNKNOWN';   // cannot compute (no expense data or no liquid accounts)

export type CurrentStatePriority =
  | 'DATA_QUALITY'  // incomplete data overrides all other findings
  | 'LIQUIDITY'     // critically low or notably high liquid coverage
  | 'DEBT'          // critical or warning-level debt health
  | 'CASH_FLOW'     // spending problem or intentional payoff to surface
  | 'GOALS'         // goal needs attention
  | 'GOALS_GOOD';   // position looks healthy — affirm progress

/** Whether APR is known for all, some, or no FULL-visibility debt accounts. */
export type AprCompleteness = 'FULL' | 'PARTIAL' | 'NONE';

// ── Advisor heuristics ────────────────────────────────────────────────────────

/**
 * Deterministic typed flags the LLM uses to calibrate its advice.
 * These are structured facts, not prose recommendations.
 * The LLM decides how to apply them to the user's specific question.
 */
export type AdvisorHeuristic =
  | 'HIGH_APR_DEBT_PRIORITY'                  // CRITICAL or WARNING debt classification
  | 'DATA_QUALITY_LIMITS_CASH_FLOW_ADVICE'    // income confidence is LOW
  | 'LIQUIDITY_UNKNOWN_FOR_SPACE'             // accounts present but no liquid accounts in this Space
  | 'DEBT_PAYOFF_IS_INTENTIONAL'              // INTENTIONAL_DEBT_PAYOFF or MIXED deficit cause
  | 'APR_REQUIRED_FOR_PRECISE_PAYOFF'         // hasNullAPR with outstanding liabilities
  | 'INCOME_INCOMPLETE_DO_NOT_DEFICIT_FRAME'  // income confidence LOW — never frame as cash deficit
  | 'LOW_LIQUIDITY_COVERAGE';                 // CRITICAL or WARNING liquidity classification

export type HeuristicSeverity = 'info' | 'warning' | 'critical';

/**
 * A single ranked priority hint.
 * Not a recommendation — deterministic input for LLM reasoning.
 */
export interface AssessmentPriority {
  code:     CurrentStatePriority;
  severity: HeuristicSeverity;
  reason:   string;
}

// ── Typed assessment sections ─────────────────────────────────────────────────

export interface DataQualitySection {
  transactionHistoryCompleteness: CompletenessLevel;
  snapshotSpanDays:               number;
  incomeConfidence:               ConfidenceLevel;
  incomeTransactionCount:         number;
}

export interface CashFlowSection {
  reliability:                  CashFlowReliability;
  /** Mirrors income confidence — income is the volatile input in the cash flow equation. */
  confidence:                   ConfidenceLevel;
  deficitCause:                 DeficitCauseClassification;
  transactionCompleteness:      CompletenessLevel;
  impliedMonthlyIncome:         number | null;
  estimatedMonthlyExpenses:     number | null;
  /** Annualized debt payment flow divided into monthly equivalent. Reliable when window is ≥ 30 days. */
  estimatedMonthlyDebtPayments: number | null;
  incomeTransactionCount:       number;
  /**
   * True when income confidence is LOW.
   * Instructs the LLM not to declare negative cash flow as a fact —
   * the apparent deficit is a data artifact.
   */
  incompleteIncomeWarning:      boolean;
}

export interface DebtSection {
  classification:        DebtHealthClassification;
  /**
   * HIGH   — all FULL-visibility debt APRs are known.
   * MEDIUM — some FULL-visibility debt APRs known, some missing.
   * LOW    — no APRs known, or no FULL-visibility debt accounts.
   */
  confidence:            ConfidenceLevel;
  totalLiabilities:      number;
  monthlyInterestBurden: number | null;
  /** APR coverage across FULL-visibility debt accounts only. */
  aprCompleteness:       AprCompleteness;
  /** True when any debt account (FULL or BALANCE_ONLY) has no APR available. */
  hasNullAPR:            boolean;
  /**
   * True when any debt account is BALANCE_ONLY — APR is structurally inaccessible
   * in this Space, not a missing user-input problem.
   */
  hasBalanceOnlyDebt:    boolean;
  /**
   * Names of FULL-visibility debt accounts where APR is null (user can fix these).
   * Never contains BALANCE_ONLY account names.
   */
  aprGapAccountNames:    string[];
}

export interface LiquiditySection {
  classification:          LiquidityCoverageClassification;
  /**
   * HIGH   — liquid accounts present in this Space, balance data reliable.
   * MEDIUM — accounts present but no liquid accounts linked to this Space.
   * LOW    — no accounts domain at all.
   */
  confidence:              ConfidenceLevel;
  liquidCashTotal:         number;
  liquidAccountCount:      number;
  coverageMonths:          number | null;
  estimatedMonthlyExpense: number | null;
  /**
   * True when the accounts domain was assembled (hasAccountsDomain)
   * but no checking or savings accounts are linked to this Space.
   * Liquid assets may exist in other Spaces — the LLM must not say the
   * user has no liquid cash globally.
   */
  noLiquidAccountsInSpace: boolean;
  /** False when the accounts domain was not assembled for this Space. */
  hasAccountsDomain:       boolean;
}

// ── Main v2 type ──────────────────────────────────────────────────────────────

/**
 * Structured financial assessment produced by computeAssessment().
 *
 * Replaces the flat FinancialAnnotations from Slice 1.
 * Each section owns its classification, confidence, and supporting metrics.
 * The LLM receives this as the FINANCIAL ASSESSMENT prompt block.
 */
export interface FinancialAssessment {
  dataQuality:          DataQualitySection;
  cashFlow:             CashFlowSection;
  debt:                 DebtSection;
  liquidity:            LiquiditySection;
  /** Top-ranked priority — used by the prompt for the leading instruction. */
  currentStatePriority: CurrentStatePriority;
  /** Typed advisor flags derived deterministically from the sections above. */
  advisorHeuristics:    AdvisorHeuristic[];
  /** Ranked list of active priorities — deterministic hints, not recommendations. */
  priorities:           AssessmentPriority[];
}

/**
 * Backward-compat alias.
 * Slice 1 callers that imported FinancialAnnotations still compile; they must
 * update field access from flat (annotations.incomeConfidence) to nested
 * (assessment.dataQuality.incomeConfidence).
 */
export type FinancialAnnotations = FinancialAssessment;

// ── Thresholds ────────────────────────────────────────────────────────────────

const SNAPSHOT_LOW_THRESHOLD    = 14;
const SNAPSHOT_HIGH_THRESHOLD   = 45;
const TXN_COUNT_MINIMUM         = 20;
const INCOME_PLAUS_RATIO_LOW    = 0.5;
const INCOME_TXN_HIGH_THRESHOLD = 3;
const APR_CRITICAL_THRESHOLD    = 22;
const APR_WARNING_THRESHOLD     = 15;
const LIQUIDITY_CRITICAL_MONTHS = 1;
const LIQUIDITY_WARNING_MONTHS  = 3;
const LIQUIDITY_EXCELLENT_MONTHS = 6;
const DEBT_FRACTION_DOMINANT    = 0.5;
const DEBT_FRACTION_PARTIAL     = 0.25;

// ── Domain extraction helpers ─────────────────────────────────────────────────

function getTxnData(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const section = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  if (!section?.data) return null;
  return section.data as TransactionsSummaryData;
}

function getSnapData(ctx: SpaceContext_AI): SnapshotSectionData | null {
  const section = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY];
  if (!section?.data) return null;
  return section.data as SnapshotSectionData;
}

function getAcctsData(ctx: SpaceContext_AI): AccountsSectionData | null {
  const section = ctx.domains[FinanceDomains.ACCOUNTS];
  if (!section?.data) return null;
  return section.data as AccountsSectionData;
}

function getGoalsData(ctx: SpaceContext_AI): GoalsSectionData | null {
  const section = ctx.domains[FinanceDomains.GOALS];
  if (!section?.data) return null;
  return section.data as GoalsSectionData;
}

// ── Heuristic derivation ──────────────────────────────────────────────────────

function deriveHeuristics(
  dataQuality: DataQualitySection,
  cashFlow:    CashFlowSection,
  debt:        DebtSection,
  liquidity:   LiquiditySection,
): AdvisorHeuristic[] {
  const h: AdvisorHeuristic[] = [];

  if (dataQuality.incomeConfidence === 'LOW') {
    h.push('DATA_QUALITY_LIMITS_CASH_FLOW_ADVICE');
    h.push('INCOME_INCOMPLETE_DO_NOT_DEFICIT_FRAME');
  }

  if (debt.classification === 'CRITICAL' || debt.classification === 'WARNING') {
    h.push('HIGH_APR_DEBT_PRIORITY');
  }

  if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    h.push('APR_REQUIRED_FOR_PRECISE_PAYOFF');
  }

  if (liquidity.noLiquidAccountsInSpace) {
    h.push('LIQUIDITY_UNKNOWN_FOR_SPACE');
  }

  if (
    cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF' ||
    cashFlow.deficitCause === 'MIXED'
  ) {
    h.push('DEBT_PAYOFF_IS_INTENTIONAL');
  }

  if (
    liquidity.classification === 'CRITICAL' ||
    liquidity.classification === 'WARNING'
  ) {
    h.push('LOW_LIQUIDITY_COVERAGE');
  }

  return h;
}

// ── Priority ranking ──────────────────────────────────────────────────────────

/**
 * Produce an ordered list of active priorities.
 * Each active condition that the LLM should know about gets an entry.
 * Severity reflects urgency: critical > warning > info.
 * This is NOT a recommendation — the LLM decides how to act on these hints.
 */
function derivePriorities(
  dataQuality: DataQualitySection,
  cashFlow:    CashFlowSection,
  debt:        DebtSection,
  liquidity:   LiquiditySection,
): AssessmentPriority[] {
  const result: AssessmentPriority[] = [];

  if (
    dataQuality.transactionHistoryCompleteness === 'LOW' ||
    dataQuality.incomeConfidence === 'LOW'
  ) {
    result.push({
      code:     'DATA_QUALITY',
      severity: 'warning',
      reason:   dataQuality.incomeConfidence === 'LOW'
        ? 'Income history incomplete — connect all income accounts for accurate analysis'
        : 'Transaction history is sparse — financial analysis is limited',
    });
  }

  if (liquidity.classification === 'CRITICAL') {
    result.push({
      code:     'LIQUIDITY',
      severity: 'critical',
      reason:   'Liquid coverage below 1 month',
    });
  }

  if (debt.classification === 'CRITICAL') {
    result.push({
      code:     'DEBT',
      severity: 'critical',
      reason:   'High-APR debt requires urgent attention',
    });
  }

  if (cashFlow.deficitCause === 'POSSIBLE_OVERSPENDING') {
    result.push({
      code:     'CASH_FLOW',
      severity: 'warning',
      reason:   'Spending may be exceeding income',
    });
  }

  if (debt.classification === 'WARNING') {
    result.push({
      code:     'DEBT',
      severity: 'warning',
      reason:   'Elevated APR worth active management',
    });
  }

  if (liquidity.classification === 'WARNING') {
    result.push({
      code:     'LIQUIDITY',
      severity: 'warning',
      reason:   `Liquid coverage below ${LIQUIDITY_WARNING_MONTHS} months`,
    });
  }

  if (cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF') {
    result.push({
      code:     'CASH_FLOW',
      severity: 'info',
      reason:   'Intentional debt payoff strategy — active debt goal confirmed',
    });
  } else if (cashFlow.deficitCause === 'MIXED') {
    result.push({
      code:     'CASH_FLOW',
      severity: 'warning',
      reason:   'Mixed deficit — debt payments plus non-debt spending above income',
    });
  }

  return result;
}

// ── Main computation ──────────────────────────────────────────────────────────

/**
 * Compute a structured financial assessment for a fully-assembled SpaceContext_AI.
 *
 * Pure function — no DB queries, no side effects, no LLM calls.
 * Call this after buildContext() and before prompt construction.
 */
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

  const incomeConfidence: ConfidenceLevel = (() => {
    if (transactionHistoryCompleteness === 'LOW' || incomeTransactionCount === 0) return 'LOW';
    if (snapshotCount < SNAPSHOT_HIGH_THRESHOLD) {
      if (incomeTransactionCount <= 1 || incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
      return 'MEDIUM';
    }
    if (incomeTransactionCount <= 1 && incomePlausRatio < INCOME_PLAUS_RATIO_LOW) return 'LOW';
    if (incomeTransactionCount >= INCOME_TXN_HIGH_THRESHOLD && incomePlausRatio >= INCOME_PLAUS_RATIO_LOW) return 'HIGH';
    return 'MEDIUM';
  })();

  const dataQuality: DataQualitySection = {
    transactionHistoryCompleteness,
    snapshotSpanDays: snapshotCount,
    incomeConfidence,
    incomeTransactionCount,
  };

  // ── Step 2: Cash flow ────────────────────────────────────────────────────

  const impliedMonthlyIncome: number | null = txn && windowDays > 0
    ? Math.round((incomeTotal / windowDays * 30) * 100) / 100
    : null;

  const estimatedMonthlyExpenses: number | null = txn && windowDays > 0 && expenseTotal > 0
    ? Math.round((expenseTotal / windowDays * 30) * 100) / 100
    : null;

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
        if (acct.apr > 0) {
          const balance   = Math.abs(acct.balance);
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

  const estimatedMonthlyExpense: number | null = txn && windowDays > 0 && expenseTotal > 0
    ? Math.round((expenseTotal / windowDays * 30) * 100) / 100
    : null;

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

  // ── Step 6: Heuristics and priorities ────────────────────────────────────

  const advisorHeuristics = deriveHeuristics(dataQuality, cashFlow, debtSection, liquidity);
  const priorities        = derivePriorities(dataQuality, cashFlow, debtSection, liquidity);

  return {
    dataQuality,
    cashFlow,
    debt:                 debtSection,
    liquidity,
    currentStatePriority,
    advisorHeuristics,
    priorities,
  };
}

/**
 * Backward-compat alias for Slice 1 call sites.
 * Prefer computeAssessment() in new code.
 */
export const computeAnnotations = computeAssessment;
