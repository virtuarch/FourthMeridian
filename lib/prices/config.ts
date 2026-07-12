/**
 * lib/prices/config.ts
 *
 * A8-1 — historical-price constants and the small pure date helpers the price
 * modules share. Structural clone of lib/fx/config.ts (append-only daily value
 * series, walk-back reads, closed-date guard) — the FX subsystem is the proven
 * template, but lib/prices is deliberately self-contained: it never imports
 * lib/fx (doctrine: clone the pattern, never couple to it). Pure module: no
 * Prisma, no network — safe to import from tests without `prisma generate`.
 */

import { PriceBasis } from "@prisma/client";

/**
 * Walk-back bound for price resolution. Matches FX's MAX_STALE_DAYS = 7: it
 * spans a weekend plus the longest routine market-holiday runs (e.g. a
 * Thursday–Monday close around a mid-week holiday) with margin. Beyond this the
 * resolver returns a PriceMiss — never a fabricated price. Never interpolates.
 */
export const PRICE_MAX_STALE_DAYS = 7;

/**
 * The canonical bases, each a DISTINCT price series for one instrument. A read
 * for one basis never falls through to another (basis isolation, service.ts):
 *   RAW_CLOSE      — unadjusted market close; THE canonical valuation series
 *                    (a known historical quantity is valued at the price as it
 *                    was on that date, before any later split/dividend adjust).
 *   ADJUSTED_CLOSE — split/dividend-adjusted close; charting only, NEVER mixed
 *                    into valuation.
 *   NAV            — mutual-fund net asset value (often no intraday).
 *   INTRADAY       — a within-session price (reserved; not a daily-close fact).
 *   CRYPTO_DAILY   — a stated UTC daily close for crypto assets.
 */
export const PRICE_BASES = [
  PriceBasis.RAW_CLOSE,
  PriceBasis.ADJUSTED_CLOSE,
  PriceBasis.NAV,
  PriceBasis.INTRADAY,
  PriceBasis.CRYPTO_DAILY,
] as const;

// ── Pure ISO calendar-date helpers (UTC) ─────────────────────────────────────
// Cloned from lib/fx/config.ts so lib/prices carries no lib/fx dependency.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws (programmer error) unless `s` is a valid "YYYY-MM-DD" calendar date. */
export function assertISODate(s: string): void {
  if (!ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`[prices] invalid ISO date: "${s}" (expected YYYY-MM-DD)`);
  }
}

/** UTC calendar date of a Date instant, as "YYYY-MM-DD". */
export function toISODateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO date minus n days (UTC arithmetic). */
export function minusDaysISO(dateISO: string, n: number): string {
  assertISODate(dateISO);
  const t = Date.parse(`${dateISO}T00:00:00Z`) - n * 86_400_000;
  return toISODateUTC(new Date(t));
}

/** Whole-day gap between two ISO dates (from ≤ to expected); UTC arithmetic. */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  assertISODate(fromISO);
  assertISODate(toISO);
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000,
  );
}

/** Yesterday's UTC calendar date — the newest date the append-only archive accepts. */
export function yesterdayUTCISO(now: Date = new Date()): string {
  return minusDaysISO(toISODateUTC(now), 1);
}

/**
 * Append-only doctrine guard: price archive writes accept CLOSED dates only
 * (≤ yesterday UTC). Throws — a future-dated close price is a caller bug (an
 * arrival date masquerading as a market date), never a runtime condition to
 * swallow.
 */
export function assertClosedDateISO(dateISO: string, now: Date = new Date()): void {
  assertISODate(dateISO);
  const yesterday = yesterdayUTCISO(now);
  if (dateISO > yesterday) {
    throw new Error(
      `[prices] append-only violation: "${dateISO}" is not a closed date (newest accepted: ${yesterday})`,
    );
  }
}
