/**
 * lib/transactions/event-projection.ts   (L8 — Phase B1, the reader cutover)
 *
 * THE statement that a read returns one row per LOGICAL EVENT.
 *
 * Pure and import-light: a Prisma where-fragment and a runtime guard. It
 * classifies nothing, converts nothing, and changes no total.
 *
 * ── What a reader used to be trusting ───────────────────────────────────────
 *
 * A pending charge and the posted row that supersedes it are ONE economic event
 * observed twice. Every read filtered `deletedAt: null` and got one row per
 * event — but only because the ingest path happens to tombstone the pending
 * predecessor when the posting arrives. Nothing in the read said so. If a
 * provider ever delivered a posting while its pending row was still live, every
 * total in the product would have counted that money twice, silently.
 *
 * Measured on the live corpus before this shipped:
 *
 *     4,372 events with exactly ONE live row
 *         7 events with NONE            (withdrawn pendings — correct)
 *         0 events with TWO             (so nothing is double-counted today)
 *         0 live rows superseded        (every live row IS its event's projection)
 *        33 live rows with NO event     (self-custody wallet rows, out of scope)
 *
 * So this slice changes no number. It converts an accident into a guarantee.
 *
 * ── The two halves ──────────────────────────────────────────────────────────
 *
 * `eventProjectionWhere` filters the population to current projections.
 * `assertOneRowPerEvent` catches, loudly, anything the filter did not — because
 * a duplicated economic event must never be presented as two, and a total that
 * is quietly wrong is worse than a read that refuses.
 *
 * ⚠️ A row with NO event is KEPT. Self-custody crypto is deliberately outside
 * the banking event domain (`isEventEligibleProvider`), and dropping those 33
 * rows would change real totals — the one thing this cutover must not do.
 */

import type { Prisma } from "@prisma/client";

/**
 * Population fragment: the row is its event's CURRENT projection, or it has no
 * event at all.
 *
 * `currentOfEvent` is the back-relation of `TransactionEvent.currentTransactionId`
 * (unique, so at most one event points at a given row). `isNot: null` therefore
 * reads exactly as "some event projects to this row".
 *
 * ⚠️ AND-ed with the caller's existing filters, never replacing them. Space
 * scoping, KD-15 visibility, `deletedAt` and the banking population are all
 * unaffected and still required.
 */
export function eventProjectionWhere(): Prisma.TransactionWhereInput {
  return {
    OR: [
      // Outside the banking event domain — crypto today, and any row whose
      // provider the identity authority refuses. Never dropped.
      { transactionEventId: null },
      // Inside it, and this row is the projection users should see.
      { currentOfEvent: { isNot: null } },
    ],
  };
}

/** A row carrying enough identity to be checked. */
export interface EventProjectedRow {
  id: string;
  transactionEventId?: string | null;
}

export interface EventProjectionViolation {
  eventId: string;
  transactionIds: string[];
}

/**
 * Find any logical event represented more than once in a result set.
 *
 * Returns the violations rather than throwing, so a caller decides whether to
 * refuse (a total) or to disclose (a list). Empty means the population is a
 * clean projection.
 */
export function findDuplicateEvents(rows: readonly EventProjectedRow[]): EventProjectionViolation[] {
  const byEvent = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.transactionEventId) continue;   // eventless rows cannot collide
    const ids = byEvent.get(r.transactionEventId);
    if (ids) ids.push(r.id);
    else byEvent.set(r.transactionEventId, [r.id]);
  }
  const out: EventProjectionViolation[] = [];
  for (const [eventId, transactionIds] of byEvent) {
    if (transactionIds.length > 1) out.push({ eventId, transactionIds });
  }
  return out;
}

/**
 * Refuse a result set that would double-count an economic event.
 *
 * ⚠️ THROWS, deliberately. This is the one place where failing loudly beats
 * degrading gracefully: the alternative is a dashboard that quietly reports
 * money twice, which no user can detect and no support ticket can describe.
 * `eventProjectionWhere` makes this unreachable; it exists so that if the filter
 * is ever dropped from a read, the read breaks instead of the numbers.
 */
export function assertOneRowPerEvent(rows: readonly EventProjectedRow[], readName: string): void {
  const dupes = findDuplicateEvents(rows);
  if (dupes.length === 0) return;
  const sample = dupes.slice(0, 3)
    .map((d) => `${d.eventId} → ${d.transactionIds.join(", ")}`).join("; ");
  throw new Error(
    `[${readName}] returned ${dupes.length} logical event(s) more than once, which would double-count them. ` +
    `Is eventProjectionWhere() still in this read's filter? ${sample}`,
  );
}

// ── How many LIVE rows does an event actually have? ──────────────────────────

/** One observation, as the live-row census reads it. */
export interface EventObservationRef {
  eventId: string;
  /** The row this observation was read from, or null once it is gone. */
  transactionId: string | null;
}

/**
 * DISTINCT live transaction rows per event.
 *
 * v2.6-EVENT-2 — extracted because `audit-event-identity` (INV-4) and
 * `audit-event-reader-cutover` each counted this THEMSELVES, and both counted
 * the wrong thing: they incremented once per OBSERVATION whose row is live,
 * which scores an event that observed ONE row twice as having two rows.
 *
 * ⚠️ Observing one row twice is not a defect. When Plaid re-keys a row (same
 * account, date, amount, descriptor and pending flag; a new `transaction_id`),
 * `syncTransactions` reuses the existing row instead of duplicating it — DF-4,
 * the fix for the six-Amazon-rows incident. The row is then legitimately
 * observed under two provider ids and both observations are true. What the
 * invariant forbids is an event PROJECTING two rows, because that is what would
 * double-count money; and that is a question about rows, not observations.
 *
 * The invariant is unchanged. Only the counter is corrected — proven in
 * `event-live-row-count.test.ts`, which keeps the old counter executable beside
 * the new one so the difference is demonstrated rather than asserted.
 */
export function countLiveRowsPerEvent(
  observations: readonly EventObservationRef[],
  liveTransactionIds: ReadonlySet<string>,
): Map<string, number> {
  const rowsByEvent = new Map<string, Set<string>>();
  for (const o of observations) {
    if (!o.transactionId || !liveTransactionIds.has(o.transactionId)) continue;
    const set = rowsByEvent.get(o.eventId) ?? new Set<string>();
    set.add(o.transactionId);
    rowsByEvent.set(o.eventId, set);
  }
  return new Map([...rowsByEvent].map(([eventId, rows]) => [eventId, rows.size]));
}

/** Event ids projecting MORE THAN ONE distinct live row — the INV-4 violation. */
export function eventsWithMultipleLiveRows(
  observations: readonly EventObservationRef[],
  liveTransactionIds: ReadonlySet<string>,
): string[] {
  return [...countLiveRowsPerEvent(observations, liveTransactionIds)]
    .filter(([, n]) => n > 1)
    .map(([eventId]) => eventId);
}
