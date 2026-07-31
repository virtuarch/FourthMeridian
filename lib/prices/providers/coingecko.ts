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
import { ProviderFetchError } from "../provider-errors";
import { minusDaysISO, toISODateUTC } from "../config";

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

/**
 * The earliest date that exists anywhere in CoinGecko's BTC dataset. An ABSOLUTE
 * LOWER BOUND on the deployment floor, never the floor itself — see
 * resolveCoinGeckoFloorISO.
 */
export const COINGECKO_DATASET_START = "2013-04-28";

/**
 * Days of history the DEMO tier serves, per CoinGecko's documentation. The
 * default is deliberately the most restrictive supported tier: possession of an
 * API key does NOT imply a paid plan, and inferring one would reintroduce the
 * exact defect V26-PRICE-4C exists to remove. A paid deployment must say so by
 * setting COINGECKO_HISTORY_DAYS.
 */
export const COINGECKO_DEFAULT_HISTORY_DAYS = 365;

/**
 * Parse COINGECKO_HISTORY_DAYS. Absent or blank ⇒ the Demo default; anything
 * present but not a positive integer THROWS rather than silently falling back —
 * a typo that quietly restored a wrong capability is precisely the class of bug
 * this slice closes.
 */
export function resolveCoinGeckoHistoryDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return COINGECKO_DEFAULT_HISTORY_DAYS;
  const text = raw.trim();
  // PLAIN DECIMAL DIGITS ONLY. Number() would accept "1e3", "0x10" and " 12 " as
  // integers; for deployment configuration that is surprising rather than
  // permissive, and this value decides how much history the system believes it
  // can obtain. An unambiguous grammar makes "malformed" unambiguous too.
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `[prices][coingecko] COINGECKO_HISTORY_DAYS must be a positive integer in plain ` +
      `decimal digits (got "${raw}")`,
    );
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `[prices][coingecko] COINGECKO_HISTORY_DAYS must be a positive integer (got "${raw}")`,
    );
  }
  return n;
}

/**
 * The earliest date this CONFIGURED deployment can serve.
 *
 * ── Inclusive semantics, stated exactly ──────────────────────────────────────
 * The floor is the date exactly `historyDays` days before the given UTC today,
 * and that date IS servable. With historyDays = 365 and utcToday = 2026-07-31:
 *
 *     floor = 2025-07-31   ← servable (2025-07-31 + 365 days = 2026-07-31)
 *     2025-07-30           ← NOT servable
 *
 * There is no off-by-one ambiguity: the window is "365 days ago" measured as
 * date arithmetic, not "the last 365 dates". Fixtures pin both sides.
 *
 * Clamped at COINGECKO_DATASET_START so a very large configured window cannot
 * claim history that does not exist at any tier.
 *
 * UTC arithmetic only, and the caller supplies `utcTodayISO` — no clock is read
 * here, so the function is pure and fixture-testable.
 */
export function resolveCoinGeckoFloorISO(utcTodayISO: string, historyDays: number): string {
  const windowFloor = minusDaysISO(utcTodayISO, historyDays);
  return windowFloor > COINGECKO_DATASET_START ? windowFloor : COINGECKO_DATASET_START;
}

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
  /**
   * The adapter's declared deployment floor, used ONLY to classify an
   * authorization failure: a 401/403 for a window that predates what this tier
   * can serve is a CAPABILITY limit, not a credential fault. Absent ⇒ every
   * 401/403 is treated as a credential fault.
   */
  deploymentFloorISO?: string;
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
    // V26-PRICE-4 — this used to return [], which made a rate-limited backfill
    // look exactly like a complete one. Failures are now typed and classified.
    console.warn(`[prices][coingecko] network error for ${coinId} [${fromISO}..${toISO}]:`, e instanceof Error ? e.message : e);
    throw new ProviderFetchError("PROVIDER_ERROR",
      `coingecko: network error for ${coinId} — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const detail = res.status === 429 ? "rate-limited (429)" : `HTTP ${res.status}`;
    console.warn(`[prices][coingecko] ${detail} for ${coinId} [${fromISO}..${toISO}]`);
    // V26-PRICE-4C — an authorization failure for a window BELOW this
    // deployment's floor is a capability limit, not a credential fault. The
    // distinction is operational: PROVIDER_LIMIT is permanent until the tier
    // changes and is never retried, while PROVIDER_ERROR is retryable and would
    // otherwise hammer a wall the key can never pass.
    const authFailure = res.status === 401 || res.status === 403;
    const belowFloor = opts.deploymentFloorISO !== undefined && fromISO < opts.deploymentFloorISO;
    const code =
      res.status === 429 ? "THROTTLED"
      : authFailure && belowFloor ? "PROVIDER_LIMIT"
      : "PROVIDER_ERROR";
    throw new ProviderFetchError(code,
      code === "PROVIDER_LIMIT"
        ? `coingecko: ${detail} for ${coinId} — window ${fromISO} predates the configured ` +
          `deployment floor ${opts.deploymentFloorISO}; not retryable until the tier changes`
        : `coingecko: ${detail} for ${coinId}`);
  }

  let body: unknown;
  try { body = await res.json(); }
  catch { throw new ProviderFetchError("INVALID_DATA", `coingecko: unparseable response for ${coinId}`); }
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
  opts:   CoinGeckoOptions & {
    source?: string;
    /** Explicit override; otherwise computed from historyDays + now. */
    historicalDepth?: string;
    /** Configured deployment window. Default: COINGECKO_HISTORY_DAYS, else Demo. */
    historyDays?: number;
    /** Injected clock for tests. Default: the process's current UTC date. */
    now?: Date;
  } = {},
): PriceProviderAdapter {
  const source = opts.source ?? "coingecko";

  // V26-PRICE-4C — historicalDepth is DEPLOYMENT capability: "the earliest date
  // THIS CONFIGURED adapter can currently serve". It previously advertised the
  // dataset start (2013-04-28), which is true of CoinGecko's data and false of
  // the Demo tier, so coverage classified a decade of dates as actionable that
  // no request under this key could ever obtain — three of them returned 401 in
  // the live run. The floor MOVES with the calendar, so it is resolved here at
  // the construction edge; the planner stays pure and receives it as data.
  const historyDays = opts.historyDays ?? resolveCoinGeckoHistoryDays(process.env.COINGECKO_HISTORY_DAYS);
  const utcTodayISO = toISODateUTC(opts.now ?? new Date());
  const historicalDepth = opts.historicalDepth ?? resolveCoinGeckoFloorISO(utcTodayISO, historyDays);

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

      const closes = await fetchCoinDailyClosesUsd(coinId, req.fromISO, req.toISO, {
        ...opts, apiKey, deploymentFloorISO: historicalDepth,
      });
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
