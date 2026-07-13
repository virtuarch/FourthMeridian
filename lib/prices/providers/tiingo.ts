/**
 * lib/prices/providers/tiingo.ts
 *
 * A8-3B — the first REAL historical-price vendor adapter: Tiingo daily EOD.
 * Implements the PriceProviderAdapter seam (lib/prices/types.ts) exactly like
 * the fixture provider, so it drops into defaultPriceRegistry() without any
 * consumer change (fetch orchestration, backfill script, daily job all unchanged).
 *
 * Contract fit:
 *   - source "tiingo"; serves RAW_CLOSE only (Tiingo's `close` is the unadjusted
 *     close — `adjClose` is a separate basis we do not map here).
 *   - fetchDailyCloses hits GET /tiingo/daily/{ticker}/prices?startDate&endDate
 *     for ONE instrument over [fromISO, toISO], maps each row to a PriceResult
 *     keyed by the instrumentId it was asked about.
 *   - Instrument is a GLOBAL, CUSIP/ISIN-deduped table, so one fetch for NVDA
 *     serves every user holding NVDA — the API cost is per-security, not per-user.
 *
 * Failure handling (per the A8-3A adapter contract, "complete-or-throw"):
 *   - A 429 rate-limit or ANY non-2xx / network error is a NORMAL adapter
 *     failure: it is logged and thrown as a clean, symbol-scoped Error.
 *     fetchInstrumentWindow catches it, records the note, fails over / moves on,
 *     and the backfill or daily run continues to the next instrument — a vendor
 *     hiccup never crashes the whole run.
 *   - Individual malformed / non-positive rows are dropped (not thrown) so one
 *     bad day never discards an otherwise-good window (validateBatch would
 *     reject the entire batch on a single invalid row).
 *
 * Auth: TIINGO_API_KEY, passed in the Authorization header (never the query
 * string) so it can't leak into request logs. The registry only constructs this
 * adapter when the key is present, so `apiKey` here is always non-empty.
 */

import { PriceBasis } from "@prisma/client";
import type { PriceFetchRequest, PriceProviderAdapter, PriceResult } from "../types";

const TIINGO_BASE_URL = "https://api.tiingo.com";

/** The subset of Tiingo's daily-prices row this adapter reads. */
interface TiingoDailyRow {
  date:  string; // ISO datetime, e.g. "2026-07-10T00:00:00.000Z"
  close: number; // unadjusted close (quote currency; USD for US equities)
}

/** Minimal HTTP-response shape the adapter needs — lets tests inject a fake without a full Response. */
export interface TiingoHttpResponse {
  ok:     boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable fetch (default: global fetch). Tests pass a fake to avoid real network. */
export type TiingoFetch = (
  url:  string,
  init: { headers: Record<string, string> },
) => Promise<TiingoHttpResponse>;

export interface TiingoProviderOptions {
  source?:          string;
  historicalDepth?: string;
  /** Override the API base (tests). */
  baseUrl?:         string;
  /** Override the HTTP client (tests). */
  fetchImpl?:       TiingoFetch;
}

/**
 * Build a Tiingo daily-EOD adapter. `apiKey` must be non-empty (the registry
 * only constructs this when TIINGO_API_KEY is set).
 */
export function createTiingoPriceProvider(
  apiKey: string,
  opts:   TiingoProviderOptions = {},
): PriceProviderAdapter {
  const source          = opts.source ?? "tiingo";
  const historicalDepth = opts.historicalDepth ?? "1990-01-01";
  const baseUrl         = opts.baseUrl ?? TIINGO_BASE_URL;
  const doFetch: TiingoFetch =
    opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<TiingoHttpResponse>);

  return {
    source,
    historicalDepth,
    supportedBases() {
      // Tiingo `close` is unadjusted → RAW_CLOSE only. (adjClose would be a
      // separate ADJUSTED_CLOSE mapping; deliberately not served here.)
      return [PriceBasis.RAW_CLOSE];
    },
    async fetchDailyCloses(req: PriceFetchRequest): Promise<PriceResult[]> {
      // The orchestrator already gates on supportedBases(); guard defensively.
      if (req.basis !== PriceBasis.RAW_CLOSE) return [];

      const symbol = req.providerSymbol?.trim();
      // No ticker (e.g. a cash / no-symbol instrument) → nothing to ask Tiingo.
      // "No data", not a failure — return [] so the orchestrator moves on.
      if (!symbol) return [];

      const url =
        `${baseUrl}/tiingo/daily/${encodeURIComponent(symbol)}/prices` +
        `?startDate=${encodeURIComponent(req.fromISO)}` +
        `&endDate=${encodeURIComponent(req.toISO)}&format=json`;

      let res: TiingoHttpResponse;
      try {
        res = await doFetch(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization:  `Token ${apiKey}`,
          },
        });
      } catch (e) {
        // Network-level failure — a normal adapter failure.
        console.warn(`[prices][tiingo] network error for ${symbol} [${req.fromISO}..${req.toISO}]`);
        throw new Error(`tiingo: network error fetching ${symbol} — ${e instanceof Error ? e.message : String(e)}`);
      }

      if (!res.ok) {
        // 429 rate-limit or any non-2xx — a normal adapter failure. Logged +
        // thrown; fetchInstrumentWindow catches it and continues the run.
        const detail = res.status === 429 ? "rate-limited (429)" : `HTTP ${res.status}`;
        console.warn(`[prices][tiingo] ${detail} for ${symbol} [${req.fromISO}..${req.toISO}]`);
        throw new Error(`tiingo: ${detail} for ${symbol}`);
      }

      const body = await res.json();
      if (!Array.isArray(body)) {
        throw new Error(`tiingo: unexpected response shape for ${symbol} (expected a JSON array)`);
      }

      const out: PriceResult[] = [];
      for (const row of body as TiingoDailyRow[]) {
        if (!row || typeof row.date !== "string") continue;
        const dateISO = row.date.slice(0, 10);
        // Defensive window clamp — never trust the vendor to honor start/end.
        if (dateISO < req.fromISO || dateISO > req.toISO) continue;
        const price = row.close;
        // Drop (don't throw on) a malformed / non-positive close so one bad day
        // never discards the whole window in validateBatch.
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
        out.push({
          instrumentId: req.instrumentId,
          dateISO,
          basis:        req.basis, // RAW_CLOSE
          price,
          // Tiingo /tiingo/daily EOD prices are quoted in USD (US equities).
          currency:     "USD",
        });
      }
      return out;
    },
  };
}
