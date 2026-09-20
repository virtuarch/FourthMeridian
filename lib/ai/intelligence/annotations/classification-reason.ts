/**
 * lib/ai/intelligence/annotations/classification-reason.ts
 *
 * THE REASON A CLASSIFICATION FIRED, AND WHAT A DEBT RATE COSTS — pure builders
 * for the `ClassificationReason` and `DebtBurden` shapes (./types).
 *
 * ⚠️ THE LADDERS LIVE HERE ONCE. `gradeDebtRate` and `gradeLiquidityCoverage`
 * return the classification AND the rung that produced it from the same
 * comparison, so a reason can never describe a rule other than the one that ran.
 * The thresholds are the engine's existing constants; none is introduced here.
 *
 * ⚠️ A RATIO OVER NOTHING IS NOT A NUMBER. `pctOf` returns null when its base is
 * absent, non-finite or under half a cent (`MONEY_EPSILON`, the repository's one
 * "same amount of money" rule) — the convention M1's comparison contract and
 * `lib/data/snapshot-window` share. It never returns Infinity and never a 0 that
 * would read as "no burden".
 *
 * Pure. No data access, no clock.
 */

import type {
  ClassificationReason, DebtBurden, DebtRateClassification, DebtReasonCode,
  LiquidityCoverageClassification, LiquidityReasonCode,
} from './types';
import {
  APR_CRITICAL_THRESHOLD, APR_WARNING_THRESHOLD,
  LIQUIDITY_CRITICAL_MONTHS, LIQUIDITY_WARNING_MONTHS, LIQUIDITY_EXCELLENT_MONTHS,
} from './constants';
import { MONEY_EPSILON } from '@/lib/data/snapshot-window';

const round2 = (n: number) => Math.round(n * 100) / 100;
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** part ÷ base × 100 at 2dp, or null when the base cannot be divided by. */
export function pctOf(part: number | null | undefined, base: number | null | undefined): number | null {
  if (!finite(part) || !finite(base) || Math.abs(base) < MONEY_EPSILON) return null;
  return round2((part / Math.abs(base)) * 100);
}

// ── Debt: the rate ladder ─────────────────────────────────────────────────────

export interface DebtRateInputs {
  /** Owed-weighted APR over rated rows that owe; null when nothing rated is owed. */
  weightedAprPct:         number | null;
  /** Reporting-currency amount owed across those rated rows. */
  ratedOwed:              number;
  /** `liabilitiesChange.abs` over the canonical window; null when refused. */
  liabilitiesChangeAbs:   number | null;
  debtAccounts:           number;
  debtAccountsWithApr:    number;
}

/**
 * The graded rungs of the debt RATE ladder (every APR known, liabilities > 0).
 * Behaviour is the ladder `computeAssessment` has always run: a null blended
 * rate weighs as 0, so only the trend tie-break can speak.
 */
export function gradeDebtRate(i: DebtRateInputs): {
  classification: DebtRateClassification; reason: ClassificationReason<DebtReasonCode>;
} {
  const apr = i.weightedAprPct ?? 0;
  const declining = (i.liabilitiesChangeAbs ?? 0) < 0;
  const [classification, reasonCode]: [DebtRateClassification, DebtReasonCode] =
    apr > APR_CRITICAL_THRESHOLD ? ['CRITICAL', 'WEIGHTED_APR_ABOVE_CRITICAL']
    : apr > APR_WARNING_THRESHOLD ? ['WARNING', 'WEIGHTED_APR_ABOVE_WARNING']
    : declining ? ['IMPROVING', 'RATE_BELOW_WARNING_LIABILITIES_DECLINING']
    : ['HEALTHY', 'RATE_BELOW_WARNING'];
  return {
    classification,
    reason: {
      scope: 'RATE_ON_OWED_BALANCE',
      reasonCode,
      reasonMetrics: {
        weightedAprPct: i.weightedAprPct === null ? null : round2(i.weightedAprPct),
        criticalAbovePct: APR_CRITICAL_THRESHOLD,
        warningAbovePct:  APR_WARNING_THRESHOLD,
        ratedOwed: round2(i.ratedOwed),
        // The tie-break's operand is echoed only on the rungs that read it.
        ...(classification === 'IMPROVING' || classification === 'HEALTHY'
          ? { liabilitiesChangeOverWindow: i.liabilitiesChangeAbs === null ? null : round2(i.liabilitiesChangeAbs) } : {}),
      },
      evidencePopulation: { kind: 'DEBT_ACCOUNTS', accounts: i.debtAccounts, graded: i.debtAccountsWithApr },
    },
  };
}

/** The refusing / vacuous rungs — no rate was graded, and the reason says why. */
export function ungradedDebtReason(
  reasonCode: Extract<DebtReasonCode, 'ACCOUNTS_DOMAIN_ABSENT' | 'NO_LIABILITIES' | 'ACCOUNT_LIST_ABSENT' | 'APR_UNKNOWN'>,
  population: { debtAccounts: number; debtAccountsWithApr: number },
): ClassificationReason<DebtReasonCode> {
  return {
    scope: 'RATE_ON_OWED_BALANCE',
    reasonCode,
    reasonMetrics: {},
    evidencePopulation: { kind: 'DEBT_ACCOUNTS', accounts: population.debtAccounts, graded: population.debtAccountsWithApr },
  };
}

// ── Debt: the burden (ungraded) ───────────────────────────────────────────────

export function computeDebtBurden(i: {
  ratedOwed: number;
  monthlyInterestIfCarried: number | null;
  totalLiabilities: number;
  monthlyIncome: number | null;
  monthlyExpenses: number | null;
  liquid: number | null;
}): DebtBurden {
  const interest = finite(i.monthlyInterestIfCarried) ? round2(i.monthlyInterestIfCarried) : null;
  return {
    ratedOwed: round2(i.ratedOwed),
    monthlyInterestIfCarried: interest,
    monthlyIncome:   finite(i.monthlyIncome) ? round2(i.monthlyIncome) : null,
    monthlyExpenses: finite(i.monthlyExpenses) ? round2(i.monthlyExpenses) : null,
    liquid:          finite(i.liquid) ? round2(i.liquid) : null,
    interestOfMonthlyIncomePct:   pctOf(interest, i.monthlyIncome),
    interestOfMonthlyExpensesPct: pctOf(interest, i.monthlyExpenses),
    owedOfLiquidPct: i.totalLiabilities > 0 ? pctOf(i.totalLiabilities, i.liquid) : null,
  };
}

// ── Liquidity: the coverage ladder ────────────────────────────────────────────

/** The graded rungs of the coverage ladder, for a finite `coverageMonths`. */
export function gradeLiquidityCoverage(coverageMonths: number): {
  classification: LiquidityCoverageClassification; reasonCode: LiquidityReasonCode;
} {
  return coverageMonths < LIQUIDITY_CRITICAL_MONTHS ? { classification: 'CRITICAL', reasonCode: 'COVERAGE_BELOW_CRITICAL' }
    : coverageMonths < LIQUIDITY_WARNING_MONTHS ? { classification: 'WARNING', reasonCode: 'COVERAGE_BELOW_WARNING' }
    : coverageMonths < LIQUIDITY_EXCELLENT_MONTHS ? { classification: 'SAFE', reasonCode: 'COVERAGE_BELOW_EXCELLENT' }
    : { classification: 'EXCELLENT', reasonCode: 'COVERAGE_AT_OR_ABOVE_EXCELLENT' };
}

export function liquidityReason(i: {
  reasonCode: LiquidityReasonCode;
  coverageMonths: number | null;
  liquid: number;
  monthlyExpenses: number | null;
  /** Which rung supplied the expense figure (DECLARED / MEASURED …), or null when refused. */
  monthlyExpensesBasis: string | null;
  liquidAccounts: number;
}): ClassificationReason<LiquidityReasonCode> {
  return {
    scope: 'LIQUID_CASH_VS_MONTHLY_EXPENSES',
    reasonCode: i.reasonCode,
    reasonMetrics: {
      coverageMonths: i.coverageMonths,
      liquid: round2(i.liquid),
      monthlyExpenses: finite(i.monthlyExpenses) ? round2(i.monthlyExpenses) : null,
      monthlyExpensesBasis: i.monthlyExpensesBasis,
      criticalBelowMonths:  LIQUIDITY_CRITICAL_MONTHS,
      warningBelowMonths:   LIQUIDITY_WARNING_MONTHS,
      excellentFromMonths:  LIQUIDITY_EXCELLENT_MONTHS,
    },
    evidencePopulation: { kind: 'LIQUID_ACCOUNTS', accounts: i.liquidAccounts,
      graded: i.coverageMonths === null ? 0 : i.liquidAccounts },
  };
}
