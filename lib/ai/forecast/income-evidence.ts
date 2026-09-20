/**
 * lib/ai/forecast/income-evidence.ts   (M1 — measures & comparison)
 *
 * WHAT A RECURRING INCOME STREAM IS WORTH PER MONTH — the sanctioned adapter
 * between the cadence authority (`lib/forecast/cadence`) and the measures layer.
 *
 * ⚠️ THE MEASURES NEVER IMPORT THE FORECAST AUTHORITIES. FORECAST-1 is consumed
 * only under `lib/forecast/` and `lib/ai/forecast/` (a test enforces it), so the
 * one piece of cadence arithmetic the income baseline needs — occurrences per
 * year ÷ 12, biweekly = 26 not 24 — is applied HERE, by the authority's own
 * `monthlyEquivalent`, and handed over as evidence. The measures layer adds the
 * streams up; it never learns how a cadence converts.
 *
 * Pure. Full precision: rounding is the consumer's, once, at the edge.
 */

import { isCadence, monthlyEquivalent, type CadenceKindName, type CadenceResult } from '@/lib/forecast/cadence';
import { WINDOW_MONTHS } from '@/lib/forecast/observed-spending';

/**
 * How many of the most recent complete months the cash projection averages —
 * the forecast authority's own constant, re-exported so a default MEASURED
 * window elsewhere is the projection's window by reference, not by coincidence.
 */
export const OBSERVED_SPENDING_WINDOW_MONTHS = WINDOW_MONTHS;

export interface IncomeStreamMonthlyEvidence {
  label?: string;
  /** The cadence kind, or null when the schedule is not established. */
  cadence: CadenceKindName | null;
  /** Per-occurrence settled amount, when assertable. */
  typicalAmount: number | null;
  /** `typicalAmount` at its cadence, per month, unrounded. Null when either is unknown. */
  monthlyEquivalent: number | null;
  /** The stream may still generate expected occurrences. */
  stillPaying: boolean;
}

/** One stream as monthly evidence. The minimal shape, so a fixture can build one. */
export function incomeStreamEvidence(s: {
  label?: string;
  cadence: CadenceResult | CadenceKindName | null;
  typicalAmount: number | null;
  stillPaying: boolean;
}): IncomeStreamMonthlyEvidence {
  const kind: CadenceKindName | null = s.cadence === null ? null
    : typeof s.cadence === 'string' ? s.cadence
    : isCadence(s.cadence) ? s.cadence.kind : null;
  const amount = typeof s.typicalAmount === 'number' && Number.isFinite(s.typicalAmount) ? s.typicalAmount : null;
  return {
    ...(s.label ? { label: s.label } : {}),
    cadence: kind, typicalAmount: amount,
    monthlyEquivalent: kind !== null && amount !== null ? monthlyEquivalent(amount, kind) : null,
    stillPaying: s.stillPaying,
  };
}
