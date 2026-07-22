/**
 * lib/ai/intelligence/annotations/constants.ts
 *
 * Named classification thresholds, category taxonomy sets, and sort-rank maps
 * for the Financial Intelligence engine. Extracted verbatim from annotations.ts.
 *
 * AI-ARCH Part 5: extracted from the former lib/ai/intelligence/annotations.ts
 * god-module (byte-identical bodies). Public surface re-exported via ./index.
 */

import type {
  ConfidenceLevel,
  RiskSeverity,
  OpportunityImpact,
} from './types';
export const SNAPSHOT_LOW_THRESHOLD    = 14;
/** Reference passive-index annual return (%) used to determine whether debt payoff beats investing. */

export const MARKET_RETURN_THRESHOLD   = 7;

export const SNAPSHOT_HIGH_THRESHOLD   = 45;

export const TXN_COUNT_MINIMUM         = 20;

export const INCOME_PLAUS_RATIO_LOW    = 0.5;

export const INCOME_TXN_HIGH_THRESHOLD = 3;

export const APR_CRITICAL_THRESHOLD    = 22;

export const APR_WARNING_THRESHOLD     = 15;

export const LIQUIDITY_CRITICAL_MONTHS = 1;

export const LIQUIDITY_WARNING_MONTHS  = 3;

export const LIQUIDITY_EXCELLENT_MONTHS = 6;

export const DEBT_FRACTION_DOMINANT    = 0.5;

export const DEBT_FRACTION_PARTIAL     = 0.25;
/** Minimum monthly equivalent ($) for a REVIEW_NEEDED category to be surfaced. */

export const REVIEW_MIN_MONTHLY        = 20;
/** Days without a habit check-in before the habit is considered stale. */

export const HABIT_STALE_DAYS          = 14;
/** Monthly discretionary spend ($) above which a cut opportunity is HIGH impact. */

export const OPP_DISCRETIONARY_HIGH_MONTHLY = 300;
/** Monthly discretionary spend ($) above which a cut opportunity is MEDIUM impact. */

export const OPP_DISCRETIONARY_MED_MONTHLY  = 100;

// ── Domain extraction helpers ─────────────────────────────────────────────────


export const SPENDING_DISCRETIONARY      = new Set(['Dining', 'Shopping', 'Travel', 'Subscriptions']);

export const SPENDING_SEMI_DISCRETIONARY = new Set(['Groceries']);

export const SPENDING_FIXED              = new Set(['Utilities']);


export const TREND_FLAT_PCT = 2;

/** Round to cents (2 dp). */

export const SEVERITY_RANK:   Record<RiskSeverity, number>      = { critical: 0, warning: 1, info: 2 };

export const IMPACT_RANK:     Record<OpportunityImpact, number> = { high: 0, medium: 1, low: 2 };

export const CONFIDENCE_RANK: Record<ConfidenceLevel, number>   = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Aggregates already-computed assessment sections into ranked risk and
 * opportunity candidates.
 *
 * Pure function. No DB queries. No recalculation from raw context — every value
 * is read from the section objects produced earlier in computeAssessment().
 * The LLM turns these candidates into recommendations; this engine does not.
 *
 * Sorting:
 *   risks         — severity (critical → info) then confidence (HIGH → LOW)
 *   opportunities — impact   (high → low)      then confidence (HIGH → LOW)
 */
