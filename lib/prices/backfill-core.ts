/**
 * lib/prices/backfill-core.ts
 *
 * A8-3A — pure helpers for historical price acquisition. No Prisma, no network
 * — fixture-tested.
 *
 * ── V26-PRICE-3: the window planners were REMOVED ───────────────────────────
 * This module used to export `resolveBackfillWindow` (resume forward from the
 * latest covered date) and `resolveForceBackfillWindows` (subtract the covered
 * block's edges from a requested span). Both inferred coverage from block
 * EDGES, which silently assumed stored evidence forms a single contiguous
 * interval. Its own comment admitted the assumption and admitted it could not
 * detect a gap WITHIN the block.
 *
 * The assumption was never enforced — it held only because one force-backfill
 * happened to write a dense block — and when it broke on 2026-07-15 a two-year
 * historical request collapsed to an empty window the moment the daily cron had
 * written ANY recent row, silently ending historical valuation about thirty days
 * back. The fix applied then patched the symptom (a second planner for the
 * force path) while keeping the same edge arithmetic.
 *
 * Acquisition windows are now planned from an explicit missing-date set:
 *
 *     lib/prices/coverage.core.ts          what evidence is missing (pure)
 *     lib/prices/coverage-binding.ts       real expected + observed dates
 *     lib/prices/acquisition-plan.core.ts  missing ranges → provider requests
 *
 * Both planners were deleted rather than deprecated: they encoded a falsified
 * assumption, had no remaining production callers, and keeping them would have
 * left two competing coverage authorities in one directory — the condition that
 * produced the original defect.
 *
 * What remains here is genuinely orthogonal to coverage:
 *   - chunkWindow — splitting ONE window into vendor-sized requests. Used by the
 *     acquisition planner; knows nothing about what is covered.
 *   - selectInstrumentsMissingDate — the daily cron's single-date selection. No
 *     interval reasoning of any kind, so the contiguity defect never applied.
 *
 * Doctrine still encoded: batched/paginated acquisition, and NO interpolation
 * ever — these helpers decide windows, never values.
 */

import { assertISODate, minusDaysISO } from "./config";

/**
 * Split [fromISO, toISO] into ascending chunks of at most `maxDays` calendar
 * days each (one vendor call per chunk). INCLUSIVE bounds on both the input and
 * every chunk: a chunk spanning exactly `maxDays` days runs from its first day
 * through its last, and consecutive chunks are adjacent with no gap and no
 * overlap. Deterministic. Throws on a non-positive maxDays (programmer error).
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
 *
 * Single-date only: this never reasons about intervals, so it was untouched by
 * the contiguity defect above. The daily job additionally filters out
 * instruments that cannot be priced at all before calling this — see
 * jobs/fetch-security-prices.ts.
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
