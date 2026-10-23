/**
 * lib/calendar/data/us-holidays-2026.ts
 *
 * V26-PRICE-2 — US equity market full-day closures, 2026. See
 * us-holidays-2024.ts for the table doctrine.
 *
 * PARTIALLY VERIFIED: the local price archive ends 2026-07-24, so the first
 * seven entries are confirmed absent in real data. Labor Day onward are forward
 * assertions, not observations.
 *
 * 2026-07-03 is the observance case the acceptance test exists for: Independence
 * Day falls on Saturday 2026-07-04, so the market closes the preceding Friday.
 * A table that listed 07-04 instead would produce a phantom gap on 07-03 and
 * treat a Saturday as an expected trading day.
 */

export const US_MARKET_HOLIDAYS_2026: readonly string[] = [
  "2026-01-01", // New Year's Day (Thu)                        — verified
  "2026-01-19", // Martin Luther King Jr. Day (Mon)            — verified
  "2026-02-16", // Washington's Birthday / Presidents' Day (Mon) — verified
  "2026-04-03", // Good Friday (Fri)                           — verified
  "2026-05-25", // Memorial Day (Mon)                          — verified
  "2026-06-19", // Juneteenth National Independence Day (Fri)  — verified
  "2026-07-03", // Independence Day OBSERVED (Fri; Jul 4 is a Saturday) — verified
  "2026-09-07", // Labor Day (Mon)
  "2026-11-26", // Thanksgiving Day (Thu)
  "2026-12-25", // Christmas Day (Fri)
];
