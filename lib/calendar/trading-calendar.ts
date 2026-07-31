/**
 * lib/calendar/trading-calendar.ts
 *
 * V26-PRICE-2 — the shared calendar layer: types and pure date helpers for the
 * concrete calendars (us-equity-calendar.ts, crypto-calendar.ts).
 *
 * The `TradingCalendar` contract itself is NOT redeclared here — it is imported
 * from lib/prices/types.ts, where V26-PRICE-1 declared it beside the other price
 * contracts. This module extends it with the horizon bounds a real, data-backed
 * calendar needs, and adds the failure vocabulary for the cases where expected
 * dates cannot honestly be produced at all.
 *
 * ── Why calendar failure is NOT a coverage reason ────────────────────────────
 * Two different questions live at two different layers:
 *
 *   "What evidence is missing?"        → coverage.core.ts → CoverageReport
 *   "Can I even state what was expected?" → this layer     → CalendarFailure
 *
 * A calendar asked for 2029 cannot answer the second question, so it must not be
 * allowed to fake an answer to the first. Emitting weekdays past the tabulated
 * horizon would silently fabricate expectations and turn every future weekday
 * into a phantom gap. HORIZON_EXCEEDED is therefore deliberately NOT a member of
 * COVERAGE_REASONS: a coverage report over fabricated expectations is worse than
 * no report. The binding returns one or the other, never a blend.
 *
 * ── No runtime dependency on lib/prices ─────────────────────────────────────
 * The only import is `import type` (erased at compile time), and the date helpers
 * below are deliberately re-implemented rather than taken from lib/prices/config
 * — which carries a VALUE import of @prisma/client for PRICE_BASES. Cloning a few
 * lines of date arithmetic keeps lib/calendar loadable with no Prisma client at
 * all, and follows the house precedent set by lib/prices/config.ts itself, which
 * clones lib/fx/config.ts rather than coupling to it ("clone the pattern, never
 * couple to it").
 *
 * Determinism: no clock, no locale, no randomness. Every helper is a pure
 * function of its ISO string arguments. ISO "YYYY-MM-DD" sorts lexicographically
 * in chronological order, so plain string comparison is both correct and
 * locale-independent — never localeCompare.
 */

import type { TradingCalendar } from "@/lib/prices/types";

export type { TradingCalendar };

/**
 * A TradingCalendar backed by finite data, and therefore honest about where its
 * knowledge stops. `null` on either bound means unbounded in that direction —
 * true for crypto, which needs no table at all.
 */
export interface BoundedTradingCalendar extends TradingCalendar {
  readonly supportedFromISO:    string | null;
  readonly supportedThroughISO: string | null;
}

/**
 * Why expected dates could not be produced. Structurally separate from
 * CoverageReport — see the header. Both variants are plain data with stable key
 * order so a binding result serializes deterministically.
 */
export type CalendarFailure =
  | {
      code:                "HORIZON_EXCEEDED";
      calendarId:          string;
      supportedFromISO:    string | null;
      supportedThroughISO: string | null;
      requestedFromISO:    string;
      requestedToISO:      string;
    }
  | {
      code:       "NO_CALENDAR_FOR_MARKET";
      assetClass: string;
      mic:        string | null;
    };

// ── Pure ISO calendar-date helpers (UTC) ─────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Throws (programmer error) unless `s` is a valid "YYYY-MM-DD" calendar date. */
export function assertCalendarDate(s: string): void {
  if (!ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`[calendar] invalid ISO date: "${s}" (expected YYYY-MM-DD)`);
  }
}

/** ISO day of week, ISO-8601 numbering: 1 = Monday … 7 = Sunday. */
export function isoDayOfWeek(dateISO: string): number {
  assertCalendarDate(dateISO);
  const jsDay = new Date(`${dateISO}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return jsDay === 0 ? 7 : jsDay;
}

/** Saturday or Sunday. Every supported market is closed on both. */
export function isWeekendISO(dateISO: string): boolean {
  return isoDayOfWeek(dateISO) >= 6;
}

/**
 * Every calendar date in [fromISO, toISO] inclusive, ascending. Returns [] for
 * an inverted window rather than throwing: unlike coverage planning, an empty
 * enumeration is a meaningful answer here (a caller may legitimately probe an
 * empty span), and the callers that must reject inversion do so themselves.
 */
export function enumerateDatesISO(fromISO: string, toISO: string): string[] {
  assertCalendarDate(fromISO);
  assertCalendarDate(toISO);
  if (fromISO > toISO) return [];
  const out: string[] = [];
  let t = Date.parse(`${fromISO}T00:00:00Z`);
  const end = Date.parse(`${toISO}T00:00:00Z`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += MS_PER_DAY;
  }
  return out;
}

/**
 * Whether `calendar` can honestly enumerate the whole of [fromISO, toISO].
 * A null bound is unbounded in that direction.
 */
export function calendarCoversWindow(
  calendar: BoundedTradingCalendar,
  fromISO:  string,
  toISO:    string,
): boolean {
  assertCalendarDate(fromISO);
  assertCalendarDate(toISO);
  if (calendar.supportedFromISO !== null && fromISO < calendar.supportedFromISO) return false;
  if (calendar.supportedThroughISO !== null && toISO > calendar.supportedThroughISO) return false;
  return true;
}

/** Build the HORIZON_EXCEEDED failure for a calendar that cannot cover a window. */
export function horizonFailure(
  calendar: BoundedTradingCalendar,
  fromISO:  string,
  toISO:    string,
): CalendarFailure {
  return {
    code:                "HORIZON_EXCEEDED",
    calendarId:          calendar.id,
    supportedFromISO:    calendar.supportedFromISO,
    supportedThroughISO: calendar.supportedThroughISO,
    requestedFromISO:    fromISO,
    requestedToISO:      toISO,
  };
}
