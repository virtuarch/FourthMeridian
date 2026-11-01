/**
 * lib/prices/coingecko-budget.ts
 *
 * TOKEN HOLDINGS (PR-A, review fix 1) — THE COINGECKO SPEND GUARD.
 *
 * The Demo tier is ~10,000 calls/month for the WHOLE deployment, shared by the
 * native `/simple/price` current quotes and the contract-addressed token quotes.
 * Every CoinGecko CURRENT-quote request now goes through this guard:
 *
 *   1. READ BEFORE SPEND — today's COINGECKO calls from the durable
 *      ApiUsageCounter (the same counter the Alchemy budget uses, provider
 *      "COINGECKO"); against `COINGECKO_DAILY_CALL_CAP` (default 250/day ≈
 *      7,500/month, leaving headroom for the archive backfill). An UNREADABLE
 *      ledger is not "plenty": the caller spends nothing.
 *   2. METER — each request is counted in a RequestMeter and flushed into the
 *      counter (lib/usage/provider-budget recordProviderMeter).
 *   3. PACE — a per-process minimum spacing between requests
 *      (`COINGECKO_CALLS_PER_MINUTE`, default 20; Demo allows ~30/min).
 *
 * Bounded overshoot, stated: two concurrent syncs can both read the same
 * remaining figure. Each caller caps its own spend per call (the token path at
 * `WALLET_TOKEN_QUOTE_MAX`), so the overshoot is at most one call's allotment
 * per concurrent sync — a recheck-before-spend, not a reservation.
 *
 * The historical RAW_CLOSE backfill (lib/prices/backfill.ts) is NOT routed
 * through this guard in this PR; it is a separate, operator-scheduled path.
 */

import {
  recordProviderMeter, USAGE_UNIT_CALLS, usageDayBucket, type ProviderUsageClient, type RequestMeter,
} from "@/lib/usage/provider-budget";
import { todayUTCISO } from "@/lib/time/clock";

/** ApiUsageCounter.provider for CoinGecko requests. */
export const COINGECKO_USAGE_PROVIDER = "COINGECKO";
/** The metric namespace (`coingecko:<endpoint>`). */
export const COINGECKO_USAGE_NETWORK = "coingecko";

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

/** Env-configured, clamped. A bad value falls back to the default, never to "unlimited". */
export function coinGeckoBudgetConfig(env: Record<string, string | undefined> = process.env) {
  return {
    dailyCallCap:       num(env.COINGECKO_DAILY_CALL_CAP, 250, 0, 100_000),
    /**
     * Review fix (re-review 1) — the most of the daily cap TOKEN quotes may
     * spend. Native quotes always keep the rest: a wallet full of tokens can
     * never starve BTC/ETH/SOL pricing.
     */
    tokenShare:         num(env.COINGECKO_TOKEN_SHARE, 0.6, 0, 1),
    /** Skip a native /simple/price when every instrument's INTRADAY quote is younger than this. */
    nativeQuoteFreshMinutes: num(env.COINGECKO_NATIVE_QUOTE_FRESH_MINUTES, 30, 0, 24 * 60),
    /** Wall-time bound on token quoting inside one sync; the rest rotate to later syncs. */
    tokenQuoteDeadlineMs: num(env.WALLET_TOKEN_QUOTE_DEADLINE_MS, 8_000, 0, 60_000),
    callsPerMinute:     num(env.COINGECKO_CALLS_PER_MINUTE, 20, 1, 500),
    /** Skip a token whose stored INTRADAY quote is fresher than this (dedupe across customers). */
    tokenQuoteFreshHours: num(env.COINGECKO_TOKEN_QUOTE_FRESH_HOURS, 6, 0, 72),
    /** Do not re-ask for a contract the vendor did not list (or listed thin) within this window. */
    unlistedRetryHours: num(env.COINGECKO_UNLISTED_RETRY_HOURS, 24, 1, 24 * 30),
    /** Price-sanity floor — below EITHER, a token is "Not valued — thin market". */
    minVolume24hUsd:    num(env.WALLET_TOKEN_MIN_VOLUME_USD, 10_000, 0, 1e12),
    minMarketCapUsd:    num(env.WALLET_TOKEN_MIN_MARKET_CAP_USD, 1_000_000, 0, 1e15),
  };
}

/** The seam every guarded caller takes; production wires `defaultCoinGeckoBudget(client)`. */
export interface CoinGeckoBudget {
  /**
   * Calls still allowed today for this kind of quote, or null when the ledger
   * cannot be read (⇒ spend nothing). `token` is additionally capped at
   * `tokenShare` of the daily cap; `native` may use whatever remains.
   */
  remaining(kind?: "native" | "token"): Promise<number | null>;
  /** Flush a request meter into the durable counter. Never throws. */
  record(meter: Readonly<RequestMeter>): Promise<void>;
  /** Resolve when the next request may be sent. */
  pace(): Promise<void>;
}

/** The metric prefix every token-quote request is recorded under. */
export const TOKEN_QUOTE_METRIC_PREFIX = `${COINGECKO_USAGE_NETWORK}:simple/token_price`;
/**
 * Historical token closes (lib/prices/token-history-prices.ts) — counted in the
 * TOKEN share too. STABLE: every token-history caller (SPL now, ERC-20 next)
 * must meter its contract `market_chart/range` requests under this prefix and
 * spend `remaining("token")`, so token history never eats the native share.
 */
export const TOKEN_HISTORY_METRIC_PREFIX = `${COINGECKO_USAGE_NETWORK}:market_chart/range:`;

/**
 * Pure: remaining calls for a kind, given today's usage, or null for an
 * unreadable ledger. Tokens: min(cap − all, ⌊cap × share⌋ − tokens). Native:
 * cap − all — and because tokens can never exceed their share, native always
 * has at least ⌈cap × (1 − share)⌉ of the day.
 */
export function remainingCalls(
  used: { total: number; tokens: number } | null, cap: number, kind: "native" | "token" = "native", tokenShare = 1,
): number | null {
  if (used === null || !Number.isFinite(used.total) || !Number.isFinite(used.tokens)) return null;
  const all = Math.max(0, cap - used.total);
  if (kind === "native") return all;
  return Math.max(0, Math.min(all, Math.floor(cap * tokenShare) - used.tokens));
}

/** Today's COINGECKO usage, split token vs all. Null when unreadable. */
export async function coinGeckoUsageToday(client: ProviderUsageClient, dayISO: string): Promise<{ total: number; tokens: number } | null> {
  try {
    const rows = await client.apiUsageCounter.findMany({
      where:  { provider: COINGECKO_USAGE_PROVIDER, unit: USAGE_UNIT_CALLS, day: usageDayBucket(dayISO) },
      select: { metric: true, count: true },
    });
    let total = 0, tokens = 0;
    for (const r of rows) {
      const n = Number(r.count);
      if (!Number.isFinite(n) || n <= 0) continue;
      total += n;
      if (r.metric.startsWith(TOKEN_QUOTE_METRIC_PREFIX) || r.metric.startsWith(TOKEN_HISTORY_METRIC_PREFIX)) tokens += n;
    }
    return { total, tokens };
  } catch { return null; }
}

let lastCallAt = 0;
/** Per-process spacing between CoinGecko requests. */
export async function paceCoinGecko(callsPerMinute = coinGeckoBudgetConfig().callsPerMinute): Promise<void> {
  const gap = 60_000 / callsPerMinute;
  const wait = lastCallAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** The production budget, reading the counter through `client` (the sync path's owner client). */
export function defaultCoinGeckoBudget(client: unknown, env: Record<string, string | undefined> = process.env): CoinGeckoBudget {
  const cfg = coinGeckoBudgetConfig(env);
  return {
    async remaining(kind = "native") {
      const used = await coinGeckoUsageToday(client as ProviderUsageClient, todayUTCISO());
      return remainingCalls(used, cfg.dailyCallCap, kind, cfg.tokenShare);
    },
    async record(meter) {
      try { await recordProviderMeter(COINGECKO_USAGE_PROVIDER, COINGECKO_USAGE_NETWORK, meter); } catch { /* never fails a sync */ }
    },
    pace: () => paceCoinGecko(cfg.callsPerMinute),
  };
}
