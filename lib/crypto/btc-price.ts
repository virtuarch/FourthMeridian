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

import { db } from "@/lib/db";
import { AssetClass, PriceBasis } from "@prisma/client";
import { priceArchive } from "@/lib/prices/archive";
import { fetchBtcDailyClosesUsd, type CoinGeckoOptions } from "@/lib/prices/providers/coingecko";

export const BTC_PRICE_SOURCE = "coingecko";

/**
 * Get-or-create the single global BTC Instrument (assetClass CRYPTO). Idempotent:
 * concurrent callers converge on one row (matched by tickerSymbol + assetClass).
 */
export async function resolveBtcInstrumentId(): Promise<string> {
  const existing = await db.instrument.findFirst({
    where:  { tickerSymbol: "BTC", assetClass: AssetClass.CRYPTO },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await db.instrument.create({
    data:   { tickerSymbol: "BTC", assetClass: AssetClass.CRYPTO, name: "Bitcoin", currency: "USD", isCashEquivalent: false },
    select: { id: true },
  });
  return created.id;
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
 * BTC/USD close as-of a date (walk-back within maxStaleDays), from the cache.
 * null when no priced row is within range (never fabricated).
 */
export async function readBtcUsdAsOf(dateISO: string, maxStaleDays = 7): Promise<number | null> {
  const instrumentId = await resolveBtcInstrumentId();
  const row = await priceArchive.readLatestOnOrBefore(instrumentId, PriceBasis.RAW_CLOSE, dateISO, maxStaleDays);
  return row?.price ?? null;
}
