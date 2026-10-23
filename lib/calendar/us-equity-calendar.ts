/**
 * lib/calendar/us-equity-calendar.ts
 *
 * V26-PRICE-2 — the US equity/ETF trading calendar: weekdays, minus tabulated
 * full-day market closures, minus tabulated exceptional closures.
 *
 * Expected dates are produced from DATA, never inferred from the price archive.
 * Inferring "no price ⇒ not a trading day" would make every gap invisible by
 * construction — the exact failure this arc exists to remove.
 *
 * ── Horizon ─────────────────────────────────────────────────────────────────
 * 2024-01-01 … 2027-12-31, the span of the tabulated years. Outside it the
 * calendar cannot honestly say what was expected, so the binding returns
 * HORIZON_EXCEEDED and no coverage report is produced. `expectedDates()` throws
 * if called out of horizon anyway — defence in depth against a caller that
 * skipped the check; it is a programmer error, not a runtime condition.
 *
 * Extending the horizon is a DATA edit: add lib/calendar/data/us-holidays-YYYY.ts,
 * register it below, and bump the revision in the calendar id.
 *
 * ── Market identity ─────────────────────────────────────────────────────────
 * The supported MIC set is centralised HERE rather than scattered as literals
 * through selection logic, so "which venues does this calendar govern?" has one
 * answer that moves with the calendar it belongs to.
 */

import {
  assertCalendarDate,
  enumerateDatesISO,
  isWeekendISO,
  type BoundedTradingCalendar,
} from "./trading-calendar";
import { US_MARKET_HOLIDAYS_2024 } from "./data/us-holidays-2024";
import { US_MARKET_HOLIDAYS_2025 } from "./data/us-holidays-2025";
import { US_MARKET_HOLIDAYS_2026 } from "./data/us-holidays-2026";
import { US_MARKET_HOLIDAYS_2027 } from "./data/us-holidays-2027";
import { US_EXCEPTIONAL_CLOSURES } from "./data/exceptional-closures";

/**
 * Calendar identifier: family @ data horizon . revision. Versioned because the
 * underlying tables are — a report stamped `us-equity@2024-2027.r1` discloses
 * exactly which holiday data produced its expectations, which is what makes an
 * UNEXPECTED_OBSERVATION diagnosable rather than merely puzzling.
 *
 * BUMP THE REVISION on any edit to the tables below.
 */
export const US_EQUITY_CALENDAR_ID = "us-equity@2024-2027.r1";

export const US_EQUITY_SUPPORTED_FROM_ISO    = "2024-01-01";
export const US_EQUITY_SUPPORTED_THROUGH_ISO = "2027-12-31";

/**
 * Market Identifier Codes (ISO 10383) this calendar governs. Every US equity
 * venue observes the identical NYSE/Nasdaq full-day closure schedule, so one
 * table serves them all.
 *
 * Present in current data: XNAS (9 instruments), XNYS (7), ARCX (1).
 * The remainder are registered US venues on the same schedule, included so a
 * routine venue change does not strand an instrument. Adding a MIC requires
 * confirming the venue observes these exact closures — a non-US venue must NOT
 * be added here; it needs its own calendar.
 */
export const US_EQUITY_MICS: ReadonlySet<string> = new Set([
  "XNAS", // Nasdaq
  "XNYS", // New York Stock Exchange
  "ARCX", // NYSE Arca
  "XASE", // NYSE American
  "XCIS", // NYSE National
  "BATS", // Cboe BZX
  "IEXG", // Investors Exchange
]);

/**
 * Whether this calendar governs `mic`. A null or unrecognised MIC is NOT
 * assumed to be US — that assumption is exactly what would silently apply US
 * holidays to a foreign listing. The caller turns false into
 * NO_CALENDAR_FOR_MARKET.
 */
export function isUsEquityMarket(mic: string | null): boolean {
  return mic !== null && US_EQUITY_MICS.has(mic);
}

/**
 * Every tabulated closure across the horizon, as one set. Built once at module
 * load from frozen data — no clock, no I/O, identical on every process.
 */
const CLOSURES: ReadonlySet<string> = new Set([
  ...US_MARKET_HOLIDAYS_2024,
  ...US_MARKET_HOLIDAYS_2025,
  ...US_MARKET_HOLIDAYS_2026,
  ...US_MARKET_HOLIDAYS_2027,
  ...US_EXCEPTIONAL_CLOSURES,
]);

/** The full closure list, ascending — exported for fixtures and review tooling. */
export function usEquityClosuresISO(): string[] {
  return [...CLOSURES].sort();
}

export const usEquityCalendar: BoundedTradingCalendar = {
  id:                  US_EQUITY_CALENDAR_ID,
  supportedFromISO:    US_EQUITY_SUPPORTED_FROM_ISO,
  supportedThroughISO: US_EQUITY_SUPPORTED_THROUGH_ISO,

  expectedDates(fromISO: string, toISO: string): readonly string[] {
    assertCalendarDate(fromISO);
    assertCalendarDate(toISO);
    if (fromISO < US_EQUITY_SUPPORTED_FROM_ISO || toISO > US_EQUITY_SUPPORTED_THROUGH_ISO) {
      throw new Error(
        `[calendar] ${US_EQUITY_CALENDAR_ID} cannot describe ${fromISO}→${toISO} ` +
        `(supported ${US_EQUITY_SUPPORTED_FROM_ISO}→${US_EQUITY_SUPPORTED_THROUGH_ISO}); ` +
        `check calendarCoversWindow first`,
      );
    }
    return enumerateDatesISO(fromISO, toISO).filter(
      (d) => !isWeekendISO(d) && !CLOSURES.has(d),
    );
  },
};
