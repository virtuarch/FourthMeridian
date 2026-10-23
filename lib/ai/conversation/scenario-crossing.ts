/**
 * lib/ai/conversation/scenario-crossing.ts
 *
 * WHEN A SCENARIO FIRST REACHES A NUMBER. PURE.
 *
 * ⚠️ A SEARCH OVER THE LEDGER'S OUTPUT, NOT A SECOND PROJECTION. Every value it
 * reads was computed by `runScenarioLedger` from the one cash spine; this adds no
 * arithmetic about money at all, only about order. The projection stays the
 * authority on what the path is; this says where on it a line is first crossed.
 *
 * ⚠️ IT LIVES BESIDE THE LEDGER RATHER THAN INSIDE IT because the ledger imports
 * nothing — "it is arithmetic, and importable anywhere", asserted twice — and a
 * threshold comparison needs the repository's money tolerance. Putting the
 * search here keeps that property intact and keeps ONE definition of when two
 * amounts are the same amount of money.
 *
 * ⚠️ AND IT SHARES THAT DEFINITION WITH THE PAST. `MONEY_EPSILON` is what stops a
 * debt of 2.842e-14 counting as a debt when the history is searched; a scenario
 * using a different rule would answer "when will my debt be gone" differently
 * from "when WAS my debt gone", over identical arithmetic.
 */

import { MONEY_EPSILON } from '@/lib/data/snapshot-window';
import { addMonths, type LedgerCheckpoint, type LedgerOpening } from './scenario-ledger';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The lines a checkpoint carries. Nothing derived, nothing invented. */
export type LedgerMetric = 'netWorth' | 'liquid' | 'investments' | 'debt' | 'otherAssets';

export type CrossingDirection = 'at_or_above' | 'at_or_below';

/** One line of a checkpoint, or null when the projection refused that date. */
export function metricAt(c: LedgerCheckpoint, metric: LedgerMetric): number | null {
  const line = metric === 'netWorth' ? c.netWorth : metric === 'liquid' ? c.liquid
    : metric === 'investments' ? c.investments : metric === 'debt' ? c.debt : c.otherAssets;
  return line?.amount ?? null;
}

/** The same line on the opening position. */
export function openingMetric(
  opening: LedgerOpening & { netWorth: number }, metric: LedgerMetric,
): number {
  return metric === 'netWorth' ? opening.netWorth : metric === 'liquid' ? opening.liquid
    : metric === 'investments' ? opening.investments : metric === 'debt' ? opening.debt
    : opening.otherAssets;
}

/**
 * Does a value meet the threshold, at currency precision?
 *
 * ⚠️ ONE TOLERANCE, SHARED WITH THE PAST. `MONEY_EPSILON` is what keeps a debt of
 * 2.842e-14 from counting as a debt when the history is searched; a scenario that
 * used a different rule would answer "when is my debt gone" differently from
 * "when WAS my debt gone", over the same arithmetic.
 */
export const satisfiesThreshold = (
  value: number, threshold: number, direction: CrossingDirection,
): boolean => (direction === 'at_or_above'
  ? value > threshold - MONEY_EPSILON
  : value < threshold + MONEY_EPSILON);

export interface ScenarioCrossing {
  /** The first checkpoint that satisfies the condition, and the one before it. */
  crossing: { checkpoint: LedgerCheckpoint; value: number;
    previous: { date: string; value: number } | null } | null;
  /** Set when the opening position already satisfied it. Never both. */
  alreadySatisfied: { date: string; value: number } | null;
  /** The last checkpoint that could be evaluated, for a search that found nothing. */
  end: { checkpoint: LedgerCheckpoint; value: number } | null;
  /** How many checkpoints carried a usable value. */
  examined: number;
}

/**
 * The FIRST checkpoint at which a scenario line crosses a threshold. PURE.
 *
 * ⚠️ AN ORDERED WALK, NOT A BISECTION, AND THE REASON IS THAT PATHS TURN. A
 * bisection answers "is it above at the end", which is a different question: a
 * one-off outflow, a negative return or a month that falls can take a line back
 * down, and a search that assumed the path only rises would report the second
 * crossing as the first — or, worse, miss a crossing entirely between two points
 * that both sit below. Walking every checkpoint in order is O(n) over a list the
 * ledger has already computed, and it is right whatever shape the path has.
 *
 * ⚠️ ALREADY TRUE IS NOT A CROSSING. A position that satisfies the condition on
 * day one has no future date, and inventing one is exactly the confusion the goal
 * seek's `alreadyMet` produced in prose.
 *
 * ⚠️ AN UNESTABLISHED CHECKPOINT IS SKIPPED, NEVER READ AS ZERO — and the
 * neighbour it leaves behind is the previous ESTABLISHED one, so "the month
 * before" is always a month that was actually measured.
 */
export function findScenarioCrossing(args: {
  checkpoints: readonly LedgerCheckpoint[];
  opening:     LedgerOpening & { netWorth: number };
  metric:      LedgerMetric;
  direction:   CrossingDirection;
  threshold:   number;
}): ScenarioCrossing {
  const { checkpoints, opening, metric, direction, threshold } = args;
  const usable = checkpoints
    .map((c) => ({ c, value: metricAt(c, metric) }))
    .filter((x): x is { c: LedgerCheckpoint; value: number } => x.value !== null);
  const end = usable.length > 0
    ? { checkpoint: usable[usable.length - 1].c, value: usable[usable.length - 1].value } : null;

  const openingValue = openingMetric(opening, metric);
  if (satisfiesThreshold(openingValue, threshold, direction)) {
    return { crossing: null, end, examined: usable.length,
      alreadySatisfied: { date: opening.asOfISO, value: round2(openingValue) } };
  }

  for (const [i, x] of usable.entries()) {
    if (!satisfiesThreshold(x.value, threshold, direction)) continue;
    const before = i > 0 ? usable[i - 1] : null;
    return {
      crossing: { checkpoint: x.c, value: x.value,
        previous: before ? { date: before.c.date, value: before.value } : null },
      alreadySatisfied: null, end, examined: usable.length,
    };
  }
  return { crossing: null, alreadySatisfied: null, end, examined: usable.length };
}


// ── Elapsed time ─────────────────────────────────────────────────────────────

/**
 * The calendar distance between two dates. PURE, and no clock.
 *
 * ⚠️ THE ENGINE HAD THE DATE AND THE MODEL DID THE SUBTRACTION. A crossing found
 * at 2027-02-28 from 2026-09-13 was narrated as "1.5 years from now"; the gap is
 * five months and fifteen days. The ledger owns every figure in a scenario, and
 * the distance to a date it produced is a figure. This says it once, in numbers,
 * beside the date.
 *
 * ⚠️ CALENDAR MONTHS FIRST, THEN DAYS, with the repository's own month step.
 * `addMonths` clamps into the target month (the 31st steps to the 28th), so
 * 31 January to 28 February is one month and no days — the reading a person
 * gives it. The fractional forms use the mean month and year (365.25 / 12) so
 * "about five and a half months" is the same number whichever month it spans.
 *
 * A distance, not a direction: the two dates may be given either way round.
 */
export interface Elapsed {
  /** Whole calendar months, then the days left over. */
  months: number;
  days:   number;
  /** The whole span in days. */
  totalDays: number;
  /** The span as months and as years, to one and two places, for "about" phrasing. */
  monthsFractional: number;
  years: number;
  /** "5 months, 15 days" — a label, not a sentence. */
  label: string;
}

const DAY_MS = 86_400_000;
const MEAN_MONTH_DAYS = 365.25 / 12;
const dayCount = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export function elapsedBetween(fromISO: string, toISO: string): Elapsed {
  const [a, b] = fromISO <= toISO ? [fromISO, toISO] : [toISO, fromISO];
  const totalDays = dayCount(a, b);
  // The most whole months that do not overshoot; a linear scan is fine for any
  // span a scenario can name, and it uses the ledger's own month arithmetic.
  let months = Math.floor(totalDays / 31);
  while (addMonths(a, months + 1) <= b) months++;
  const days = dayCount(addMonths(a, months), b);
  const monthsFractional = Math.round((totalDays / MEAN_MONTH_DAYS) * 10) / 10;
  const years = Math.round((totalDays / 365.25) * 100) / 100;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const label = totalDays === 0 ? 'today'
    : [months > 0 ? part(months, 'month') : '', days > 0 ? part(days, 'day') : '']
      .filter(Boolean).join(', ');
  return { months, days, totalDays, monthsFractional, years, label };
}
