/**
 * lib/ai/intelligence/annotations/rules.ts
 *
 * Deterministic typed-flag derivation (advisor heuristics) and priority ranking.
 * Pure; consumes already-computed Section objects.
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

import type {
  AdvisorHeuristic,
  AssessmentPriority,
  DataQualitySection,
  CashFlowSection,
  DebtSection,
  LiquiditySection,
} from './types';
import {
  LIQUIDITY_WARNING_MONTHS,
} from './constants';

export function deriveHeuristics(
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

export function derivePriorities(
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

// ── 2.3 Spending Opportunity computation ─────────────────────────────────────

// FlowType P5 Slice 7: the legacy SPENDING_EXCLUDED set was deleted after the
// Slice 5 gate cutover left it with zero runtime references — the exclusion is
// now flow semantics (see classifySpendingCategory below).

