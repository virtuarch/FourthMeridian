/**
 * lib/data/transaction-bounds.ts  (TX-2)
 *
 * The PURE bounding primitives for the transaction read contract — deliberately
 * free of any server-only dependency so they are unit-testable in isolation
 * (lib/data/transactions.ts imports + re-exports these). See TX-2 audit.
 */

/** Default row cap for a shared list read (matches the AI assembler's TRANSACTION_FETCH_LIMIT). */
export const DEFAULT_TX_LIMIT = 5000;

/**
 * Split a `take: limit + 1` fetch into the capped rows + a truncation flag. For
 * `fetched.length <= limit` the SAME array is returned (identity), so any
 * downstream fold over it is byte-identical to the unbounded read. Rows arrive
 * date-desc, so the kept slice is the MOST RECENT window; only the oldest tail is
 * dropped when truncated.
 */
export function capFetched<T>(fetched: T[], limit: number): { rows: T[]; truncated: boolean } {
  return fetched.length > limit
    ? { rows: fetched.slice(0, limit), truncated: true }
    : { rows: fetched, truncated: false };
}

/** The UTC date floor (midnight) for a window of `windowDays`, or null when
 *  unbounded (windowDays null/undefined — the row cap still bounds the read). */
export function windowFloorDate(windowDays: number | null | undefined, now: Date = new Date()): Date | null {
  if (windowDays == null) return null;
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - windowDays);
  return d;
}
