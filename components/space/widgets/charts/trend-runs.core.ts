/**
 * components/space/widgets/charts/trend-runs.core.ts
 *
 * The PURE geometry-splitting core behind TrendChart — no React, no DOM, no
 * clock, no scaling functions. It answers three questions about a trend series,
 * in index space only, so the component owns pixels and this owns meaning:
 *
 *   toRuns()        which stretches may be drawn as one connected line
 *   toDateGaps()    where the series has a real hole (nothing was ever recorded)
 *   toBasisSeams()  where the EVIDENCE BASIS changes between two adjacent points
 *
 * ── Why a seam is not a gap ──────────────────────────────────────────────────
 * A date gap says "we have no value here". A basis seam says "we have values on
 * both sides, measured differently" — a reconstructed value on one side, an
 * observed one on the other. Drawing the second with the first's hatched
 * "NEVER OBSERVED" vocabulary would be a lie in the other direction, so they are
 * separate concepts with separate marks.
 *
 * V26-INVESTMENTS-HISTORY — `toRuns` already refuses to bridge a basis change
 * (a reconstructed and an observed value are two measurements of different
 * quality, not one measurement whose character changed). But an unbridged break
 * between two points one day apart is INVISIBLE: the dashed line stops low, the
 * solid line starts high ~10px later, and the eye reads the step as market
 * movement anyway. `toBasisSeams` is what lets the component draw the break it
 * is already making, so the transition reads as a change of basis rather than a
 * gain or a loss.
 *
 * A seam is NOT emitted where a date hole already falls, so the two marks never
 * stack on one boundary — the hole is the stronger statement and wins.
 */

export const DAY_MS = 86_400_000;

export type TrendBasis = "observed" | "reconstructed";

/** A trend point with its epoch time resolved. Index-stable across all three functions. */
export interface TrendGeomPoint {
  date:      string; // YYYY-MM-DD
  t:         number; // epoch ms
  value:     number;
  estimated: boolean;
}

export interface TrendRun {
  points: TrendGeomPoint[];
  basis:  TrendBasis;
}

/** A real hole in the series — nothing was recorded between these two points. */
export interface TrendDateGap {
  fromIndex: number;
  toIndex:   number;
}

/** A change of evidence basis between two ADJACENT points (no hole between them). */
export interface TrendBasisSeam {
  /** Index of the last point on the OLD basis. */
  fromIndex: number;
  /** Index of the first point on the NEW basis; always fromIndex + 1. */
  toIndex:   number;
  fromBasis: TrendBasis;
  toBasis:   TrendBasis;
  fromDate:  string;
  toDate:    string;
}

/** The evidence basis a point was measured on. */
export function basisOf(p: { estimated: boolean }): TrendBasis {
  return p.estimated ? "reconstructed" : "observed";
}

/** True when the span between two consecutive points exceeds the gap scale. */
export function isDateHole(prev: TrendGeomPoint, next: TrendGeomPoint, gapDays: number): boolean {
  return (next.t - prev.t) / DAY_MS > gapDays;
}

/** Median day-spacing across consecutive points — a robust gap scale. */
export function medianSpacingDays(times: readonly number[]): number {
  if (times.length < 2) return 1;
  const diffs = times.slice(1).map((t, i) => (t - times[i]) / DAY_MS).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

/**
 * Split into contiguous runs, breaking on (a) a real date hole and (b) a change
 * of basis. Neither is bridged: adjacent runs do not share a boundary point, so
 * no stroke is ever drawn between two differently-measured values.
 */
export function toRuns(pts: readonly TrendGeomPoint[], gapDays: number): TrendRun[] {
  const runs: TrendRun[] = [];
  let cur: TrendRun | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const hole = prev ? isDateHole(prev, p, gapDays) : false;
    const basis = basisOf(p);
    const basisChanged = prev ? basisOf(prev) !== basis : false;
    if (!cur || hole || basisChanged) {
      cur = { points: [p], basis };
      runs.push(cur);
    } else {
      cur.points.push(p);
    }
  }
  return runs.filter((r) => r.points.length > 0);
}

/** Every real hole in the series, as index pairs. */
export function toDateGaps(pts: readonly TrendGeomPoint[], gapDays: number): TrendDateGap[] {
  const out: TrendDateGap[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (isDateHole(pts[i - 1], pts[i], gapDays)) out.push({ fromIndex: i - 1, toIndex: i });
  }
  return out;
}

/**
 * Every change of evidence basis between two ADJACENT points.
 *
 * Excludes boundaries that are also date holes: those already render as the
 * hatched "never observed" band, and stacking a second mark on them would
 * over-state one boundary while the plain seams beside it stay unmarked.
 */
export function toBasisSeams(pts: readonly TrendGeomPoint[], gapDays: number): TrendBasisSeam[] {
  const out: TrendBasisSeam[] = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const p = pts[i];
    if (isDateHole(prev, p, gapDays)) continue; // the hole is the stronger mark
    const fromBasis = basisOf(prev);
    const toBasis = basisOf(p);
    if (fromBasis === toBasis) continue;
    out.push({
      fromIndex: i - 1, toIndex: i,
      fromBasis, toBasis,
      fromDate: prev.date, toDate: p.date,
    });
  }
  return out;
}
