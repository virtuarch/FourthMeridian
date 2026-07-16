/**
 * lib/data/nearest-on-or-before.ts
 *
 * HIST-1B — PURE, generic "nearest observation on or before a date" resolver.
 * No DB, no valuation, no account logic, no persistence — a single linear pick
 * over an in-memory series keyed by an ISO date (YYYY-MM-DD, lexicographically
 * comparable), so it unit-tests without `prisma generate`.
 *
 * The investigation (INVEST-1 §11) found two hand-rolled copies of the same
 * "last row ≤ date" scan:
 *   - resolvePositionAsOf (M7, lib/investments/reconstruction-read.ts) — over
 *     UNSORTED position rows, with an origin-precedence tie-break on equal dates;
 *   - resolveState (M10, lib/wealth/wealth-time-machine.ts) — over a
 *     SORTED-ascending, unique-date snapshot series, last-match-wins.
 * Both are the same primitive. This helper serves both without assuming a sort
 * order and without collapsing their tie-break rules into one hidden default:
 * the caller supplies the tie-break it needs.
 *
 * Optional ceiling: `maxStaleDays` rejects a match that is more than N days
 * before `target` (the M8 price-staleness floor semantics — offered as a
 * parameter, never forced; the M7/M10 nearest-≤ carries no staleness ceiling).
 * No consumer is rewired onto the ceiling here (M8 remains the untouched
 * valuation authority); the option exists so the primitive can subsume that
 * variant later without a second implementation.
 */

const MS_PER_DAY = 86_400_000;

/** Whole UTC days from `from` to `to` (both date-only ISO). Negative if to<from. */
function daysBetweenIso(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY,
  );
}

export interface NearestOnOrBeforeOptions<T> {
  /**
   * Tie-break when a later-iterated item shares the winning date: return true to
   * REPLACE the current best. Omit for first-seen-wins. (M7 passes strongest-
   * origin-wins; M10 passes always-replace to reproduce last-in-sorted-order.)
   */
  preferOnTie?: (candidate: T, incumbent: T) => boolean;
  /**
   * Optional staleness ceiling in whole days: reject (return null) any match
   * whose date is more than `maxStaleDays` before `target`. Omit for no ceiling.
   */
  maxStaleDays?: number;
}

/**
 * The item with the greatest date on or before `target`, or null when none
 * qualifies (an honest gap — never a fabricated fallback). Deterministic; never
 * mutates its inputs; does NOT require `items` to be sorted.
 */
export function nearestOnOrBefore<T>(
  items: readonly T[],
  target: string,
  dateOf: (item: T) => string,
  options?: NearestOnOrBeforeOptions<T>,
): T | null {
  let best: T | null = null;
  let bestDate = "";
  for (const item of items) {
    const d = dateOf(item);
    if (d > target) continue;
    if (
      best === null ||
      d > bestDate ||
      (d === bestDate && options?.preferOnTie?.(item, best) === true)
    ) {
      best = item;
      bestDate = d;
    }
  }
  if (best !== null && options?.maxStaleDays !== undefined) {
    if (daysBetweenIso(bestDate, target) > options.maxStaleDays) return null;
  }
  return best;
}
