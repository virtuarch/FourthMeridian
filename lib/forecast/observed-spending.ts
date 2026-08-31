/**
 * lib/forecast/observed-spending.ts
 *
 * PROJECTION-1 — WHAT SPENDING HAS ACTUALLY BEEN, OVER A NAMED WINDOW.
 *
 * ── This is NOT FORECAST-6, and the difference is the whole point ───────────
 * F6 asks "what does this user's ordinary spending LOOK LIKE NOW" and answers
 * UNKNOWN for this user, on evidence: calendar months range 6.1x, 28-day windows
 * 8.3x, 7-day windows 15.1x. No level repeats, so no level is "normal". That
 * verdict is untouched here and must never be restated as a rate.
 *
 * This module asks a strictly weaker question with a strictly weaker answer:
 * over the last N complete months, what did spending AVERAGE? That is a
 * description of a window, true by construction, and it licenses nothing about
 * the future on its own — a projection built from it carries
 * `OBSERVED_CONTINUATION`, which is the assumption the user can reject.
 *
 * ⚠️ THE WINDOW IS PART OF THE ANSWER, because on real data it IS the answer.
 * Measured on the live Space: 2 complete months give $4,156.68/mo, 3 give
 * $8,349.66, 13 give $6,567.02. A rate quoted without its window is not a
 * weaker claim than a forecast — it is an unfalsifiable one.
 *
 * ⚠️ AND THE WINDOW IS FIXED, NOT CHOSEN. `WINDOW_MONTHS` is a constant and the
 * selection is always "the most recent complete months, up to that many". There
 * is deliberately no path that compares candidate windows — picking the one with
 * the tightest dispersion, or the friendliest number, would make the disclosure
 * a decoration on a decision already taken.
 *
 * ── Why it reads the canonical breakdown rather than the ledger ─────────────
 * `monthlyBreakdown` + `reliableMonths` is the population the assessment and the
 * prompt already share, and KD-10 records that a competing spending figure was
 * removed once before. A second, wider read would reintroduce exactly that. So
 * this takes the same complete months everything else uses — which also means
 * DEBT_PAYMENT is already excluded, verified against the ledger: Jul+Aug 2026
 * `expenseTotal` averages $4,156.68, and SPENDING+FEE over those months is
 * $2,290.03 + $6,023.33, the same figure to the cent.
 */

import { AssumptionOrigin, type AssumptionOriginKind } from './policy';

/**
 * The canonical projection lookback.
 *
 * Three complete calendar months: long enough to span more than one pay cycle
 * and one billing cycle, short enough to describe the current regime rather than
 * an average of regimes. Fewer are used when fewer exist, and the count is always
 * disclosed; more are never used, so a longer history cannot quietly smooth an
 * unstable recent period into a comfortable number.
 */
export const WINDOW_MONTHS = 3;

/** One complete month, as the shared breakdown already holds it. */
export interface CompleteMonth {
  /** `YYYY-MM`. */
  month: string;
  /** The month's expense total, in the reporting currency. */
  expenseTotal: number;
}

/** `2026-07` → `July 2026`, so a reply cannot paraphrase the window loosely. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const idx = Number(m) - 1;
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

export interface ObservedSpendingRate {
  assertable: true;
  /** The mean of `values`, full precision. Rounded only at the display edge. */
  monthlyRate: number;
  /** Equivalent daily accrual, for a horizon that is not a whole month. */
  dailyRate: number;
  /** The months averaged, oldest first — the window, stated. */
  months: string[];
  values: number[];
  monthCount: number;
  /**
   * max/min across the window. NOT a confidence interval and not a forecast
   * band: a plain statement of how much the averaged months differed from each
   * other, so a mid-point drawn from $14,060.81 and $2,290.03 cannot be read as
   * a settled level. Null when a single month was averaged.
   */
  dispersionRatio: number | null;
  low: number;
  high: number;
  origin: AssumptionOriginKind;
}

export interface UnavailableSpendingRate {
  assertable: false;
  reason: string;
}

export type ObservedSpendingResult = ObservedSpendingRate | UnavailableSpendingRate;

/** Days in an average month — the same constant the engine accrues by. */
const DAYS_PER_MONTH = 365 / 12;

/**
 * Average the most recent complete months, and say which ones.
 *
 * PURE. No clock, no DB. `months` must already be the reliable set, oldest
 * first, exactly as `reliableMonths` returns it.
 */
export function deriveObservedSpendingRate(
  months: readonly CompleteMonth[],
  windowMonths: number = WINDOW_MONTHS,
): ObservedSpendingResult {
  const usable = months.filter((m) => Number.isFinite(m.expenseTotal) && m.expenseTotal >= 0);
  if (usable.length === 0) {
    return {
      assertable: false,
      reason: 'no complete calendar month of spending is available to average',
    };
  }
  // ⚠️ ALWAYS THE MOST RECENT. Never the most stable, never the longest run that
  // happens to look level.
  const window = usable.slice(-Math.max(1, windowMonths));
  const values = window.map((m) => m.expenseTotal);
  const monthlyRate = values.reduce((t, v) => t + v, 0) / values.length;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return {
    assertable: true,
    monthlyRate,
    dailyRate: monthlyRate / DAYS_PER_MONTH,
    months: window.map((m) => m.month),
    values,
    monthCount: values.length,
    dispersionRatio: values.length > 1 && low > 0 ? high / low : null,
    low,
    high,
    origin: AssumptionOrigin.OBSERVED_CONTINUATION,
  };
}

/**
 * The window, in the words a reply may reuse.
 *
 * ⚠️ NEVER THE WORD "NORMAL". F6 owns that word and withheld it for this user;
 * a projection input that borrowed it would assert precisely the thing F6
 * measured to be false.
 */
export function describeObservedSpending(r: ObservedSpendingRate): string {
  const span = r.monthCount === 1
    ? r.months[0]
    : `${r.months[0]} – ${r.months[r.months.length - 1]}`;
  return `spending averaged ${r.monthlyRate.toFixed(2)} per month across the `
    + `${r.monthCount} complete month(s) ${span}`;
}
