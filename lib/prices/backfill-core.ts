/**
 * lib/prices/backfill-core.ts
 *
 * A8-3A — the PURE planning logic for historical price acquisition, split from
 * the DB-touching script/job (the lens/core, backfill/backfill-core convention).
 * No Prisma, no network — fixture-tested. The script (scripts/backfill-security-
 * prices.ts) and the daily job (jobs/fetch-security-prices.ts) read the DB for
 * activity/coverage inputs, then call these helpers to decide WHAT to fetch, and
 * write results through the archive.
 *
 * Doctrine encoded here:
 *   - Backfill only DEFENSIBLE windows — bounded by an instrument's earliest
 *     real activity (first PositionObservation / InvestmentEvent), never
 *     arbitrary history for unused instruments.
 *   - Fetch only MISSING dates — resume from the latest already-covered date, so
 *     re-runs are cheap and idempotent.
 *   - Batched/paginated acquisition — a long window is split into bounded chunks.
 *   - No interpolation, ever — this module decides windows, not values.
 */

import { assertISODate, minusDaysISO } from "./config";

/**
 * The date window to fetch for one instrument, or null when nothing is missing.
 *
 *   from = day after the latest already-covered date (resume), or the earliest
 *          defensible activity date when nothing is covered yet.
 *   to   = the newest closed date (yesterday UTC), passed in as `toISO`.
 *
 * Returns null when `from > to` (fully covered, or no activity in range) so a
 * re-run after a complete backfill fetches nothing.
 */
export function resolveBackfillWindow(
  earliestActivityISO: string | null,
  latestCoveredISO: string | null,
  toISO: string,
): { fromISO: string; toISO: string } | null {
  assertISODate(toISO);
  if (!earliestActivityISO) return null; // instrument has no defensible activity — skip
  assertISODate(earliestActivityISO);

  let fromISO: string;
  if (latestCoveredISO) {
    assertISODate(latestCoveredISO);
    // Resume the day after the latest covered date, but never before activity.
    const dayAfter = minusDaysISO(latestCoveredISO, -1);
    fromISO = dayAfter > earliestActivityISO ? dayAfter : earliestActivityISO;
  } else {
    fromISO = earliestActivityISO;
  }

  if (fromISO > toISO) return null;
  return { fromISO, toISO };
}

/**
 * Split [fromISO, toISO] into ascending chunks of at most `maxDays` calendar
 * days each (batched/paginated acquisition — a vendor call per chunk). Inclusive
 * bounds. Deterministic. Throws on a non-positive maxDays (programmer error).
 */
export function chunkWindow(
  fromISO: string,
  toISO: string,
  maxDays: number,
): Array<{ fromISO: string; toISO: string }> {
  assertISODate(fromISO);
  assertISODate(toISO);
  if (maxDays <= 0) throw new Error(`[prices] chunkWindow requires maxDays > 0 (got ${maxDays})`);
  if (fromISO > toISO) return [];

  const out: Array<{ fromISO: string; toISO: string }> = [];
  let cursor = fromISO;
  // Bound the loop defensively; each iteration advances the cursor by >= 1 day.
  while (cursor <= toISO) {
    const chunkEnd = minusDaysISO(cursor, -(maxDays - 1)); // cursor + (maxDays-1) days
    const end = chunkEnd < toISO ? chunkEnd : toISO;
    out.push({ fromISO: cursor, toISO: end });
    cursor = minusDaysISO(end, -1); // day after this chunk's end
  }
  return out;
}

/**
 * Given per-instrument coverage for a single target date, the instrument ids
 * still MISSING that date — the daily job's fetch list. An instrument absent
 * from `covered` (never priced) is missing; one whose set lacks the date is
 * missing. Deterministic ascending order.
 */
export function selectInstrumentsMissingDate(
  instrumentIds: readonly string[],
  covered: ReadonlyMap<string, ReadonlySet<string>>,
  dateISO: string,
): string[] {
  assertISODate(dateISO);
  return [...instrumentIds]
    .filter((id) => !(covered.get(id)?.has(dateISO) ?? false))
    .sort();
}
