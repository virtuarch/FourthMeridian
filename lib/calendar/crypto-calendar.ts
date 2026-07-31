/**
 * lib/calendar/crypto-calendar.ts
 *
 * V26-PRICE-2 — the 24/7 crypto calendar: every calendar date is expected.
 *
 * No weekends, no holidays, no observance rules, no horizon, no data tables. Its
 * value is not the logic — there is barely any — but the proof that the
 * TradingCalendar abstraction is not equity-shaped. If the interface had assumed
 * closures, weekday filtering, or a bounded table, this file could not exist,
 * and the crypto path would have needed a parallel mechanism. That parallel
 * mechanism is exactly what the arc is removing elsewhere (BTC's acquisition
 * path bypassing PriceProviderAdapter).
 *
 * Consequences worth stating: a missing Saturday for an equity is NOT a gap,
 * while a missing Saturday for BTC IS one. Same planner, same report shape, one
 * substituted calendar — which is the whole point.
 *
 * Unbounded in both directions: with no table there is nothing to run out of, so
 * HORIZON_EXCEEDED can never apply here.
 */

import {
  assertCalendarDate,
  enumerateDatesISO,
  type BoundedTradingCalendar,
} from "./trading-calendar";

/**
 * Revision only — no horizon segment, because there is no versioned data behind
 * this calendar to date-bound. Bump if the definition of an expected crypto date
 * ever changes (it should not).
 */
export const CRYPTO_CALENDAR_ID = "crypto-247@r1";

export const cryptoCalendar: BoundedTradingCalendar = {
  id:                  CRYPTO_CALENDAR_ID,
  supportedFromISO:    null, // unbounded — no table to exhaust
  supportedThroughISO: null,

  expectedDates(fromISO: string, toISO: string): readonly string[] {
    assertCalendarDate(fromISO);
    assertCalendarDate(toISO);
    return enumerateDatesISO(fromISO, toISO);
  },
};
