/**
 * lib/reasoning/measure/types.ts
 *
 * V26-REASONING Slice 3 — ONE PRIMITIVE UNDER WHICH `net_worth@now` AND
 * `net_worth@2026-12-31` ARE THE SAME OBJECT, DIFFERENTLY LICENSED.
 *
 * Forecast stops being a subsystem and becomes an OPERATION: the same measure,
 * asked at a different instant, resolved by a different authority and carrying a
 * weaker standing. That is the whole idea, and everything below is the type
 * needed to say it without lying.
 *
 * ⚠️ NO NEW ARITHMETIC LIVES BEHIND THIS TYPE. Every evaluator is a thin adapter
 * over an authority this repository already ships and already trusts. Parity is
 * the acceptance test, and a divergence is either a bug in the adapter or a bug
 * just discovered in the original — never something to paper over.
 */

import type { RefusalCode, Refusal } from '../refusal';
import { Standing, type StandingKind, FigureUnit, type FigureUnitName } from '../figures/types';

export { Standing, FigureUnit };
export type { StandingKind, RefusalCode, Refusal };
export type MeasureUnit = FigureUnitName;

/**
 * The quantities this layer can be asked about.
 *
 * ⚠️ A CLOSED SET, AND SMALL ON PURPOSE. It is the vocabulary a checkpoint will
 * eventually be keyed on, so every addition is a migration somebody will regret.
 * Each one names a quantity a person would ask about in those words.
 */
export const MeasureId = {
  LIQUID_CASH:              'liquid_cash',
  INVESTMENTS_VALUE:        'investments_value',
  DIGITAL_ASSETS_VALUE:     'digital_assets_value',
  REAL_ASSETS_VALUE:        'real_assets_value',
  DEBT_BALANCE:             'debt_balance',
  NET_WORTH:                'net_worth',
  MONTHLY_SPENDING:         'monthly_spending',
  MONTHLY_INCOME:           'monthly_income',
  MONTHLY_NET:              'monthly_net',
  RUNWAY_MONTHS:            'runway_months',
  SAVINGS_RATE:             'savings_rate',
  CONCENTRATION_TOP_WEIGHT: 'concentration_top_weight',
} as const;
export type MeasureIdName = typeof MeasureId[keyof typeof MeasureId];

/** WHEN a measure is asked about. */
export type Instant = { kind: 'NOW' } | { kind: 'DATE'; iso: string };
export const NOW: Instant = { kind: 'NOW' };
export const at = (iso: string): Instant => ({ kind: 'DATE', iso });
export const instantKey = (i: Instant) => (i.kind === 'NOW' ? 'NOW' : i.iso);

/**
 * A measure either HAS A VALUE or HAS REASONS. Never both, never neither.
 *
 * ⚠️ A DISCRIMINATED UNION SO `value: null` BESIDE `standing: MEASURED` IS
 * UNREPRESENTABLE rather than merely wrong. That combination is the shape of
 * every "unknown became zero" defect this codebase has recorded — W6's
 * `nativeBalance ?? 0` made UNKNOWN equal to a confirmed zero, and W-M3a's
 * NOT-NULL-DEFAULT-0 balance column rendered a withheld account as $0.00.
 * Unresolvedness is structural here, not a sentinel.
 */
export type Resolution =
  | { kind: 'VALUE'; value: number; standing: StandingKind }
  | { kind: 'UNRESOLVED'; reasons: Refusal[] };

export const resolved = (value: number, standing: StandingKind): Resolution =>
  ({ kind: 'VALUE', value, standing });
export const unresolved = (...reasons: Refusal[]): Resolution =>
  ({ kind: 'UNRESOLVED', reasons });

export interface Measure {
  id:         MeasureIdName;
  at:         Instant;
  scenarioId: string;
  resolution: Resolution;
  unit:       MeasureUnit;
  currency?:  string;
  label:      string;
  /** Measure ids and assumption ids this rests on. */
  dependsOn:  string[];
  /**
   * When the honest answer is a band rather than a point.
   *
   * ⚠️ FROM SCENARIOS, NEVER FROM FALLBACKS. A range produced by "we are not
   * sure" is a confidence interval this layer has no authority to state; a range
   * produced by evaluating two named scenarios is two answers to two questions.
   */
  range?:     { low: number; high: number; basis: string };
  /**
   * Volatility, carried rather than hidden.
   *
   * ⚠️ A PRODUCT FEATURE, NOT A DIAGNOSTIC. `spending-baseline.ts` records that
   * this user's discretionary spending has NO CURRENT REGIME: months from $2,290
   * to $14,061, a 6.1x spread. Carrying that to narration is what makes the
   * honest answer "your spending swings a lot month to month, so I'd give you a
   * range rather than a number" — which is neither a point estimate nor a
   * refusal. It is the guard against "stop refusing" degrading into "always
   * produce a point estimate."
   */
  dispersion?: { cv: number; min: number; max: number; sampleN: number };
}

/**
 * The default scenario: no deltas, recent patterns continuing.
 *
 * Slice 4 gives this an `AssumptionDelta[]`; Slice 3 needs only the id, so the
 * measure's shape does not change when scenarios arrive.
 */
export const BASE_SCENARIO_ID = 'BASE';

/**
 * How an investment position is carried into the future.
 *
 * ⚠️ DELIBERATELY POOR, AND FLAT-AS-BASE IS NOT A LIMITATION — IT IS THE HONEST
 * ANSWER. "Nobody knows where Bitcoin will be in December. If your portfolio
 * stays flat, around A. At +5%, around B." Three scenario evaluations, no
 * prediction, and cheap.
 *
 * ⚠️ THERE IS NO `DERIVED_FROM_HISTORY`, AND IT MUST NOT BE ADDED. There is no
 * trustworthy producer: crypto prices exist only from 2025-08-03 for BTC, ETH
 * prices are a rolling 365 days, and investment QUANTITIES are back-projected
 * where no event replay exists — `price-completeness.core.ts` says it plainly,
 * "a day whose prices are perfect and whose quantities are projected backwards
 * is not 'mostly observed'". A return derived from that series would be a
 * prediction wearing an authority's clothes.
 */
export type ReturnBasis =
  | { kind: 'FLAT' }
  | { kind: 'SCENARIO_BAND'; pct: number; statedAs: string };

export const FLAT: ReturnBasis = { kind: 'FLAT' };

/** The label a measure carries when nothing more specific is known. */
export const MEASURE_LABEL: Record<MeasureIdName, string> = {
  liquid_cash:              'liquid cash',
  investments_value:        'traditional investments',
  digital_assets_value:     'digital assets',
  real_assets_value:        'real assets',
  debt_balance:             'debt balance',
  net_worth:                'net worth',
  monthly_spending:         'monthly spending',
  monthly_income:           'monthly income',
  monthly_net:              'monthly net',
  runway_months:            'months of coverage',
  savings_rate:             'savings rate',
  concentration_top_weight: 'largest single holding, as a share',
};

export const MEASURE_UNIT: Record<MeasureIdName, MeasureUnit> = {
  liquid_cash:              FigureUnit.CURRENCY,
  investments_value:        FigureUnit.CURRENCY,
  digital_assets_value:     FigureUnit.CURRENCY,
  real_assets_value:        FigureUnit.CURRENCY,
  debt_balance:             FigureUnit.CURRENCY,
  net_worth:                FigureUnit.CURRENCY,
  monthly_spending:         FigureUnit.CURRENCY_PER_MONTH,
  monthly_income:           FigureUnit.CURRENCY_PER_MONTH,
  monthly_net:              FigureUnit.CURRENCY_PER_MONTH,
  runway_months:            FigureUnit.MONTHS,
  savings_rate:             FigureUnit.PERCENT,
  concentration_top_weight: FigureUnit.PERCENT,
};

/**
 * ⚠️ THE STANDING OF A COMPOSITION IS THE WEAKEST OF ITS LEGS. Anything else
 * lets a MEASURED leg lend its confidence to an ASSUMPTION_DEPENDENT one.
 */
const STANDING_ORDER: StandingKind[] = [
  Standing.MEASURED,
  Standing.OBSERVED_CONTINUATION,
  Standing.ASSUMPTION_DEPENDENT,
  Standing.HYPOTHETICAL,
];

export function weakestStanding(ss: readonly StandingKind[]): StandingKind {
  let worst = 0;
  for (const s of ss) worst = Math.max(worst, STANDING_ORDER.indexOf(s));
  return STANDING_ORDER[worst] ?? Standing.MEASURED;
}
