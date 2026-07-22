/**
 * lib/prices/providers/coingecko.ts
 *
 * A8-3B (crypto) — CoinGecko daily BTC/USD history, dependency-free (Node fetch).
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

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";
const BTC_COIN_ID = "bitcoin";

export interface BtcDailyClose {
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
 * Daily BTC/USD closes over [fromISO, toISO] inclusive, one point per UTC day.
 * Empty on any failure or when no API key is configured (dark no-op).
 */
export async function fetchBtcDailyClosesUsd(
  fromISO: string,
  toISO:   string,
  opts:    CoinGeckoOptions = {},
): Promise<BtcDailyClose[]> {
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
    `${baseUrl}/coins/${BTC_COIN_ID}/market_chart/range` +
    `?vs_currency=usd&from=${fromSec}&to=${toSec}`;

  let res: CoinGeckoHttpResponse;
  try {
    res = await doFetch(url, { headers: { "Content-Type": "application/json", "x-cg-demo-api-key": apiKey } });
  } catch (e) {
    console.warn(`[prices][coingecko] network error for BTC [${fromISO}..${toISO}]:`, e instanceof Error ? e.message : e);
    return [];
  }
  if (!res.ok) {
    const detail = res.status === 429 ? "rate-limited (429)" : `HTTP ${res.status}`;
    console.warn(`[prices][coingecko] ${detail} for BTC [${fromISO}..${toISO}]`);
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
