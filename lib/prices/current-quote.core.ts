/**
 * lib/prices/current-quote.core.ts — CURRENT crypto price: the pure contract.
 *
 * ── Why this exists (2026-09-21) ────────────────────────────────────────────
 * Every crypto wallet's "current" value was quantity × the latest RAW_CLOSE on
 * or before today — which, because the archive is append-only for CLOSED dates
 * (`assertClosedDateISO`), is at best YESTERDAY's close. It was labelled by the
 * QUANTITY's freshness ("LIVE"), so a correct 0.24060252 BTC read at 13:16 was
 * valued at the 09-20 close and shown $927 below the market, as if current.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * A CURRENT value is  current quantity × current quote,  with TWO clocks:
 *   quantity observed at   (FinancialAccount.lastUpdated — the wallet's clock)
 *   price as of            (the provider's attested quote instant)
 * Neither implies the other.
 *
 *   BASIS   A quote is the valuation basis for `asOf` only when asOf is TODAY
 *           (UTC) and the quote's market date is that same day. Day grain on
 *           purpose: the account read model and today's SpaceSnapshot then
 *           resolve the SAME persisted row whatever instant each is computed
 *           at, so they cannot disagree by construction. Otherwise the basis is
 *           LAST_CLOSE — the canonical RAW_CLOSE rule, unchanged — and says so.
 *
 *   CURRENT A quote may be PRESENTED as current only while its provider instant
 *           is within one WALLET refresh period of now. That is the same rule
 *           lib/freshness applies to balances (LIVE_WITHIN_DAYS = 1 = the bank
 *           cadence): "live" means inside the refresh promise. The period is
 *           read from the refresh-policy default, never restated here. Older
 *           same-day quotes are DELAYED and are shown with their instant.
 *
 * RAW_CLOSE stays the ONLY authority for dated historical valuation; quotes are
 * stored under PriceBasis.INTRADAY, which no historical reader requests.
 */

import { resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";

/** One validated current quote, before it is bound to an instrument. */
export interface CurrentQuote {
  /** Provider ticker (BTC, ETH, …) — the key the vendor mapping uses. */
  symbol:   string;
  priceUsd: number;
  /** The PROVIDER's attested instant for this price (CoinGecko last_updated_at). */
  quotedAt: Date;
}

export type QuoteRejection = { symbol: string; reason: string };

/**
 * A quote whose instant is in the future by more than this is malformed, not
 * early. Clock skew between us and the vendor is seconds; minutes is a bug.
 */
export const QUOTE_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * How long a quote may be PRESENTED as current: one wallet refresh period, from
 * the refresh-policy default (WALLET '6h'). Derived, not chosen.
 */
export const CURRENT_QUOTE_MAX_AGE_MS =
  resolveRefreshPolicy({ sourceKind: "WALLET" }, null).expectedEveryHours * 3_600_000;

/**
 * Parse a CoinGecko `/simple/price?…&include_last_updated_at=true` body into
 * validated quotes. The provider convention elsewhere in this module family is
 * "positive-finite or refused" — no outlier heuristics are invented here — plus
 * the one thing a quote has that a close does not: its instant, which must be
 * present, numeric and not in the future.
 */
export function parseSimplePriceQuotes(
  body: unknown,
  coinIdBySymbol: Readonly<Record<string, string>>,
  now: Date,
): { quotes: CurrentQuote[]; rejected: QuoteRejection[] } {
  const quotes: CurrentQuote[] = [];
  const rejected: QuoteRejection[] = [];
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const [symbol, coinId] of Object.entries(coinIdBySymbol)) {
    const entry = obj[coinId] as { usd?: unknown; last_updated_at?: unknown } | undefined;
    if (!entry || typeof entry !== "object") { rejected.push({ symbol, reason: "absent from response" }); continue; }
    const price = entry.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      rejected.push({ symbol, reason: `invalid price: ${String(price)}` });
      continue;
    }
    const ts = entry.last_updated_at;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
      rejected.push({ symbol, reason: "missing or malformed last_updated_at" });
      continue;
    }
    const quotedAt = new Date(ts * 1000);
    if (quotedAt.getTime() - now.getTime() > QUOTE_FUTURE_SKEW_MS) {
      rejected.push({ symbol, reason: `last_updated_at ${quotedAt.toISOString()} is in the future` });
      continue;
    }
    quotes.push({ symbol, priceUsd: price, quotedAt });
  }
  return { quotes, rejected };
}

/** The UTC market date a quote belongs to — the INTRADAY row's `date`. */
export function quoteDateISO(quotedAt: Date): string {
  return quotedAt.toISOString().slice(0, 10);
}

export type ValuationPriceBasis = "CURRENT_QUOTE" | "LAST_CLOSE";
export type PriceFreshness = "CURRENT" | "DELAYED" | "LAST_CLOSE";

export interface PriceProvenance {
  basis:     ValuationPriceBasis;
  /** ISO instant for a quote; "YYYY-MM-DD" close date for LAST_CLOSE. */
  asOf:      string;
  freshness: PriceFreshness;
}

/**
 * May a stored quote (its instant) serve as the valuation basis for `asOfISO`?
 * Only for TODAY, and only a quote from today's UTC market date.
 */
export function quoteServesAsOf(quotedAt: Date, asOfISO: string, now: Date): boolean {
  const todayISO = now.toISOString().slice(0, 10);
  return asOfISO === todayISO && quoteDateISO(quotedAt) === todayISO;
}

/** Provenance for a value priced from a quote: CURRENT inside the refresh period, else DELAYED. */
export function quoteProvenance(quotedAt: Date, now: Date): PriceProvenance {
  const age = now.getTime() - quotedAt.getTime();
  return {
    basis:     "CURRENT_QUOTE",
    asOf:      quotedAt.toISOString(),
    freshness: age <= CURRENT_QUOTE_MAX_AGE_MS ? "CURRENT" : "DELAYED",
  };
}

/** Provenance for a value priced from the archive's close — never current. */
export function closeProvenance(closeDateISO: string): PriceProvenance {
  return { basis: "LAST_CLOSE", asOf: closeDateISO, freshness: "LAST_CLOSE" };
}

/**
 * One line of presentation, shared by every surface so none invents its own.
 *   CURRENT     "Price as of 13:40 UTC"
 *   DELAYED     "Price delayed · as of 07:10 UTC"
 *   LAST_CLOSE  "At Sep 20 close"
 */
export function describePriceProvenance(p: PriceProvenance): string {
  if (p.basis === "LAST_CLOSE") {
    const d = new Date(`${p.asOf}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return `At ${d} close`;
  }
  const t = new Date(p.asOf).toISOString().slice(11, 16);
  return p.freshness === "CURRENT" ? `Price as of ${t} UTC` : `Price delayed · as of ${t} UTC`;
}

/**
 * ONE note for a headline that sums several wallets: the WEAKEST basis wins, so
 * a total that includes any close-priced wallet never reads as current.
 *   all CURRENT quotes   "Crypto at 13:40 UTC prices"      (oldest instant)
 *   any DELAYED quote    "Crypto prices delayed · 07:10 UTC"
 *   any LAST_CLOSE       "Crypto at Sep 20 close"           (oldest close)
 * Null when no wallet carries a price (nothing to disclose).
 */
export function summarizeCryptoPricing(provenances: readonly (PriceProvenance | null | undefined)[]): string | null {
  const ps = provenances.filter((p): p is PriceProvenance => !!p);
  if (ps.length === 0) return null;
  const closes = ps.filter((p) => p.basis === "LAST_CLOSE").map((p) => p.asOf).sort();
  if (closes.length > 0) return `Crypto ${describePriceProvenance(closeProvenance(closes[0])).replace(/^At /, "at ")}`;
  const oldest = ps.map((p) => p.asOf).sort()[0];
  const t = new Date(oldest).toISOString().slice(11, 16);
  return ps.some((p) => p.freshness !== "CURRENT") ? `Crypto prices delayed · ${t} UTC` : `Crypto at ${t} UTC prices`;
}
