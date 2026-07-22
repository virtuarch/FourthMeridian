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
 * A9 force-backfill — the missing sub-window(s) of [forceFromISO, forceToISO]
 * that fall OUTSIDE existing coverage.
 *
 * 2026-07-15 bug fix: resolveBackfillWindow assumes coverage grows FORWARD
 * from earliest activity and resumes the day after the latest covered date —
 * correct for the daily cron's normal path. A forceWindow's job is the
 * opposite: backfill a historical span BEHIND whatever the daily cron has
 * already accreted forward from today. Reusing resolveBackfillWindow's
 * "resume after latest covered" logic for a forceWindow collapses to an empty
 * window the moment ANY recent coverage exists — the root cause of historical
 * investment valuation falling off after ~30 days (every held instrument
 * already had ~20 days of front-edge cron coverage, so `dayAfter(latestCovered)
 * > toISO` and the force window resolved to null before ever reaching the
 * price vendor for the older span).
 *
 * Assumes a single contiguous covered interval [earliestCoveredISO,
 * latestCoveredISO] — true in practice (the cron accretes one contiguous
 * block forward from wherever the last backfill left off); does not attempt
 * to detect gaps WITHIN that interval.
 *
 * Returns 0, 1, or 2 windows:
 *  - no coverage at all → [forceFromISO, forceToISO] (unchanged from today)
 *  - an OLDER gap: [forceFromISO, earliestCoveredISO − 1], when forceFromISO
 *    precedes existing coverage
 *  - a NEWER gap: [latestCoveredISO + 1, forceToISO], when forceToISO follows
 *    existing coverage (rare — the daily cron usually keeps this current, but
 *    not assumed)
 */
export function resolveForceBackfillWindows(
  forceFromISO: string,
  forceToISO: string,
  earliestCoveredISO: string | null,
  latestCoveredISO: string | null,
): Array<{ fromISO: string; toISO: string }> {
  assertISODate(forceFromISO);
  assertISODate(forceToISO);
  if (forceFromISO > forceToISO) return [];

  if (!earliestCoveredISO || !latestCoveredISO) {
    return [{ fromISO: forceFromISO, toISO: forceToISO }];
  }
  assertISODate(earliestCoveredISO);
  assertISODate(latestCoveredISO);

  const windows: Array<{ fromISO: string; toISO: string }> = [];

  if (forceFromISO < earliestCoveredISO) {
    const olderTo = minusDaysISO(earliestCoveredISO, 1);
    if (forceFromISO <= olderTo) windows.push({ fromISO: forceFromISO, toISO: olderTo });
  }
  if (forceToISO > latestCoveredISO) {
    const newerFrom = minusDaysISO(latestCoveredISO, -1);
    if (newerFrom <= forceToISO) windows.push({ fromISO: newerFrom, toISO: forceToISO });
  }

  return windows;
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
