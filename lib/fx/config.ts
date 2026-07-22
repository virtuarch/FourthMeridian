/**
 * lib/fx/config.ts
 *
 * MC1 Phase 1 Slice 2 — approved FX constants (plan D5/D6) plus the small
 * pure ISO-date helpers the fx modules share. Pure module: no Prisma, no
 * network — safe to import from tests without `prisma generate`.
 */

/** Canonical base. Every archive row is USD-based; pairs resolve via cross-rate (plan §3.3). */
export const FX_BASE = "USD" as const;

/**
 * Walk-back bound for rate resolution (plan D5): covers the longest routine
 * market-closure runs (ECB Easter ≈ 4 days) with margin. Beyond this, the
 * resolver returns a RateMiss — never a fabricated rate.
 */
export const MAX_STALE_DAYS = 7;

/**
 * Approved supported quote list (plan D6) — exactly 24 quotes; USD is the
 * base and never a quote. Expanding later is additive (append-only archive).
 */
export const SUPPORTED_QUOTES = [
  "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY",
  "HKD", "SGD", "INR", "SAR", "AED", "SEK", "NOK", "DKK",
  "PLN", "CZK", "TRY", "ZAR", "MXN", "BRL", "KRW", "ILS",
] as const;

export type SupportedQuote = (typeof SUPPORTED_QUOTES)[number];

const QUOTE_SET: ReadonlySet<string> = new Set(SUPPORTED_QUOTES);

/** True for the base and every approved quote. */
export function isSupportedCurrency(code: string): boolean {
  return code === FX_BASE || QUOTE_SET.has(code);
}

// ── Pure ISO calendar-date helpers (UTC) ─────────────────────────────────────
// Shared by service.ts (walk-back window) and archive.ts (closed-date guard).

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws (programmer error) unless `s` is a valid "YYYY-MM-DD" calendar date. */
export function assertISODate(s: string): void {
  if (!ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`[fx] invalid ISO date: "${s}" (expected YYYY-MM-DD)`);
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

/** Yesterday's UTC calendar date — the newest date the append-only archive accepts (plan D4/D8). */
export function yesterdayUTCISO(now: Date = new Date()): string {
  return minusDaysISO(toISODateUTC(now), 1);
}

/**
 * Append-only doctrine guard: archive writes accept CLOSED dates only
 * (≤ yesterday UTC). Throws — a violation is a programmer error in a caller,
 * never a runtime condition to swallow.
 */
export function assertClosedDateISO(dateISO: string, now: Date = new Date()): void {
  assertISODate(dateISO);
  const yesterday = yesterdayUTCISO(now);
  if (dateISO > yesterday) {
    throw new Error(
      `[fx] append-only violation: "${dateISO}" is not a closed date (newest accepted: ${yesterday})`,
    );
  }
}
