/**
 * lib/transactions/economic-date-write.ts   (L8-A — chronology persistence)
 *
 * The ONE way a writer persists `Transaction.economicDate`.
 *
 * Pure: no DB, no clock. Wraps `resolveEconomicDate` and returns a write patch —
 * it does not re-derive anything, and there is deliberately no second code path
 * that could compute the column differently from the read authority.
 *
 * ── Why a column at all ────────────────────────────────────────────────────
 *
 * `economicDate` has been a DERIVED read-time value since V27-L4B, and that was
 * right while nothing needed to sort or filter by it. The read cutover does. The
 * expression is
 *
 *     CASE WHEN authorizedAt IS NOT NULL
 *           AND authorizedAt <= date
 *           AND (date - authorizedAt) <= 14
 *          THEN authorizedAt ELSE date END
 *
 * and Prisma cannot express it: there are no `previewFeatures` enabled, so no
 * `fieldRef`, so no column-to-column comparison in `where`; and `orderBy` accepts
 * a field name, never an expression. Measured on the live corpus, ordering by the
 * raw CASE turns an `Incremental Sort` with `Presorted Key: date` (35 buffers,
 * cost 13) into a full top-N heapsort over every row (232 buffers, cost 470) —
 * index traversal becoming a table scan, per page.
 *
 * The alternative was an over-fetch-and-reorder pagination layer plus a
 * boundary-corrected count. Both are implementable and both introduce a SECOND
 * place where this expression is evaluated. Financial Truth has spent its whole
 * arc removing exactly that shape, so the column is the honest answer.
 *
 * ── What is NOT persisted, and why ─────────────────────────────────────────
 *
 * ⚠️ Only the DATE is stored. `basis`, `state`, `lagDays` and `reason` stay
 * derived at read time from `date` + `authorizedAt`, which are both already
 * columns. Persisting an explanation alongside the value would create two facts
 * that can disagree after a bound changes; deriving it keeps one. The stored
 * column is the SORT KEY, not the story.
 *
 * ⚠️ A CONTRADICTORY resolution still writes the POSTING date, because that is
 * what the authority resolves to. The disagreement is not lost — it is
 * recomputed and reported at read time. The column never carries a value the
 * authority would not return.
 */

import { resolveEconomicDate } from "@/lib/transactions/economic-date";

/** The evidence a writer already holds when it builds a Transaction row. */
export interface EconomicDateWriteInput {
  /** The POSTING date being written to `Transaction.date`. */
  postingDate: Date | string;
  /** `Transaction.authorizedAt` being written on the same row, when known. */
  authorizedAt?: Date | string | null;
}

/**
 * The `economicDate` write patch. Spread into a `create`/`update` `data` object
 * next to `date`, so the two chronologies are always written together and a row
 * can never carry one without the other.
 *
 * Returns a `Date` at UTC midnight, matching the `@db.Date` encoding of `date`.
 */
export function economicDateWriteFields(input: EconomicDateWriteInput): { economicDate: Date } {
  const r = resolveEconomicDate({
    postingDate: input.postingDate,
    authorizedAt: input.authorizedAt ?? null,
  });
  return { economicDate: new Date(`${r.economicDate}T00:00:00.000Z`) };
}

/**
 * The same value as a plain `Date`, for callers assembling a row literal rather
 * than spreading a patch (the CSV import builds one big object; the BTC adapter
 * returns a typed row). Same authority, same result — this exists so no caller
 * is tempted to reach for `resolveEconomicDate` and re-implement the conversion.
 */
export function economicDateFor(input: EconomicDateWriteInput): Date {
  return economicDateWriteFields(input).economicDate;
}
