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
  providerCallsOn, recordProviderMeter, type ProviderUsageClient, type RequestMeter,
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
  /** Calls still allowed today, or null when the ledger cannot be read (⇒ spend nothing). */
  remaining(): Promise<number | null>;
  /** Flush a request meter into the durable counter. Never throws. */
  record(meter: Readonly<RequestMeter>): Promise<void>;
  /** Resolve when the next request may be sent. */
  pace(): Promise<void>;
}

/** Pure: remaining calls given today's ledger total, or null for an unreadable ledger. */
export function remainingCalls(usedToday: number | null, cap: number): number | null {
  if (usedToday === null || !Number.isFinite(usedToday)) return null;
  return Math.max(0, cap - usedToday);
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
    async remaining() {
      try {
        const l = await providerCallsOn(client as ProviderUsageClient, COINGECKO_USAGE_PROVIDER, todayUTCISO());
        return remainingCalls(l ? l.solana + l.other : null, cfg.dailyCallCap);
      } catch { return null; }
    },
    async record(meter) {
      try { await recordProviderMeter(COINGECKO_USAGE_PROVIDER, COINGECKO_USAGE_NETWORK, meter); } catch { /* never fails a sync */ }
    },
    pace: () => paceCoinGecko(cfg.callsPerMinute),
  };
}
