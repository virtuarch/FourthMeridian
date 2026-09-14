/**
 * lib/ai/conversation/scenario-checkpoints.ts
 *
 * WHICH DATES A SCENARIO TABLE HAS ROWS FOR — and what it says about the ones
 * it does not. PURE.
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR. Asked for a quarterly table, the model had
 * two ways to get one and neither was a table: a horizon past eighteen months
 * defaulted to YEARLY (four rows to 2029), and `quarterly` could not be asked
 * for. Asked for monthly detail over 102 months, the ledger kept the first 79
 * rows and the horizon and dropped 2033-06 through 2034-12 without a word — a
 * hole immediately before the answer. In one of two live runs the model filled
 * the hole with seven rows that did not exist, off by $1.4k–$8.6k and smoothed
 * toward the endpoint it did have. (docs/plans/AI-SCENARIO-LIQUID-FLOOR-
 * INVESTIGATION.md §1D, §12–13.)
 *
 * ⚠️ NOTHING HERE IS A FINANCIAL VALUE. This module chooses DATES. Every row a
 * table carries is still `projectCash(asOf → date)` composed by the ledger; a
 * date this module drops is a row that was never computed, never a row that was
 * computed and hidden. There is no sampling of values, no averaging, no
 * interpolation — and no such thing can be added here, because nothing here
 * sees a balance.
 *
 * ⚠️ THREE RULES, STATED ONCE:
 *   1. The horizon is always the last date. A table that stops short of the
 *      date the question named has not answered it.
 *   2. A default cadence is chosen so the table fits the ceiling: monthly while
 *      the horizon is within eighteen months, quarterly while the quarters fit
 *      (twenty years), yearly beyond.
 *   3. A cadence that does not fit is THINNED to the next coarser regular one —
 *      monthly to quarterly to yearly — and the result says what was asked,
 *      what was returned, and which dates fell out. Only yearly past the
 *      ceiling (an eighty-year horizon) is clamped to first rows + horizon, and
 *      then the contiguous range that fell out is named.
 */

import { monthEndsBetween } from './scenario-ledger';

/** A ceiling on how many independent projection runs one table can trigger. */
export const MAX_SCENARIO_CHECKPOINTS = 80;

/** Horizons up to this many days default to a monthly table: eighteen months. */
export const MONTHLY_DEFAULT_MAX_DAYS = 548;

export type Cadence = 'monthly' | 'quarterly' | 'yearly';

/** Finest first. Thinning walks this list to the right. */
export const CADENCES: readonly Cadence[] = ['monthly', 'quarterly', 'yearly'];

const MS_PER_DAY = 86_400_000;
const daysBetween = (fromISO: string, toISO: string) =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / MS_PER_DAY);

/**
 * Every 31 December strictly after `fromISO` and not after `toISO`, plus the
 * horizon itself. The yearly analogue of `monthEndsBetween`, and it keeps the
 * same property: the last entry IS the horizon.
 */
export function yearEndsBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const firstYear = Number(fromISO.slice(0, 4));
  const lastYear  = Number(toISO.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    const iso = `${y}-12-31`;
    if (iso > fromISO && iso <= toISO) out.push(iso);
  }
  if (out[out.length - 1] !== toISO && toISO > fromISO) out.push(toISO);
  return out;
}

/**
 * Every calendar quarter-end (31 Mar, 30 Jun, 30 Sep, 31 Dec) strictly after
 * `fromISO` and not after `toISO`, plus the horizon itself.
 *
 * ⚠️ DERIVED FROM THE MONTH-END GRID, NOT GENERATED BESIDE IT. A quarter-end is
 * a month-end whose month is a multiple of three; taking them off the one
 * month-end generator is what guarantees every quarterly row is a date the
 * monthly table would also have — a quarterly table is a selection of the
 * monthly one, never a second calendar.
 */
export function quarterEndsBetween(fromISO: string, toISO: string): string[] {
  return monthEndsBetween(fromISO, toISO)
    .filter((d, i, all) => i === all.length - 1 || Number(d.slice(5, 7)) % 3 === 0);
}

export function periodEndsBetween(cadence: Cadence, fromISO: string, toISO: string): string[] {
  return cadence === 'monthly' ? monthEndsBetween(fromISO, toISO)
    : cadence === 'quarterly' ? quarterEndsBetween(fromISO, toISO)
    : yearEndsBetween(fromISO, toISO);
}

/**
 * The cadence a table gets when nobody asked for one.
 *
 * ⚠️ CHOSEN SO THE TABLE FITS, NOT SO IT LOOKS TIDY. "Quarterly to twenty years"
 * is the consequence, not the rule: eighty quarter-ends is twenty years, and the
 * rule is "quarterly while the quarters fit the ceiling". A horizon a day past
 * that becomes yearly rather than a thinned quarterly, so a default never
 * arrives with an omission attached.
 */
export function defaultCadence(asOfISO: string, toISO: string): Cadence {
  if (daysBetween(asOfISO, toISO) <= MONTHLY_DEFAULT_MAX_DAYS) return 'monthly';
  if (quarterEndsBetween(asOfISO, toISO).length <= MAX_SCENARIO_CHECKPOINTS) return 'quarterly';
  return 'yearly';
}

export interface OmittedCheckpoints {
  /** Requested dates with no row in the result. */
  count: number;
  /** The first and last of them. */
  from:  string;
  to:    string;
  /** THINNED: every Nth regular date fell out. CLAMPED: one contiguous run before the horizon fell out. */
  how:   'THINNED' | 'CLAMPED';
}

export interface CheckpointPlan {
  /** The cadence of the rows actually returned. */
  cadence:   Cadence;
  /** Where that cadence came from. */
  source:    'REQUESTED' | 'DEFAULT' | 'THINNED';
  /** What the caller asked for, when they asked. */
  requested: Cadence | null;
  /** The dates, ascending, unique, ending at the horizon. */
  dates:     string[];
  /** Present whenever a requested date has no row. */
  omitted?:  OmittedCheckpoints;
  /** Present only on the last-resort clamp. */
  clampedTo?: number;
}

/**
 * Decide the dates a table will carry.
 *
 * ⚠️ DETERMINISTIC AND EXPLICIT. The same request always produces the same
 * dates, and a request that could not be honoured as stated says so in the
 * plan: `requested` beside `cadence`, and `omitted` naming what fell out. A
 * reader of the result can know, from the result alone, that a date they were
 * about to ask about is not there.
 */
export function planCheckpoints(args: {
  asOfISO: string; toISO: string; requested?: Cadence | null;
}): CheckpointPlan {
  const { asOfISO, toISO } = args;
  const requested = args.requested ?? null;
  const start: Cadence = requested ?? defaultCadence(asOfISO, toISO);
  const requestedDates = periodEndsBetween(start, asOfISO, toISO);

  let idx = CADENCES.indexOf(start);
  let dates = requestedDates;
  while (dates.length > MAX_SCENARIO_CHECKPOINTS && idx < CADENCES.length - 1) {
    idx++;
    dates = periodEndsBetween(CADENCES[idx], asOfISO, toISO);
  }
  const cadence = CADENCES[idx];

  if (dates.length > MAX_SCENARIO_CHECKPOINTS) {
    // ⚠️ THE LAST RESORT, AND IT NAMES THE HOLE. Yearly past the ceiling is an
    // eighty-year horizon; keep the first rows and the horizon, and say exactly
    // which run of years has no row.
    const kept = [...dates.slice(0, MAX_SCENARIO_CHECKPOINTS - 1), toISO];
    const dropped = dates.slice(MAX_SCENARIO_CHECKPOINTS - 1, -1);
    return { cadence, source: requested ? 'REQUESTED' : 'DEFAULT', requested, dates: kept,
      clampedTo: MAX_SCENARIO_CHECKPOINTS,
      omitted: { count: dropped.length, from: dropped[0], to: dropped[dropped.length - 1], how: 'CLAMPED' } };
  }

  if (cadence !== start) {
    const kept = new Set(dates);
    const dropped = requestedDates.filter((d) => !kept.has(d));
    return { cadence, source: 'THINNED', requested, dates,
      omitted: { count: dropped.length, from: dropped[0], to: dropped[dropped.length - 1], how: 'THINNED' } };
  }
  return { cadence, source: requested ? 'REQUESTED' : 'DEFAULT', requested, dates };
}

/** How many settled movements a result lists in full. */
export const MOVEMENTS_SHOWN = 12;

export interface CompactMovements<M extends { kind: 'CONTRIBUTION' | 'OUTFLOW'; amount: number }> {
  count:         number;
  contributions: { count: number; total: number };
  outflows:      { count: number; total: number };
  /** The first `MOVEMENTS_SHOWN`, in the order they were applied. */
  first:         M[];
  /** True when `first` is not all of them. */
  compacted:     boolean;
  note?:         string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The settled movements, bounded.
 *
 * ⚠️ EVIDENCE COMPACTION, NOT CALCULATION COMPACTION. A thirty-year surplus or
 * floor rule settles 361 dated amounts, and the result was repeating every one
 * of them beside a table whose rows already carry the same money as
 * `sincePreviousCheckpoint` and `contributionsToDate`. The totals here are
 * summed off the same settled list the ledger applied — nothing is re-derived —
 * and the first dozen stay verbatim so a reader can see what the rule came to.
 */
export function compactMovements<M extends { kind: 'CONTRIBUTION' | 'OUTFLOW'; amount: number }>(
  movements: readonly M[],
): CompactMovements<M> {
  const sum = (k: M['kind']) => movements.filter((m) => m.kind === k);
  const contributions = sum('CONTRIBUTION');
  const outflows = sum('OUTFLOW');
  const compacted = movements.length > MOVEMENTS_SHOWN;
  return {
    count: movements.length,
    contributions: { count: contributions.length,
      total: round2(contributions.reduce((s, m) => s + m.amount, 0)) },
    outflows: { count: outflows.length, total: round2(outflows.reduce((s, m) => s + m.amount, 0)) },
    first: movements.slice(0, MOVEMENTS_SHOWN),
    compacted,
    ...(compacted ? { note: `The first ${MOVEMENTS_SHOWN} of ${movements.length} settled movements. `
      + 'Every one is already applied: each checkpoint carries the amounts moved since the '
      + 'previous checkpoint and the totals to date.' } : {}),
  };
}
