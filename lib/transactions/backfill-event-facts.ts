/**
 * lib/transactions/backfill-event-facts.ts
 *
 * The ONE projection input for a historical transaction row, shared by the dry
 * run AND the apply of scripts/backfill-event-identity.ts — so the preview is
 * the write.
 *
 * 2026-10-23 (Production clone rehearsal): B-6 (c1036dd) made projectEvent
 * resolve the event's economic date through the authorization date. Only the
 * dry-run copy of this mapping gained `authorizedAt`; the apply path still
 * omitted it, so every written event with an authorization date was pinned to
 * its POSTING date (2,783 of 4,634 events on Production's data), the audits
 * failed, and repair-event-pin-drift then propagated the wrong pin to the rows.
 */

import type { ObservationFacts } from "@/lib/transactions/event-identity";

export interface BackfillFactsRow {
  id: string;
  createdAt: Date;
  pending: boolean;
  amount: number;
  date: Date;
  economicDate: Date | null;
  authorizedAt: Date | null;
  deletedAt: Date | null;
}

export function factsOf(r: BackfillFactsRow): ObservationFacts {
  return {
    observedAt: r.createdAt,
    lifecycle: r.pending ? "PENDING" : "POSTED",
    amount: r.amount,
    postingDate: r.date,
    economicDate: r.economicDate as Date,
    authorizedAt: r.authorizedAt,
    liveTransactionId: r.deletedAt ? null : r.id,
  };
}
