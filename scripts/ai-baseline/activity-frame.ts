/**
 * scripts/ai-baseline/activity-frame.ts
 *
 * THE SECOND MEASURED FINANCIAL FRAME — `activity`, trailing six months.
 *
 * ⚠️ A FRAME IS A WINDOW *PLUS THE FIGURES MEASURED OVER IT*. That is the whole
 * finding this module exists to honour. Six experiments (bb2f6ec, 55a2c22,
 * 70ac794, a774989, d34330b, 0c0a84b) established that gpt-5.1 binds its
 * date-bearing tool arguments to a measured financial frame and to nothing else:
 * an adjacent date range framing no figures attracted 0/12 calls, corpus
 * coverage in the tool result 0/27, and an `activityAvailable` range placed
 * INSIDE `recent` 0/11 — while a second window carrying its own five figures was
 * bound 15/15 across three tools. Do not "simplify" this into a date range.
 *
 * ⚠️ IT COMPLEMENTS `recent`; IT DOES NOT REPLACE IT. `recent` stays the fixed
 * 90-day W4 assessment window that `computeAssessment` is calibrated to, with
 * its figures untouched. Nothing here may widen it — a9e6a6f §4.1 records what
 * happens when the assessment window moves: a 30-day window graded
 * `deficitCause` NOT_APPLICABLE against a deficit under 90.
 *
 * ⚠️ SIX MONTHS IS A CALENDAR PERIOD, NOT 180 DAYS. The start comes from
 * `compareToForPreset('PAST_6_MONTHS', …)` — the repository's one preset parser,
 * whose `subMonths` clamps month ends (Aug 31 → Feb 28/29). The inclusive span
 * it produces varies 182–185 days through a year, and that variation is the
 * calendar being correct, not an approximation to fix. A second parser here
 * would fail `lib/perspectives/financial-window.test.ts`.
 *
 * ⚠️ `2 × ASSESSMENT_WINDOW_DAYS` IS THE EXISTENCE THRESHOLD ONLY. It is not a
 * definition of six months and never bounds the window. Below it the frame
 * collapses into `recent` — measured: under 90 days of history every candidate
 * period returns the identical rows — so the key is OMITTED. Not null, not an
 * empty object: absence is the single-frame control that 9ba7c3f proved safe
 * over 25 trials, whereas a null frame is a semantic state the model has never
 * been tested against.
 */

import { compareToForPreset } from '@/lib/perspectives/time-range';
import type { TransactionsSummaryData } from '@/lib/ai/types';

/** The period policy, decided in a9e6a6f. Not a tuning knob. */
export const ACTIVITY_PRESET = 'PAST_6_MONTHS' as const;

/** Whole UTC days between two YYYY-MM-DD dates, inclusive of both ends. */
function inclusiveDays(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00.000Z`) - Date.parse(`${fromIso}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
}

export interface ActivityWindow { from: string; to: string; days: number }

/**
 * The window the frame would occupy, or `null` when the frame must not exist.
 *
 * Resolved BEFORE any assembly so a frame that will not be emitted costs no
 * query at all — the caller runs exactly one extra TRANSACTIONS_SUMMARY, and
 * only when there is a frame to measure.
 *
 * ⚠️ RETROSPECTIVE AUTHORITY. Both ends derive from `asOf`: the start from the
 * preset applied to `asOf`, the end from `asOf` itself, and `coverageFrom` must
 * be the corpus bound taken UNDER `asOf` (`transactionCorpusSpan({spaceId,
 * asOf})`, 55a2c22). Nothing dated after `asOf` can reach the window, and —
 * because existence is decided from these same two values — nothing after `asOf`
 * can leak through the frame's mere presence either.
 */
export function resolveActivityWindow(args: {
  asOf: string;
  /** Earliest transaction visible at or before `asOf`, or null when none is. */
  coverageFrom: string | null;
  /** The assessment window's own day count — read from `recent`, never re-declared. */
  assessmentWindowDays: number;
}): ActivityWindow | null {
  const { asOf, coverageFrom, assessmentWindowDays } = args;
  if (!coverageFrom) return null;

  const preset = compareToForPreset(ACTIVITY_PRESET, asOf, coverageFrom);
  if (!preset) return null;

  // Never claim a period earlier than the record: a frame that stated figures
  // for months it could not have measured would be the defect this whole series
  // closed. `compareToForPreset('ALL', …)` carries the same doctrine.
  const from = preset < coverageFrom ? coverageFrom : preset;
  if (from > asOf) return null;

  const days = inclusiveDays(from, asOf);
  if (days < 2 * assessmentWindowDays) return null;

  return { from, to: asOf, days };
}

export interface ActivityFrame {
  window: ActivityWindow;
  income: number;
  spending: number;
  cardAndDebtPayments: number;
  netCashFlow: number;
  transactionCount: number;
}

/**
 * Project an assembled summary into the frame's closed field set.
 *
 * ⚠️ EVERY FIGURE IS THE ASSEMBLER'S OWN. Nothing is added, divided, or
 * normalised here — the one-to-one mapping is the point, and it is what makes
 * `activity` the same KIND of object as `recent` rather than a lookalike.
 *
 * ⚠️ THE FIELD SET IS CLOSED. No categories, merchants, monthly series, coverage
 * note or prose: 0c0a84b and 9ba7c3f measured this exact shape, and anything
 * added here is unmeasured. The window reported is the one the assembler
 * actually SERVED, not the one requested — they differ only if a clamp fires,
 * and a frame must never state a period it did not measure.
 */
export function projectActivityFrame(summary: TransactionsSummaryData): ActivityFrame | null {
  if (!summary?.startDate || !summary.endDate) return null;
  return {
    window: { from: summary.startDate, to: summary.endDate, days: summary.windowDays },
    income: summary.incomeTotal,
    spending: summary.expenseTotal,
    // Named as `recent` names it, for the same reason: on a Space where cards
    // are paid in full these are transfers to a card, not new spending.
    cardAndDebtPayments: summary.debtPaymentTotal,
    netCashFlow: summary.netCashFlow,
    transactionCount: summary.transactionCount,
  };
}
