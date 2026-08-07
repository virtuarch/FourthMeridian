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
    pct:       opening.value === 0 ? null : (abs / Math.abs(opening.value)) * 100,
    abs,
    preset,
  };
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
