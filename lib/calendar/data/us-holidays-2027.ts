/**
 * lib/calendar/data/us-holidays-2027.ts
 *
 * V26-PRICE-2 — US equity market full-day closures, 2027. See
 * us-holidays-2024.ts for the table doctrine.
 *
 * UNVERIFIED: no price archive data exists for 2027. Every entry is a forward
 * assertion derived from the statutory rules (fixed dates with weekend
 * observance, nth-weekday holidays, and Good Friday two days before Easter
 * Sunday, 2027-03-28). It cannot be falsified against evidence until data
 * arrives, which is the stated cost of a bounded table.
 *
 * THREE observance shifts land in this year — more than any other in the
 * horizon:
 *   Juneteenth   Sat 06-19 → closes Fri 06-18
 *   Independence Sun 07-04 → closes Mon 07-05
 *   Christmas    Sat 12-25 → closes Fri 12-24
 *
 * 2027-12-31 is the last date this calendar can honestly describe. Beyond it the
 * calendar returns HORIZON_EXCEEDED rather than emitting bare weekdays.
 */

export const US_MARKET_HOLIDAYS_2027: readonly string[] = [
  "2027-01-01", // New Year's Day (Fri)
  "2027-01-18", // Martin Luther King Jr. Day (Mon)
  "2027-02-15", // Washington's Birthday / Presidents' Day (Mon)
  "2027-03-26", // Good Friday (Fri; Easter is 2027-03-28)
  "2027-05-31", // Memorial Day (Mon)
  "2027-06-18", // Juneteenth OBSERVED (Fri; Jun 19 is a Saturday)
  "2027-07-05", // Independence Day OBSERVED (Mon; Jul 4 is a Sunday)
  "2027-09-06", // Labor Day (Mon)
  "2027-11-25", // Thanksgiving Day (Thu)
  "2027-12-24", // Christmas Day OBSERVED (Fri; Dec 25 is a Saturday)
];
