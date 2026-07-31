/**
 * lib/prices/providers/coingecko.ts
 *
 * A8-3B (crypto) — CoinGecko daily crypto/USD history, dependency-free (Node fetch).
 *
 * V26-PRICE-PROVIDER-UNIFICATION — the coin id is now a PARAMETER and this module
 * exports a real PriceProviderAdapter, so crypto acquisition travels the same
 * registry path as equities. It previously hardcoded `BTC_COIN_ID = "bitcoin"`
 * into the request URL and was called directly by lib/crypto/btc-price.ts, which
 * wrote to the archive itself — a second acquisition path that bypassed the
 * registry entirely and made "add Solana" mean editing this file.
 *
 * Uses the free/Demo API (`x-cg-demo-api-key`): the /coins/{id}/market_chart/range
 * endpoint returns a price time-series for a window in ONE call (fewer calls than
 * per-day /history for a 30-day backfill). CoinGecko auto-selects granularity —
 * for a ≤90-day range it's ~hourly — so we bucket points by UTC calendar date and
 * take the LAST point of each day as that day's "close" (crypto trades 24/7).
 *
 * Failure (429 / non-2xx / network / no key) is a normal, non-fatal outcome:
 * returns []. The caller (lib/crypto/btc-price.ts) writes whatever it gets through
 * the same insert-only priceArchive the stock backfill uses.
 */

import { PriceBasis } from "@prisma/client";
import type {
  PriceFetchRequest, PriceProviderAdapter, PriceResult, ProviderRoutingKey,
} from "../types";

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

/**
 * INSTRUMENT CONFIGURATION — ticker symbol → CoinGecko coin id.
 *
 * This is the whole of "instrument configuration" in the Solana-readiness
 * criterion: supporting a second crypto asset is one line here plus an
 * Instrument row with that ticker. No new service, no new call site, no new
 * archive path.
 */
export const COINGECKO_COIN_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
};

/** The coin id for a ticker, or null when this vendor cannot serve it. */
export function coinIdForSymbol(providerSymbol: string): string | null {
  return COINGECKO_COIN_IDS[providerSymbol.trim().toUpperCase()] ?? null;
}

export interface CoinDailyClose {
  dateISO: string; // "YYYY-MM-DD" (UTC)
  price:   number; // USD close (last point of the UTC day)
}

/** Injectable fetch (tests). Minimal response shape. */
export interface CoinGeckoHttpResponse {
  ok:     boolean;
  status: number;
  json(): Promise<unknown>;
}
export type CoinGeckoFetch = (url: string, init: { headers: Record<string, string> }) => Promise<CoinGeckoHttpResponse>;

export interface CoinGeckoOptions {
  apiKey?:    string;         // default: process.env.COINGECKO_API_KEY
  baseUrl?:   string;         // tests
  fetchImpl?: CoinGeckoFetch; // tests
}

/**
 * Daily <coin>/USD closes over [fromISO, toISO] inclusive, one point per UTC day.
 * Empty on any failure or when no API key is configured (dark no-op).
 */
export async function fetchCoinDailyClosesUsd(
  coinId:  string,
  fromISO: string,
  toISO:   string,
  opts:    CoinGeckoOptions = {},
): Promise<CoinDailyClose[]> {
  const apiKey = opts.apiKey ?? process.env.COINGECKO_API_KEY;
  if (!apiKey) return [];

  const baseUrl = opts.baseUrl ?? COINGECKO_BASE_URL;
  const doFetch: CoinGeckoFetch =
    opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<CoinGeckoHttpResponse>);

  // Widen the lower bound by a day so the first requested day has coverage even
  // if its earliest hourly point lands just after 00:00 UTC.
  const fromSec = Math.floor(Date.parse(`${fromISO}T00:00:00Z`) / 1000) - 86_400;
  const toSec   = Math.floor(Date.parse(`${toISO}T23:59:59Z`) / 1000);

  const url =
    `${baseUrl}/coins/${encodeURIComponent(coinId)}/market_chart/range` +
    `?vs_currency=usd&from=${fromSec}&to=${toSec}`;

  let res: CoinGeckoHttpResponse;
  try {
    res = await doFetch(url, { headers: { "Content-Type": "application/json", "x-cg-demo-api-key": apiKey } });
  } catch (e) {
    console.warn(`[prices][coingecko] network error for ${coinId} [${fromISO}..${toISO}]:`, e instanceof Error ? e.message : e);
    return [];
  }
  if (!res.ok) {
    const detail = res.status === 429 ? "rate-limited (429)" : `HTTP ${res.status}`;
    console.warn(`[prices][coingecko] ${detail} for ${coinId} [${fromISO}..${toISO}]`);
    return [];
  }

  let body: unknown;
  try { body = await res.json(); } catch { return []; }
  const prices = (body as { prices?: unknown })?.prices;
  if (!Array.isArray(prices)) return [];

  // Bucket [tsMs, price] points by UTC date; last point of each day = close.
  const lastByDate = new Map<string, number>();
  for (const point of prices as [number, number][]) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [tsMs, price] = point;
    if (typeof tsMs !== "number" || typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const dateISO = new Date(tsMs).toISOString().slice(0, 10);
    if (dateISO < fromISO || dateISO > toISO) continue;
    lastByDate.set(dateISO, price); // points are chronological → last write wins = close
  }

  return [...lastByDate.entries()]
    .map(([dateISO, price]) => ({ dateISO, price }))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

/**
 * The CoinGecko PriceProviderAdapter — crypto acquisition on the SAME registry
 * path as equities.
 *
 * `supportsInstrument` declares capability explicitly: CRYPTO asset class, on
 * RAW_CLOSE, with a ticker present in COINGECKO_COIN_IDS. Routing asks that
 * question and never tries the adapter to discover the answer, so a Tiingo call
 * is never wasted on BTC and adding a coin id cannot change how any other
 * instrument is routed.
 *
 * Basis note: BTC is stored as RAW_CLOSE, not CRYPTO_DAILY — that basis is
 * declared in config.ts but unused, and the archive holds zero non-RAW_CLOSE
 * rows. Serving RAW_CLOSE preserves existing behaviour exactly; changing the
 * basis would orphan every stored crypto price.
 */
export function createCoinGeckoPriceProvider(
  apiKey: string,
  opts:   CoinGeckoOptions & { source?: string; historicalDepth?: string } = {},
): PriceProviderAdapter {
  const source          = opts.source ?? "coingecko";
  // CoinGecko's BTC series begins 2013-04-28; the Demo tier serves ~365 days,
  // but depth is a capability statement, not a tier limit. Tier truncation
  // surfaces as fewer returned rows, which coverage reports as a remaining gap.
  const historicalDepth = opts.historicalDepth ?? "2013-04-28";

  return {
    source,
    historicalDepth,
    supportedBases() {
      return [PriceBasis.RAW_CLOSE];
    },
    supportsInstrument(key: ProviderRoutingKey): boolean {
      return key.assetClass === "CRYPTO"
        && key.basis === PriceBasis.RAW_CLOSE
        && coinIdForSymbol(key.providerSymbol) !== null;
    },
    async fetchDailyCloses(req: PriceFetchRequest): Promise<PriceResult[]> {
      // Routing already gated on capability; guard defensively.
      if (req.basis !== PriceBasis.RAW_CLOSE) return [];
      const coinId = coinIdForSymbol(req.providerSymbol);
      if (!coinId) return [];

      const closes = await fetchCoinDailyClosesUsd(coinId, req.fromISO, req.toISO, { ...opts, apiKey });
      return closes.map((c) => ({
        instrumentId: req.instrumentId,
        dateISO:      c.dateISO,
        basis:        PriceBasis.RAW_CLOSE,
        price:        c.price,
        currency:     "USD",
      }));
    },
  };
}
