/**
 * lib/data/snapshot-window.ts
 *
 * THE canonical windowed change over a snapshot series — extracted from
 * lib/data/snapshots.ts, body unchanged, so it can be imported without that
 * module's import graph.
 *
 * ── Why it moved (v2.6-WINDOW-1) ────────────────────────────────────────────
 *
 * `lib/data/snapshots.ts` reaches `@/lib/space` → `@/lib/auth` → `server-only`,
 * which only Next resolves. So this function — pure arithmetic over dates and
 * numbers, no `db`, no clock — could not be reached by a read-only audit, and
 * could not be reached by the AI context layer either.
 *
 * That unreachability had a cost. The Daily Brief needed a net-worth change over
 * a defined window, could not import the one that existed, and derived its own
 * from a ROW COUNT: `snapshotCount`, which `getRecentSnapshots` produces via
 * `take: -days`. It rendered that as "over the last 90 days". On the live corpus
 * the 90th row was 89 days back (2026-05-10) while the canonical quarter opens
 * at `subMonths(asOf, 3)` (2026-05-07) — and a $4,985 debt paydown falls between
 * the two. The Brief said "up 14.9% over the last 90 days"; the Space, for the
 * same words on the same day, said 47.4%.
 *
 * This is the same lesson as `lib/data/banking-population.ts`, which was
 * extracted for exactly this reason: **a caller that cannot reach the authority
 * writes its own.** An unexported, unreachable authority does not prevent
 * duplication — it guarantees it.
 *
 * `lib/data/snapshots.ts` re-exports this symbol, so no existing consumer moved.
 */

import { compareToForPreset, type TimePreset } from "@/lib/perspectives/time-range";

/** One point on a snapshot series: a date and the value being tracked. */
export interface SeriesPoint {
  date:  Date;
  value: number;
}

/** A change measured across a window the product DEFINES. */
export interface CanonicalWindowChange {
  /** YYYY-MM-DD — the window's opening point (the resolved compare-to). */
  fromDate:  string;
  /** YYYY-MM-DD — the window's closing point (asOf). */
  toDate:    string;
  fromValue: number;
  toValue:   number;
  /** (to − from) / |from| × 100. Null when `from` is 0. */
  pct:       number | null;
  abs:       number;
  /**
   * The preset this window represents.
   *
   * The field exists so a surface RENDERS the window it was given rather than
   * assuming which one it received — the assumption that let one screen print
   * "90 days" over a window that was neither 90 days nor a quarter.
   */
  preset:    TimePreset;
}

/**
 * v2.6-L4F — THE canonical windowed change over a snapshot series.
 *
 * The window comes from `compareToForPreset(preset, asOf)` — the SAME authority
 * the inside-Space time selector uses — so "one month" means one CALENDAR month
 * here exactly as it does there. It is deliberately NOT a 30-day approximation:
 * `PAST_MONTH` is `subMonths(asOf, 1)`, and a surface that labelled this
 * "30 days" would be mislabelling a calendar-month figure.
 *
 * The opening point is the last snapshot AT OR BEFORE the compare-to date (the
 * same as-of-or-earlier rule a point-in-time read uses), so a Space without a
 * snapshot exactly on that date still gets an honest window rather than none.
 *
 * ⚠️ Returns null when the series does not reach back to the window's opening
 * date. A REFUSAL, never a fallback to the earliest point available: comparing
 * against "the oldest row we happen to hold" is precisely the accidental window
 * this function exists to replace.
 */
export function canonicalWindowChange(
  points: SeriesPoint[],
  preset: TimePreset = "PAST_MONTH",
  options: PctOptions = {},
): CanonicalWindowChange | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const toDate = last.date.toISOString().slice(0, 10);
  const fromDate = compareToForPreset(preset, toDate, null);
  if (fromDate == null) return null;

  let opening: SeriesPoint | null = null;
  for (const p of points) {
    if (p.date.toISOString().slice(0, 10) <= fromDate) opening = p;
  }
  // No point at or before the window's start: the Space's history does not
  // reach back a month, so there is no month to compare. Refuse rather than
  // silently comparing against the earliest point available.
  if (opening === null) return null;

  const abs = last.value - opening.value;
  return {
    fromDate,
    toDate,
    fromValue: opening.value,
    toValue:   last.value,
    pct:       pctOfOpening(abs, opening.value, options),
    abs,
    preset,
  };
}

/**
 * A change measured between two observations the CALLER already holds, as
 * distinct from one the product defines.
 *
 * ⚠️ THIS EXISTS SO SUBTRACTION HAS AN OWNER. `canonicalWindowChange` above
 * resolves its own opening point from a preset; an arbitrary "between these two
 * dates" comparison has no preset to resolve, and the two figures were being
 * subtracted by whoever happened to need the answer. Measured (58b352f, twice):
 * an AI tool named for change returned a COMPOSITION instead, and the model read
 * a savings BALANCE of $12,345.80 as "a big chunk" of an $11,242.40 rise. A
 * level is not a contribution to a change, and the way to stop that confusion is
 * for the change to be a computed thing with a name.
 *
 * ⚠️ IT REPORTS THE OBSERVATIONS IT ACTUALLY USED. Snapshots are not guaranteed
 * daily or contiguous, so the effective dates are rarely the requested ones and
 * a comparison that hides which rows it compared is a comparison nobody can
 * check.
 *
 * ⚠️ IT MEASURES AND DOES NOT INTERPRET. `abs` is `to − from` for whatever metric
 * was passed. It is not a contribution, not a gain, not a cause: investments
 * rising does not mean the market rose, cash rising does not mean income arrived,
 * and debt falling is a debt fact whose effect on net worth is the reader's to
 * state. Naming any of those here would be the causal engine this is not.
 */
export interface ObservedChange {
  /** The date of the observation actually used as the opening. */
  fromDate:  string;
  /** The date of the observation actually used as the closing. */
  toDate:    string;
  fromValue: number;
  toValue:   number;
  /** to − from, in the metric's own direction. Never re-signed. */
  abs:       number;
  /** (to − from) / |from| × 100. Null when `from` is 0 — never Infinity. */
  pct:       number | null;
}

export function observedChange(
  from: SeriesPoint | null | undefined,
  to:   SeriesPoint | null | undefined,
  options: PctOptions = {},
): ObservedChange | null {
  if (!from || !to) return null;
  if (!Number.isFinite(from.value) || !Number.isFinite(to.value)) return null;
  const fromDate = from.date.toISOString().slice(0, 10);
  const toDate   = to.date.toISOString().slice(0, 10);
  // One observation is not a change. Refusing is the honest answer — a zero would
  // read as "nothing moved", which is a measurement nobody made.
  if (fromDate === toDate) return null;
  const abs = to.value - from.value;
  return {
    fromDate, toDate,
    fromValue: from.value, toValue: to.value,
    abs,
    pct: pctOfOpening(abs, from.value, options),
  };
}

/**
 * WHEN A PERCENTAGE OF THE OPENING VALUE MEANS SOMETHING — decided here, once,
 * for every stock change this module computes.
 *
 * ⚠️ NO BASE, NO PERCENTAGE. An opening under half a cent is not a base: it is
 * float residue on a settled balance (this Space's debt series holds
 * `2.842170943040401e-14` on a day the debt was paid off), and dividing by it
 * yields a twelve-digit percentage of nothing. The guard was `=== 0`, which that
 * value is not. `MONEY_EPSILON` is the same rule M1's comparison contract uses
 * for the same question (lib/ai/measures/measure.ts `compare`), so a stock change
 * and a flow comparison now refuse a percentage at the same point.
 *
 * ⚠️ A BASE SMALLER THAN THE MOVEMENT (opt-in: `baseMustCoverChange`). Measured:
 * a card carrying about ten dollars took a four-figure week of charges, and the
 * Daily Brief package shipped a five-digit `debt.pct`. The arithmetic is right and the figure
 * says nothing about the change — it measures how small the opening happened to
 * be. When |opening| < |change| the ratio describes the BASE, not the movement,
 * so a narrating consumer asks for it to be withheld and states the two values
 * instead. No constant: the rule compares the movement with its own opening, so
 * it scales with every Space and every metric. It can only fire on a rise of
 * more than 100% or a sign crossing; a fall toward zero keeps its percentage.
 * Opt-in because existing consumers (the product's change chips, the chat tools)
 * already show their opening value beside the percentage.
 */
export interface PctOptions {
  /** Withhold the percentage when the opening value is smaller than the change itself. */
  baseMustCoverChange?: boolean;
}

export function pctOfOpening(abs: number, opening: number, options: PctOptions = {}): number | null {
  const base = Math.abs(opening);
  if (!Number.isFinite(abs) || !Number.isFinite(base) || base < MONEY_EPSILON) return null;
  if (options.baseMustCoverChange && base < Math.abs(abs)) return null;
  return (abs / base) * 100;
}

/**
 * Half a cent, in the reporting currency.
 *
 * ⚠️ A COMPARISON RULE, NOT A ROUNDING RULE. Nothing here rewrites a stored
 * value: the series keeps whatever the snapshot recorded, and a caller that
 * prints a figure prints the real one. This only decides when two amounts are
 * THE SAME AMOUNT OF MONEY, because a sum of floats does not land where the
 * money does — this Space's own debt series holds `2.842170943040401e-14` on a
 * day the debt was paid off, and `32575.96000000001` on a day it was not. A
 * predicate that asked `value <= 0` would answer "no" for a debt of nothing.
 *
 * Half a cent is the width of the smallest difference that can be WRITTEN in a
 * currency with two decimal places, so anything narrower is representation, not
 * money.
 */
export const MONEY_EPSILON = 0.005;

/** Same amount of money, whatever the float says. */
export const sameMoney = (a: number, b: number): boolean => Math.abs(a - b) < MONEY_EPSILON;

/**
 * The exact temporal questions a series can answer.
 *
 * ⚠️ THESE ARE PREDICATES, AND CODE OWNS THEM. "First", "last", "highest",
 * "lowest" and "when did it cross" are arithmetic over an ordered series; asking
 * a reader to scan two hundred rows for them is asking for an error, and it got
 * one — the assistant named a day as the first zero-debt day whose debt, in the
 * same payload, was $5,353.81.
 */
export type TemporalOperation =
  | 'minimum' | 'maximum'
  | 'first_below' | 'first_above'
  | 'last_below'  | 'last_above';

/**
 * ⚠️ `below` AND `above` ARE INCLUSIVE, and the short names are measured, not
 * taste. The first vocabulary read `first_at_or_below`; in six live calls the
 * model assembled `first_at_or_at_or_below` twice — a repeated segment is a
 * segment that gets repeated. A name that cannot be mis-composed costs a round
 * trip less, and the inclusiveness is stated everywhere it is used instead.
 */

/** Whether an operation compares against a threshold the caller supplies. */
export const NEEDS_THRESHOLD: Record<TemporalOperation, boolean> = {
  minimum: false, maximum: false,
  first_below: true, first_above: true,
  last_below: true, last_above: true,
};

export interface ObservedMatch {
  /** The observation that answers the question. */
  match:    SeriesPoint;
  /**
   * The observation immediately before it, when the series has one.
   *
   * ⚠️ WHAT IT CROSSED FROM, AND THE REASON A CROSSING IS NOT A DATE ALONE.
   * Debt reaching zero on the 22nd having been $89.46 on the 21st is a
   * different fact from debt that had been zero for a week, and a reader
   * deserves the one that is true.
   */
  previous: SeriesPoint | null;
}

/**
 * Answer one exact temporal question over an ordered series. PURE.
 *
 * ⚠️ OBSERVED, NEVER INTERPOLATED. The answer is always a date the series
 * actually holds. If debt was $17.12 on the 19th and $0 on the 22nd, the first
 * observed zero is the 22nd — not a modelled day in between, and not a hedge.
 * Callers should say "first observed" where the distinction can matter.
 *
 * ⚠️ TIES GO TO THE EARLIER OBSERVATION, within `MONEY_EPSILON`. A balance that
 * sits at its low for three days has one lowest day, and it is the first — a
 * later one would be an arbitrary choice presented as a fact.
 *
 * `points` must be ordered oldest-first and must already exclude observations
 * where the metric could not be established; an unestablished value is not a
 * low, and treating a null as a zero is how a gap becomes a milestone.
 */
export function findObservation(
  points: readonly SeriesPoint[],
  operation: TemporalOperation,
  threshold?: number,
): ObservedMatch | null {
  const usable = points.filter((p) => Number.isFinite(p.value));
  if (usable.length === 0) return null;
  const found = (i: number): ObservedMatch =>
    ({ match: usable[i], previous: i > 0 ? usable[i - 1] : null });

  if (operation === 'minimum' || operation === 'maximum') {
    let best = 0;
    for (let i = 1; i < usable.length; i++) {
      const v = usable[i].value, b = usable[best].value;
      if (sameMoney(v, b)) continue;              // a tie keeps the earlier day
      if (operation === 'minimum' ? v < b : v > b) best = i;
    }
    return found(best);
  }

  if (threshold === undefined || !Number.isFinite(threshold)) return null;
  // ⚠️ THE EPSILON WIDENS THE CONDITION, IT DOES NOT MOVE IT. "At or below zero"
  // must include a debt of 2.8e-14; it must not include a debt of one cent.
  // Strict at the widened bound, exactly as `sameMoney` is strict: half a cent is
  // the first difference that can be written down, so it is a real difference.
  const meets = (v: number) =>
    operation === 'first_below' || operation === 'last_below'
      ? v < threshold + MONEY_EPSILON
      : v > threshold - MONEY_EPSILON;

  const fromEnd = operation.startsWith('last_');
  for (let n = 0; n < usable.length; n++) {
    const i = fromEnd ? usable.length - 1 - n : n;
    if (meets(usable[i].value)) return found(i);
  }
  return null;
}

/**
 * The TRUE calendar distance in days between the first and last point.
 *
 * ⚠️ The only value that may be described as a duration. A snapshot ROW COUNT is
 * not one: it equals a day span only when snapshots are daily AND contiguous,
 * which nothing enforces, and four surfaces rendered it as "N days" before this
 * existed.
 */
export function seriesSpanDays(points: SeriesPoint[]): number {
  if (points.length === 0) return 0;
  const first = points[0].date.getTime();
  const last  = points[points.length - 1].date.getTime();
  return Math.round((last - first) / 86_400_000);
}
