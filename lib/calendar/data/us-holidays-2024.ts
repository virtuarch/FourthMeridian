/**
 * lib/calendar/data/us-holidays-2024.ts
 *
 * V26-PRICE-2 — US equity market full-day closures, 2024. NYSE/Nasdaq observe an
 * identical schedule.
 *
 * These are ACTUAL closure dates, already observance-adjusted: where a holiday
 * falls on a Saturday the market closes the preceding Friday, and where it falls
 * on a Sunday it closes the following Monday. Storing the resolved date rather
 * than a rule keeps the table reviewable and makes the acceptance test exact —
 * over a bounded four-year horizon a table is more trustworthy than an
 * observance engine plus an Easter algorithm.
 *
 * Every entry must be a WEEKDAY (a weekend entry is a transcription error and is
 * asserted against in us-equity-calendar.test.ts).
 *
 * NOT listed: early closes (the day after Thanksgiving, Christmas Eve when it
 * falls midweek). Those are TRADING days that produce a close price, so they are
 * expected dates and must not be excluded.
 *
 * Verified against the local price archive for the portion within its span
 * (2024-07-22 onward): 2024-09-02, 2024-11-28 and 2024-12-25 are the only absent
 * weekdays in that range, and all three appear below.
 */

export const US_MARKET_HOLIDAYS_2024: readonly string[] = [
  "2024-01-01", // New Year's Day (Mon)
  "2024-01-15", // Martin Luther King Jr. Day (Mon)
  "2024-02-19", // Washington's Birthday / Presidents' Day (Mon)
  "2024-03-29", // Good Friday (Fri)
  "2024-05-27", // Memorial Day (Mon)
  "2024-06-19", // Juneteenth National Independence Day (Wed)
  "2024-07-04", // Independence Day (Thu)
  "2024-09-02", // Labor Day (Mon)          — verified absent in archive
  "2024-11-28", // Thanksgiving Day (Thu)   — verified absent in archive
  "2024-12-25", // Christmas Day (Wed)      — verified absent in archive
];
