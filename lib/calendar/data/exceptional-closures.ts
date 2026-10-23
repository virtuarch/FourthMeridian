/**
 * lib/calendar/data/exceptional-closures.ts
 *
 * V26-PRICE-2 — unscheduled US equity market closures within the supported
 * horizon: presidential funerals, weather emergencies, national days of
 * mourning, systems outages.
 *
 * Kept SEPARATE from the annual holiday tables on purpose. A recurring holiday is
 * derivable from a rule and reviewable as a pattern; an exceptional closure is
 * derivable from nothing and can only ever be recorded. Merging them would hide
 * the distinction that makes the annual tables auditable — and would lose the
 * reason, which is the only thing that explains the date.
 *
 * This is not a hypothetical file. The local price archive contains 21 absent
 * weekdays across its span; twenty are ordinary holidays and ONE is the entry
 * below. Without it, every one of the 17 equity instruments would report a
 * spurious INTERIOR_GAP on 2025-01-09 — which is precisely how the acceptance
 * test detects a wrong table.
 *
 * Entries must be weekdays that are not already in an annual table (asserted in
 * us-equity-calendar.test.ts, so a duplicate cannot pass review unnoticed).
 */

export const US_EXCEPTIONAL_CLOSURES: readonly string[] = [
  "2025-01-09", // National Day of Mourning — President Jimmy Carter (Thu) — verified absent in archive
];
