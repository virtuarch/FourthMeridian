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
