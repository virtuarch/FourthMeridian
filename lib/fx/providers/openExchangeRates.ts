/**
 * lib/fx/providers/openExchangeRates.ts
 *
 * MC1 Phase 1 Slice 3 — PRIMARY provider adapter (plan D1).
 * Open Exchange Rates: USD-base native (= our canonical base), ~170
 * currencies (covers SAR/AED — the reason it is primary), historical daily
 * endpoint available on the free plan. Requires OXR_APP_ID.
 *
 * Dumb fetcher per the adapter contract (types.ts): no storage, no failover,
 * no selection logic. Complete-or-throw: a response missing any requested
 * quote throws, so the orchestrator discards the partial batch and fails
 * over (plan D2). The response parser is exported separately as a pure
 * function so tests cover it with fixtures — no network in tests (plan §4).
 */

import type { FxProviderAdapter, RateResult } from "../types";
import { assertISODate } from "../config";

const OXR_HOST = "https://openexchangerates.org";
const TIMEOUT_MS = 15_000;

export const OXR_SOURCE = "openexchangerates";

/** Shape of GET /api/historical/{date}.json (the fields we consume). */
export interface OxrHistoricalResponse {
  base?:  string;
  rates?: Record<string, number>;
}

/**
 * Pure parser: OXR historical JSON → canonical RateResult[] for the requested
 * date. Throws on any deviation (wrong base, missing quote, non-finite or
 * non-positive rate) — a throw means "this batch is unusable, fail over".
 */
export function parseOxrHistorical(
  json: OxrHistoricalResponse,
  dateISO: string,
  expectedQuotes: readonly string[],
): RateResult[] {
  assertISODate(dateISO);
  if (json.base !== "USD") {
    throw new Error(`[fx][oxr] unexpected base "${json.base}" (want USD)`);
  }
  const rates = json.rates ?? {};
  return expectedQuotes.map((quote) => {
    const rate = rates[quote];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`[fx][oxr] missing/invalid rate for ${quote} on ${dateISO}`);
    }
    return { dateISO, base: "USD" as const, quote, rate };
  });
}

/**
 * Adapter factory. `appId` is injected (defaultFxRegistry passes
 * process.env.OXR_APP_ID); constructing without a key is a programmer error —
 * the registry simply omits this adapter when the key is absent (plan §5
 * safe-disable: Frankfurter-only coverage).
 */
export function createOpenExchangeRatesAdapter(appId: string): FxProviderAdapter {
  if (!appId) throw new Error("[fx][oxr] OXR_APP_ID is required to construct this adapter");
  return {
    source: OXR_SOURCE,
    historicalDepth: "1999-01-01",
    // OXR covers every approved quote (plan D6 was curated with this in mind).
    supportedQuotes: (quotes) => [...quotes],
    async fetchDailyRates(dateISO, quotes) {
      assertISODate(dateISO);
      const url =
        `${OXR_HOST}/api/historical/${dateISO}.json` +
        `?app_id=${encodeURIComponent(appId)}&base=USD&symbols=${quotes.join(",")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(`[fx][oxr] HTTP ${res.status} for ${dateISO}`);
      }
      return parseOxrHistorical((await res.json()) as OxrHistoricalResponse, dateISO, quotes);
    },
  };
}
