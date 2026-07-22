/**
 * lib/crypto/btc-price.ts
 *
 * A8-3B (crypto) — the DB binding for historical BTC valuation, reusing the SAME
 * global price cache the stock backfill uses:
 *   - a single GLOBAL Instrument (tickerSymbol "BTC", assetClass CRYPTO) — not a
 *     new table; Instrument's existing shape already models a crypto asset, and
 *     PriceObservation.source discriminates "coingecko" from "tiingo". Deduped
 *     across every user exactly like a stock's Instrument.
 *   - PriceObservation rows (basis RAW_CLOSE, source "coingecko") written via the
 *     same insert-only priceArchive.writeBatch as stocks.
 *
 * Backfill is best-effort and dark by default: with no COINGECKO_API_KEY, the
 * fetch returns [] and nothing is written — crypto stays flat-valued (unchanged),
 * so this lands safely before the key exists.
 */

import { PriceBasis } from "@prisma/client";
import { priceArchive } from "@/lib/prices/archive";
import { minusDaysISO } from "@/lib/prices/config";
import { nearestOnOrBefore } from "@/lib/data/nearest-on-or-before";
import { fetchBtcDailyClosesUsd, type CoinGeckoOptions } from "@/lib/prices/providers/coingecko";
import { resolveCanonicalBtcInstrumentId } from "@/lib/investments/crypto-instrument";

export const BTC_PRICE_SOURCE = "coingecko";

/**
 * The single global BTC Instrument (assetClass CRYPTO) the RAW_CLOSE price series
 * is written against. Delegates to the ONE canonical crypto Instrument resolver
 * (P2-6) so the price series and the position spine share ONE Instrument by
 * construction — a position writer's valuation finds the very prices written here,
 * and no second BTC Instrument can be minted. Idempotent + dedupe-safe (alias
 * unique). The prior get-or-create predicate (tickerSymbol="BTC" + CRYPTO) is
 * preserved inside the resolver's legacy-adoption step, so an already-created
 * price Instrument is adopted, not duplicated.
 */
export async function resolveBtcInstrumentId(): Promise<string> {
  return resolveCanonicalBtcInstrumentId();
}

export interface BtcBackfillResult {
  inserted:   number;
  attempted:  number;
  configured: boolean; // false ⇒ no COINGECKO_API_KEY, nothing fetched
}

/**
 * Backfill daily BTC/USD closes over [fromISO, toISO] into PriceObservation for
 * the global BTC Instrument. Missing-only (skipDuplicates) + closed-dates-only
 * (priceArchive rejects dates after yesterday UTC). Best-effort.
 */
export async function backfillBtcPrices(
  fromISO: string,
  toISO:   string,
  opts:    CoinGeckoOptions = {},
): Promise<BtcBackfillResult> {
  const closes = await fetchBtcDailyClosesUsd(fromISO, toISO, opts);
  if (closes.length === 0) {
    return { inserted: 0, attempted: 0, configured: !!(opts.apiKey ?? process.env.COINGECKO_API_KEY) };
  }
  const instrumentId = await resolveBtcInstrumentId();
  const rows = closes.map((c) => ({
    instrumentId,
    dateISO:  c.dateISO,
    basis:    PriceBasis.RAW_CLOSE,
    price:    c.price,
    currency: "USD",
  }));
  const w = await priceArchive.writeBatch(BTC_PRICE_SOURCE, rows);
  return { inserted: w.inserted, attempted: w.attempted, configured: true };
}

/**
 * HIST-2C — BTC/USD close resolver for a whole window in ONE archive read. Loads
 * the `[fromISO, toISO]` RAW_CLOSE window with a single `readRange` and returns a
 * pure resolver that answers each date from memory, replacing one
 * `readLatestOnOrBefore` point read per day (the last N×date read hot path in the
 * historical writer, INVEST-1/HIST-2 §J/§M).
 *
 * Per-date semantics are the archive's own walk-back: the latest RAW_CLOSE row in
 * `[date − maxStaleDays, date]`, else null (never fabricated) — reproduced exactly
 * by the shared `nearestOnOrBefore` (HIST-1B) with a `maxStaleDays` ceiling. NOT a
 * second price authority: same `priceArchive`, same canonical BTC Instrument, same
 * RAW_CLOSE series, USD pass-through, 7-day staleness. The preloaded window is
 * floored at `fromISO − maxStaleDays` so every date in `[fromISO, toISO]` sees its
 * full walk-back window.
 */
export async function readBtcUsdWindow(
  fromISO:      string,
  toISO:        string,
  maxStaleDays: number = 7,
): Promise<(dateISO: string) => number | null> {
  const instrumentId = await resolveBtcInstrumentId();
  const floorISO = minusDaysISO(fromISO, maxStaleDays);
  const rows =
    (await priceArchive.readRange?.([instrumentId], PriceBasis.RAW_CLOSE, floorISO, toISO)) ?? [];
  return (dateISO: string): number | null => {
    const hit = nearestOnOrBefore(rows, dateISO, (r) => r.dateISO, { maxStaleDays });
    return hit ? hit.price : null;
  };
}
