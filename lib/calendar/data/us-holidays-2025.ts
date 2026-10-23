/**
 * lib/calendar/data/us-holidays-2025.ts
 *
 * V26-PRICE-2 — US equity market full-day closures, 2025. See
 * us-holidays-2024.ts for the table doctrine (resolved observance dates, no
 * early closes, weekday-only).
 *
 * FULLY VERIFIED: the local price archive spans this entire year, and its absent
 * weekdays for 2025 are exactly the ten dates below plus 2025-01-09, which is an
 * exceptional closure and lives in exceptional-closures.ts rather than here —
 * the distinction the two files exist to preserve.
 */

export const US_MARKET_HOLIDAYS_2025: readonly string[] = [
  "2025-01-01", // New Year's Day (Wed)
  "2025-01-20", // Martin Luther King Jr. Day (Mon)
  "2025-02-17", // Washington's Birthday / Presidents' Day (Mon)
  "2025-04-18", // Good Friday (Fri)
  "2025-05-26", // Memorial Day (Mon)
  "2025-06-19", // Juneteenth National Independence Day (Thu)
  "2025-07-04", // Independence Day (Fri)
  "2025-09-01", // Labor Day (Mon)
  "2025-11-27", // Thanksgiving Day (Thu)
  "2025-12-25", // Christmas Day (Thu)
];
