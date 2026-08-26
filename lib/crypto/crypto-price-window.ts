/**
 * lib/crypto/crypto-price-window.ts
 *
 * W-M0 — THE PER-ASSET CRYPTO VALUATION READ.
 *
 * One window read, many assets, answered from memory. This is
 * `readBtcUsdWindow` (lib/crypto/btc-price.ts) generalised over the asset
 * dimension, and it exists because the multi-asset valuation core needs a price
 * PER SYMBOL and the BTC reader can only ever answer for one.
 *
 * ── NOT a second price authority ─────────────────────────────────────────────
 * Same `priceArchive`, same RAW_CLOSE basis, same `nearestOnOrBefore` walk-back,
 * same `maxStaleDays` ceiling, same USD pass-through, same "null rather than a
 * fabricated price". It resolves a set of instrument ids instead of one and
 * partitions the returned rows by instrument. Nothing about how a price is
 * chosen changes; only how many series are in flight.
 *
 * ── STRICTLY READ-ONLY — and that is a behavioural difference worth stating ──
 * `readBtcUsdWindow` resolves its instrument through `resolveBtcInstrumentId`,
 * which is a GET-OR-CREATE: reading BTC's price history could mint the canonical
 * BTC `Instrument` as a side effect. That is defensible for the one asset the
 * system syncs, and indefensible here — asking "does this deployment have SOL
 * prices?" must never CREATE a SOL instrument, because an Instrument row is an
 * identity claim and a valuation read has no business making one.
 *
 * So resolution is a lookup, in the same precedence order the canonical minter
 * uses, and stops at "no": canonical alias → the legacy price instrument →
 * null. A symbol that resolves to nothing simply has no prices, and every date
 * answers null. The VALUATION output is identical either way (an instrument
 * that was just created has no price rows), so nothing observable changes for
 * BTC — only the side effect goes away.
 *
 * ── Why symbols and not instrument ids ───────────────────────────────────────
 * Because the valuation core keys prices by symbol, and the symbol is the one
 * token that is already the same string in `Transaction.currency`,
 * `Instrument.tickerSymbol` and `NativeAsset.symbol` (see native-asset.ts). A
 * caller that had instrument ids would have to translate them back to symbols to
 * use the result, and that translation is exactly where a mismatch would hide.
 */

import { PriceBasis, AssetClass } from "@prisma/client";
import { priceArchive } from "@/lib/prices/archive";
import { minusDaysISO } from "@/lib/prices/config";
import { nearestOnOrBefore } from "@/lib/data/nearest-on-or-before";
import { CRYPTO_PROVIDER } from "@/lib/investments/crypto-instrument";
import { db } from "@/lib/db";
import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The default walk-back ceiling, matching `readBtcUsdWindow`'s. Kept as this
 * module's own default rather than imported from PRICE_MAX_STALE_DAYS so the
 * two crypto valuation readers stay identical by construction while the
 * acquisition-side constant remains free to move for its own reasons.
 */
const DEFAULT_MAX_STALE_DAYS = 7;

/**
 * Answers "the USD close for this asset on this date", per symbol.
 * Null means NO PRICE REACHED THIS DAY — never zero, never another asset's.
 */
export type CryptoPriceWindow = (symbol: string, dateISO: string) => number | null;

/**
 * READ-ONLY resolution of a crypto asset symbol to its canonical Instrument id.
 *
 * Mirrors `resolveCryptoInstrumentId`'s precedence (canonical alias first, then
 * the legacy price Instrument matched on tickerSymbol + CRYPTO, oldest-first)
 * and stops before its third step, which creates. Exported for the unit test
 * that pins the precedence against the minter's.
 */
export async function lookupCryptoInstrumentId(
  symbol: string,
  client: Client,
): Promise<string | null> {
  const alias = await client.instrumentAlias.findUnique({
    where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: symbol } },
    select: { instrumentId: true },
  });
  if (alias) return alias.instrumentId;

  const legacy = await client.instrument.findFirst({
    where:   { tickerSymbol: symbol, assetClass: AssetClass.CRYPTO },
    orderBy: { createdAt: "asc" },
    select:  { id: true },
  });
  return legacy?.id ?? null;
}

/**
 * Load the RAW_CLOSE USD window for every named asset in ONE archive read, and
 * return a resolver that answers each (symbol, date) from memory.
 *
 * The read is floored at `fromISO − maxStaleDays` so every date in
 * [fromISO, toISO] sees its full walk-back window — the same flooring
 * `readBtcUsdWindow` performs, for the same reason.
 *
 * Unknown symbols, symbols with no Instrument, and symbols with no stored prices
 * are all indistinguishable to the caller and all answer null. That is correct:
 * from a valuation's point of view they are the same fact — no price reached
 * this day — and the acquisition layer, not this one, is where "unsupported"
 * and "not yet fetched" are told apart.
 */
export async function readCryptoUsdWindows(
  symbols:      readonly string[],
  fromISO:      string,
  toISO:        string,
  opts?: { maxStaleDays?: number; client?: Client },
): Promise<CryptoPriceWindow> {
  const maxStaleDays = opts?.maxStaleDays ?? DEFAULT_MAX_STALE_DAYS;
  const client = opts?.client ?? db;

  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort();
  if (wanted.length === 0) return () => null;

  // symbol → instrumentId, for the symbols that actually have one.
  const idBySymbol = new Map<string, string>();
  for (const symbol of wanted) {
    const id = await lookupCryptoInstrumentId(symbol, client);
    if (id) idBySymbol.set(symbol, id);
  }
  if (idBySymbol.size === 0) return () => null;

  const floorISO = minusDaysISO(fromISO, maxStaleDays);
  const rows =
    (await priceArchive.readRange?.([...idBySymbol.values()], PriceBasis.RAW_CLOSE, floorISO, toISO)) ?? [];

  // Partition once, so the per-date resolution below is a scan of ONE asset's
  // series — never a scan of every asset's rows filtered by instrument, which
  // would make the cost quadratic in assets for no reason.
  const rowsBySymbol = new Map<string, typeof rows>();
  for (const [symbol, instrumentId] of idBySymbol) {
    rowsBySymbol.set(symbol, rows.filter((r) => r.instrumentId === instrumentId));
  }

  return (symbol: string, dateISO: string): number | null => {
    const series = rowsBySymbol.get(symbol.trim().toUpperCase());
    if (!series || series.length === 0) return null;
    const hit = nearestOnOrBefore(series, dateISO, (r) => r.dateISO, { maxStaleDays });
    return hit ? hit.price : null;
  };
}
