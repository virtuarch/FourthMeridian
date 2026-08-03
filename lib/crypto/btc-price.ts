/**
 * lib/crypto/btc-price.ts
 *
 * A8-3B (crypto) — the DB binding for historical BTC VALUATION.
 *
 * V26-PRICE-PROVIDER-UNIFICATION removed `backfillBtcPrices` from this module.
 * BTC acquisition now travels the same registry path as equities
 * (backfillPricesForInstruments → capability routing → CoinGecko adapter →
 * priceArchive), so there is no asset-specific acquisition code left anywhere.
 *
 * What remains here is deliberately BTC-specific and stays that way until
 * V26-PRICE-5: `readBtcUsdWindow` is a VALUATION read, not acquisition.
 * Generalising valuation reads is PRICE-5's remit, and doing it here would mix
 * two slices.
 *
 * It reuses the SAME global price cache the stock backfill uses:
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
import { resolveCanonicalBtcInstrumentId } from "@/lib/investments/crypto-instrument";

/**
 * Provenance stamped on BTC price rows. Still exported for readers that key on
 * it; the WRITER is now the shared archive path, not this module.
 */
export const BTC_PRICE_SOURCE = "coingecko";

/**
 * The single global BTC Instrument (assetClass CRYPTO) the RAW_CLOSE price series
 * is written against. Delegates to the ONE canonical crypto Instrument resolver
 * (P2-6) so the price series and the position spine share ONE Instrument by
 * construction. Idempotent + dedupe-safe.
 */
export async function resolveBtcInstrumentId(): Promise<string> {
  return resolveCanonicalBtcInstrumentId();
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
