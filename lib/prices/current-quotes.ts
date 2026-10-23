/**
 * lib/prices/current-quotes.ts — the CURRENT crypto quote store (server).
 *
 * The pure contract is lib/prices/current-quote.core.ts; read it first.
 *
 * ── Representation ───────────────────────────────────────────────────────────
 * A quote is a `PriceObservation` row with `basis: INTRADAY` — the basis the
 * schema already reserved "within-session price" for. It lives in the same
 * table as the closes but on a basis NO historical reader requests: every dated
 * valuation reads RAW_CLOSE (valuation.ts, crypto-price-window.ts,
 * regenerate-history), so a quote cannot leak into reconstruction.
 *
 * One row per (instrument, UTC market date, INTRADAY) — the table's existing
 * uniqueness — holding the LATEST quote of that day. Writes are MONOTONIC: an
 * older quote never overwrites a newer one, whichever sync lands last.
 *
 * ⚠️ For INTRADAY rows `fetchedAt` records the PROVIDER's attested instant
 * (CoinGecko `last_updated_at`), not our fetch time. A quote without its instant
 * is not a price, the row has no other instant column, and adding one is a
 * migration of the canonical database this slice may not make. The meaning is
 * stated here, at the only writer, and on the schema field.
 *
 * This module deliberately does NOT go through `priceArchive.append`, whose
 * closed-date guard (`assertClosedDateISO`) is correct for closes and stays
 * exactly as strict: quotes get their own narrow writer, not a weakened guard.
 */

import "server-only";
import { PriceBasis, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { lookupCryptoInstrumentId } from "@/lib/crypto/crypto-price-window";
import { nativeAssetForChain } from "@/lib/crypto/native-asset";
import { fetchCoinGeckoCurrentQuotes } from "@/lib/prices/providers/coingecko";
import { quoteDateISO, type CurrentQuote } from "@/lib/prices/current-quote.core";

type Client = PrismaClient | Prisma.TransactionClient;

export const CURRENT_QUOTE_SOURCE = "coingecko:simple_price";

/** A stored quote, bound to its instrument. */
export interface StoredQuote {
  instrumentId: string;
  priceUsd:     number;
  quotedAt:     Date;
}

/**
 * Persist validated quotes as INTRADAY rows. Returns the instruments whose
 * stored quote CHANGED (the input to snapshot regeneration: a value moved).
 */
export async function writeCurrentQuotes(
  bound: ReadonlyArray<CurrentQuote & { instrumentId: string }>,
  client: Client = db,
): Promise<string[]> {
  const changed: string[] = [];
  for (const q of bound) {
    const date = new Date(`${quoteDateISO(q.quotedAt)}T00:00:00.000Z`);
    const key = { instrumentId_date_basis: { instrumentId: q.instrumentId, date, basis: PriceBasis.INTRADAY } };
    const existing = await client.priceObservation.findUnique({ where: key, select: { fetchedAt: true, price: true } });
    // MONOTONIC: never replace a newer quote with an older one.
    if (existing && existing.fetchedAt.getTime() >= q.quotedAt.getTime()) continue;
    await client.priceObservation.upsert({
      where:  key,
      create: { instrumentId: q.instrumentId, date, basis: PriceBasis.INTRADAY, price: q.priceUsd, currency: "USD", source: CURRENT_QUOTE_SOURCE, fetchedAt: q.quotedAt },
      update: { price: q.priceUsd, source: CURRENT_QUOTE_SOURCE, fetchedAt: q.quotedAt },
    });
    if (!existing || existing.price !== q.priceUsd) changed.push(q.instrumentId);
  }
  return changed;
}

/**
 * Today's stored quote per instrument (UTC market date = `todayISO`). An
 * instrument with no quote for today is ABSENT — the caller values it at the
 * last close and says so; nothing here substitutes.
 */
export async function readQuotesForDate(
  instrumentIds: readonly string[],
  todayISO: string,
  client: Client = db,
): Promise<Map<string, StoredQuote>> {
  const out = new Map<string, StoredQuote>();
  if (instrumentIds.length === 0) return out;
  const rows = await client.priceObservation.findMany({
    where:  { instrumentId: { in: [...instrumentIds] }, basis: PriceBasis.INTRADAY, date: new Date(`${todayISO}T00:00:00.000Z`), currency: "USD" },
    select: { instrumentId: true, price: true, fetchedAt: true },
  });
  for (const r of rows) out.set(r.instrumentId, { instrumentId: r.instrumentId, priceUsd: r.price, quotedAt: r.fetchedAt });
  return out;
}

export type QuoteRefreshOutcome =
  | { status: "REFRESHED"; instrumentIds: string[]; changedInstrumentIds: string[]; quotedAt: Date; startedAt: Date; durationMs: number }
  | { status: "UNAVAILABLE"; reason: string; startedAt: Date; durationMs: number }
  | { status: "NOT_CONFIGURED"; startedAt: Date; durationMs: number };

/**
 * Fetch and persist the current quote for each chain's NATIVE asset. Never
 * throws: a provider failure is an outcome (the value then falls back to the
 * last close, labelled), recorded by the caller as a stage.
 */
export async function refreshCurrentQuotesForChains(
  chains: readonly string[],
  opts: { client?: Client; fetchQuotes?: typeof fetchCoinGeckoCurrentQuotes; now?: Date } = {},
): Promise<QuoteRefreshOutcome> {
  const startedAt = new Date();
  const t0 = Date.now();
  const client = opts.client ?? db;
  const done = <T extends object>(o: T) => ({ ...o, startedAt, durationMs: Date.now() - t0 });
  try {
    const assets = [...new Map(chains.map((c) => nativeAssetForChain(c)).filter((a): a is NonNullable<typeof a> => a !== null).map((a) => [a.assetKey, a])).values()];
    if (assets.length === 0) return done({ status: "UNAVAILABLE" as const, reason: "no native asset for these chains" });

    const fetched = await (opts.fetchQuotes ?? fetchCoinGeckoCurrentQuotes)(assets.map((a) => a.symbol), { now: opts.now });
    if (!fetched.configured) return done({ status: "NOT_CONFIGURED" as const });

    const bound: Array<CurrentQuote & { instrumentId: string }> = [];
    const unbound: string[] = [];
    for (const q of fetched.quotes) {
      const asset = assets.find((a) => a.symbol.toUpperCase() === q.symbol.toUpperCase());
      const instrumentId = asset ? await lookupCryptoInstrumentId(asset, client) : null;
      if (instrumentId) bound.push({ ...q, instrumentId });
      else unbound.push(q.symbol);
    }
    const problems = [...fetched.rejected.map((r) => `${r.symbol}: ${r.reason}`), ...unbound.map((s) => `${s}: no canonical instrument`)];
    if (bound.length === 0) return done({ status: "UNAVAILABLE" as const, reason: problems.join("; ") || "no quote returned" });

    const changedInstrumentIds = await writeCurrentQuotes(bound, client);
    const quotedAt = new Date(Math.min(...bound.map((b) => b.quotedAt.getTime())));
    return done({ status: "REFRESHED" as const, instrumentIds: bound.map((b) => b.instrumentId), changedInstrumentIds, quotedAt });
  } catch (e) {
    return done({ status: "UNAVAILABLE" as const, reason: e instanceof Error ? e.message : String(e) });
  }
}
