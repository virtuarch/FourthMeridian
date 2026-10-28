/**
 * lib/prices/token-history-prices.ts
 *
 * TOKEN HISTORICAL PRICES — the wiring of `TOKEN_HISTORICAL_PRICE_SEAM`
 * (lib/prices/providers/coingecko.ts). GENERIC BY ASSET KEY: the CoinGecko
 * platform comes from the token's CAIP-19 key (SPL → "solana", ERC-20 →
 * "ethereum"), so both chains' history PRs use this one path.
 *
 *   · RAW_CLOSE rows into the shared PriceObservation archive, INSERT-ONLY
 *     (createMany skipDuplicates on the (instrument, date, basis) anchor) and
 *     CLOSED DATES ONLY (≤ yesterday UTC) — the archive doctrine (archive.ts).
 *   · Never invented: a contract the vendor does not list (404) or a range it
 *     returns empty is simply UNPRICED for those days — not valued, never 0.
 *   · Bounded by the Demo window (COINGECKO_HISTORY_DAYS, default 365) and by
 *     the shared COINGECKO budget (read before spend; unreadable ⇒ spend
 *     nothing; paced; metered) — lib/prices/coingecko-budget.ts.
 *   · Deduplicated across customers: the requested interval is remembered on
 *     the token's InstrumentAlias metadata (`priceHistory`, no migration), so a
 *     token held by a thousand wallets is fetched once, then only its new tail.
 *   · Thin/unlisted current quotes (the quote marker) are never valued, so they
 *     are never fetched historically either.
 *
 * Takes `client` explicitly. Never throws for provider failures (an outcome).
 */

import { PriceBasis, type Prisma, type PrismaClient } from "@prisma/client";
import { parseTokenAssetKey, coinGeckoPlatformFor } from "@/lib/crypto/token-asset";
import {
  fetchCoinGeckoTokenDailyClosesUsd, resolveCoinGeckoFloorISO, resolveCoinGeckoHistoryDays,
} from "@/lib/prices/providers/coingecko";
import { defaultCoinGeckoBudget, type CoinGeckoBudget } from "@/lib/prices/coingecko-budget";
import { readTokenQuoteMarker } from "@/lib/prices/current-quotes";
import { yesterdayUTCISO } from "@/lib/prices/config";

type Client = PrismaClient | Prisma.TransactionClient;

/** PriceObservation.source on contract-addressed historical token closes. */
export const TOKEN_HISTORY_PRICE_SOURCE = "coingecko:token_market_chart";
/** Do not re-ask for a range the vendor returned nothing for within this window. */
export const EMPTY_RETRY_MS = 24 * 3_600_000;

/** The durable per-token marker on the alias: what was requested, and what came back. */
export interface TokenPriceHistoryMarker { fromISO: string; toISO: string; attemptedAt: string; outcome: "OK" | "EMPTY" | "UNLISTED" }

export function readPriceHistoryMarker(metadata: unknown): TokenPriceHistoryMarker | null {
  const m = (metadata as { priceHistory?: Partial<TokenPriceHistoryMarker> } | null)?.priceHistory;
  if (!m || typeof m.fromISO !== "string" || typeof m.toISO !== "string" || typeof m.attemptedAt !== "string") return null;
  if (m.outcome !== "OK" && m.outcome !== "EMPTY" && m.outcome !== "UNLISTED") return null;
  return m as TokenPriceHistoryMarker;
}

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * PURE — the one request to send, or null. The wanted interval is the caller's
 * licensed [fromISO, toISO] clamped to [vendor floor, yesterday]. A marker that
 * already covers it ⇒ nothing; one covering its start ⇒ only the new tail; an
 * EMPTY/UNLISTED answer within the retry window ⇒ nothing.
 */
export function planTokenPriceRequest(
  want: { fromISO: string; toISO: string },
  ctx: { floorISO: string; yesterdayISO: string; marker: TokenPriceHistoryMarker | null; nowMs: number },
): { fromISO: string; toISO: string } | null {
  const from = want.fromISO > ctx.floorISO ? want.fromISO : ctx.floorISO;
  const to = want.toISO < ctx.yesterdayISO ? want.toISO : ctx.yesterdayISO;
  if (from > to) return null;
  const m = ctx.marker;
  if (m && m.outcome !== "OK" && ctx.nowMs - Date.parse(m.attemptedAt) < EMPTY_RETRY_MS) return null;
  if (m && m.outcome === "OK" && m.fromISO <= from) {
    if (m.toISO >= to) return null;
    const tail = addDay(m.toISO, 1);
    return { fromISO: tail > from ? tail : from, toISO: to };
  }
  return { fromISO: from, toISO: to };
}

export interface TokenHistoryPriceOutcome {
  status: "INSERTED" | "NOTHING_TO_DO" | "UNLISTED" | "EMPTY" | "NOT_CONFIGURED" | "BUDGET" | "THIN_OR_UNPRICED" | "FAILED";
  inserted: number;
  /** Earliest close date returned (when anything was inserted). */
  earliestISO: string | null;
  calls: number;
  detail?: string;
}

export async function acquireTokenHistoricalCloses(args: {
  client: Client;
  instrumentId: string;
  assetKey: string;
  fromISO: string;
  toISO: string;
  budget?: CoinGeckoBudget;
  fetchCloses?: typeof fetchCoinGeckoTokenDailyClosesUsd;
  now?: Date;
  historyDays?: number;
}): Promise<TokenHistoryPriceOutcome> {
  const none = (status: TokenHistoryPriceOutcome["status"], detail?: string): TokenHistoryPriceOutcome => ({ status, inserted: 0, earliestISO: null, calls: 0, ...(detail ? { detail } : {}) });
  const parsed = parseTokenAssetKey(args.assetKey);
  if (!parsed) return none("FAILED", "not a token asset key");
  if (!args.fetchCloses && !process.env.COINGECKO_API_KEY?.trim()) return none("NOT_CONFIGURED");
  const now = args.now ?? new Date();
  const client = args.client;
  const where = { provider_externalId: { provider: "crypto", externalId: args.assetKey } };
  const alias = await client.instrumentAlias.findUnique({ where, select: { metadata: true } });
  const quote = readTokenQuoteMarker(alias?.metadata);
  // Only a token with a liquid current market is valued — and so only it is priced historically.
  if (!quote?.pricedAt || quote.outcome === "THIN") return none("THIN_OR_UNPRICED");

  let historyDays: number;
  try { historyDays = args.historyDays ?? resolveCoinGeckoHistoryDays(process.env.COINGECKO_HISTORY_DAYS); }
  catch (e) { return none("FAILED", e instanceof Error ? e.message : String(e)); }
  const yesterdayISO = yesterdayUTCISO(now);
  const floorISO = resolveCoinGeckoFloorISO(addDay(yesterdayISO, 1), historyDays);
  const marker = readPriceHistoryMarker(alias?.metadata);
  const req = planTokenPriceRequest({ fromISO: args.fromISO, toISO: args.toISO }, { floorISO, yesterdayISO, marker, nowMs: now.getTime() });
  if (!req) return none("NOTHING_TO_DO");

  const budget = args.budget ?? defaultCoinGeckoBudget(client);
  const remaining = await budget.remaining();
  if (remaining === null || remaining < 1) return none("BUDGET", remaining === null ? "CoinGecko budget unreadable — nothing spent" : "CoinGecko daily budget reached");

  const meter: Record<string, number> = {};
  let result: Awaited<ReturnType<typeof fetchCoinGeckoTokenDailyClosesUsd>>;
  try {
    await budget.pace();
    result = await (args.fetchCloses ?? fetchCoinGeckoTokenDailyClosesUsd)(coinGeckoPlatformFor(parsed.standard), parsed.contract, req.fromISO, req.toISO, { meter, deploymentFloorISO: floorISO });
  } catch (e) {
    await budget.record(meter);
    return { ...none("FAILED", e instanceof Error ? e.message : String(e)), calls: 1 };
  }
  await budget.record(meter);
  const calls = Object.values(meter).reduce((a, b) => a + b, 0);
  if (!result.configured) return none("NOT_CONFIGURED");

  const closes = result.closes.filter((c) => c.dateISO >= req.fromISO && c.dateISO <= yesterdayISO && Number.isFinite(c.price) && c.price > 0);
  const outcome: TokenPriceHistoryMarker["outcome"] = result.unlisted ? "UNLISTED" : closes.length === 0 ? "EMPTY" : "OK";
  let inserted = 0;
  if (closes.length > 0) {
    const r = await client.priceObservation.createMany({
      data: closes.map((c) => ({
        instrumentId: args.instrumentId, date: new Date(`${c.dateISO}T00:00:00.000Z`), price: c.price,
        currency: "USD", basis: PriceBasis.RAW_CLOSE, source: TOKEN_HISTORY_PRICE_SOURCE,
      })),
      skipDuplicates: true,
    });
    inserted = r.count;
  }
  // The marker records what was ASKED and answered; an OK range extends the one it continued.
  const nextMarker: TokenPriceHistoryMarker = outcome === "OK"
    ? { fromISO: marker?.outcome === "OK" && marker.fromISO <= req.fromISO ? marker.fromISO : req.fromISO, toISO: req.toISO, attemptedAt: now.toISOString(), outcome }
    : { fromISO: marker?.fromISO ?? req.fromISO, toISO: marker?.toISO ?? req.toISO, attemptedAt: now.toISOString(), outcome };
  try {
    const existing = (alias?.metadata && typeof alias.metadata === "object" ? alias.metadata : {}) as Record<string, unknown>;
    await client.instrumentAlias.update({ where, data: { metadata: { ...existing, priceHistory: nextMarker } as unknown as Prisma.InputJsonValue } });
  } catch { /* an optimisation; the insert-only archive already dedupes */ }
  return {
    status: outcome === "OK" ? (inserted > 0 ? "INSERTED" : "NOTHING_TO_DO") : outcome,
    inserted, earliestISO: inserted > 0 ? closes[0].dateISO : null, calls,
  };
}
