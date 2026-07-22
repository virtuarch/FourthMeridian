/**
 * lib/fx/providers/frankfurter.ts
 *
 * MC1 Phase 1 Slice 3 — SECONDARY (failover) provider adapter (plan D1/D2).
 * Frankfurter serves ECB reference rates: keyless and free, but limited to
 * the ECB currency set — notably NO SAR/AED (the finding that made OXR
 * primary). Failover to this adapter narrows that day's coverage to the ECB
 * subset; missing quotes are simply absent rows, handled by the resolver's
 * walk-back/RateMiss — never fabricated (plan D2).
 *
 * ECB publishes banking days only. Frankfurter answers a non-banking-day
 * request with the PREVIOUS banking day's data and says so in its `date`
 * field. Storing those rates under the requested date would forge a close
 * that never happened, so the adapter returns [] when the response date
 * differs — the archive keeps only true closes, and weekend resolution is
 * the resolver's walk-back job.
 *
 * Dumb fetcher; pure parser exported for fixture tests (no network in tests).
 */

import type { FxProviderAdapter, RateResult } from "../types";
import { SUPPORTED_QUOTES, assertISODate } from "../config";

const FRANKFURTER_HOST = "https://api.frankfurter.dev";
const TIMEOUT_MS = 15_000;

export const FRANKFURTER_SOURCE = "frankfurter";

/** The ECB-covered subset of the approved quote list (everything except SAR/AED). */
export const FRANKFURTER_QUOTES: readonly string[] = SUPPORTED_QUOTES.filter(
  (q) => q !== "SAR" && q !== "AED",
);

/** Shape of GET /v1/{date}?base=USD (the fields we consume). */
export interface FrankfurterResponse {
  base?:  string;
  date?:  string; // the banking day the rates actually belong to
  rates?: Record<string, number>;
}

/**
 * Pure parser: Frankfurter JSON → canonical RateResult[] for the requested
 * date. Returns [] when the response is for an earlier banking day (weekend/
 * holiday — no close exists for the requested date). Throws on wrong base,
 * missing quote, or invalid rate — unusable batch, fail over.
 */
export function parseFrankfurterDay(
  json: FrankfurterResponse,
  dateISO: string,
  expectedQuotes: readonly string[],
): RateResult[] {
  assertISODate(dateISO);
  if (json.base !== "USD") {
    throw new Error(`[fx][frankfurter] unexpected base "${json.base}" (want USD)`);
  }
  if (json.date !== dateISO) {
    // Previous banking day answered — the requested date has no ECB close.
    return [];
  }
  const rates = json.rates ?? {};
  return expectedQuotes.map((quote) => {
    const rate = rates[quote];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`[fx][frankfurter] missing/invalid rate for ${quote} on ${dateISO}`);
    }
    return { dateISO, base: "USD" as const, quote, rate };
  });
}

/** Keyless adapter factory. */
export function createFrankfurterAdapter(): FxProviderAdapter {
  return {
    source: FRANKFURTER_SOURCE,
    historicalDepth: "1999-01-04", // ECB reference-rate series start
    supportedQuotes: (quotes) => quotes.filter((q) => FRANKFURTER_QUOTES.includes(q)),
    async fetchDailyRates(dateISO, quotes) {
      assertISODate(dateISO);
      const url = `${FRANKFURTER_HOST}/v1/${dateISO}?base=USD&symbols=${quotes.join(",")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(`[fx][frankfurter] HTTP ${res.status} for ${dateISO}`);
      }
      return parseFrankfurterDay((await res.json()) as FrankfurterResponse, dateISO, quotes);
    },
  };
}
