/**
 * lib/crypto/crypto-price-window.ts
 *
 * W-M0 — THE PER-ASSET CRYPTO VALUATION READ.
 *
 * One window read, many assets, answered from memory. This is THE crypto
 * valuation read: `readBtcUsdWindow` (lib/crypto/btc-price.ts) generalised over
 * the asset dimension and then DELETED in W-M1a, because a reader that can only
 * ever answer for Bitcoin is not a valuation authority, it is the assumption
 * this arc exists to remove.
 *
 * ── NOT a second price authority ─────────────────────────────────────────────
 * Same `priceArchive`, same RAW_CLOSE basis, same `nearestOnOrBefore` walk-back,
 * same `maxStaleDays` ceiling, same USD pass-through, same "null rather than a
 * fabricated price". It resolves a set of instrument ids instead of one and
 * partitions the returned rows by instrument. Nothing about how a price is
 * chosen changes; only how many series are in flight.
 *
 * ── STRICTLY READ-ONLY — and that is a behavioural difference worth stating ──
 * The BTC reader this replaced resolved its instrument through
 * `resolveBtcInstrumentId`, which is a GET-OR-CREATE: reading BTC's price
 * history could mint the canonical BTC `Instrument` as a side effect. That is
 * defensible for the one asset the system syncs, and indefensible here — asking
 * "does this deployment have SOL prices?" must never CREATE a SOL instrument,
 * because an Instrument row is an identity claim and a valuation read has no
 * business making one.
 *
 * So resolution is a lookup, in the same precedence order the canonical minter
 * uses, and stops at "no": canonical alias on assetKey → a grandfathered
 * ticker match → null. An asset that resolves to nothing simply has no prices,
 * and every date answers null. The VALUATION output is identical either way (an
 * instrument that was just created has no price rows), so nothing observable
 * changes for BTC — only the side effect goes away.
 *
 * ── Why assetKeys and not instrument ids ─────────────────────────────────────
 * Because the valuation core keys prices by assetKey, which is the asset's
 * canonical identity (W-M1a). A caller holding instrument ids would have to
 * translate them back to identities to use the result, and that translation is
 * exactly where a mismatch would hide. Keying by SYMBOL — which this did before
 * W-M1a — would be worse still: two assets sharing a ticker would silently
 * overwrite one another in the map.
 */

import { PriceBasis, AssetClass } from "@prisma/client";
import { priceArchive } from "@/lib/prices/archive";
import { minusDaysISO } from "@/lib/prices/config";
import { nearestOnOrBefore } from "@/lib/data/nearest-on-or-before";
import {
  CRYPTO_PROVIDER, legacyTickerAdoptionPermitted, type CryptoAsset,
} from "@/lib/investments/crypto-instrument";
import { db } from "@/lib/db";
import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The default walk-back ceiling — the value the retired BTC reader used. Kept as
 * this module's own default rather than imported from PRICE_MAX_STALE_DAYS so
 * that the crypto valuation read stays pinned while the acquisition-side
 * constant remains free to move for its own reasons.
 */
const DEFAULT_MAX_STALE_DAYS = 7;

/**
 * Answers "the USD close for this asset on this date", keyed by canonical
 * assetKey. Null means NO PRICE REACHED THIS DAY — never zero, never another
 * asset's.
 */
export type CryptoPriceWindow = (assetKey: string, dateISO: string) => number | null;

/**
 * READ-ONLY resolution of a crypto asset to its canonical Instrument id.
 *
 * Mirrors `resolveCryptoInstrumentId`'s precedence EXACTLY — canonical alias on
 * assetKey first, then a ticker-matched pre-alias Instrument but ONLY for a
 * grandfathered asset, oldest-first — and stops before its third step, which
 * creates. The grandfather check is load-bearing here too: without it this read
 * would happily resolve native SOL to a token that merely shares the ticker and
 * value every Solana wallet at that token's price, while the minter refused.
 *
 * The ticker step is what keeps BTC working on data written before W-M1a, where
 * the only alias is the symbol-keyed one: the assetKey lookup misses, the ticker
 * match finds the same 378-row instrument, and no second BTC identity appears.
 *
 * Exported for the unit test that pins this precedence against the minter's.
 */
export async function lookupCryptoInstrumentId(
  asset:  CryptoAsset,
  client: Client,
): Promise<string | null> {
  const alias = await client.instrumentAlias.findUnique({
    where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.assetKey } },
    select: { instrumentId: true },
  });
  if (alias) return alias.instrumentId;

  if (!legacyTickerAdoptionPermitted(asset)) return null;

  const legacy = await client.instrument.findFirst({
    where:   { tickerSymbol: asset.symbol, assetClass: AssetClass.CRYPTO },
    orderBy: { createdAt: "asc" },
    select:  { id: true },
  });
  return legacy?.id ?? null;
}

/**
 * Load the RAW_CLOSE USD window for every named asset in ONE archive read, and
 * return a resolver that answers each (assetKey, date) from memory.
 *
 * The read is floored at `fromISO − maxStaleDays` so every date in
 * [fromISO, toISO] sees its full walk-back window.
 *
 * An asset with no Instrument and an asset with no stored prices are
 * indistinguishable to the caller and both answer null. That is correct: from a
 * valuation's point of view they are the same fact — no price reached this day —
 * and the acquisition layer, not this one, is where "unsupported" and "not yet
 * fetched" are told apart.
 */
export async function readCryptoUsdWindows(
  assets:       readonly CryptoAsset[],
  fromISO:      string,
  toISO:        string,
  opts?: { maxStaleDays?: number; client?: Client },
): Promise<CryptoPriceWindow> {
  const maxStaleDays = opts?.maxStaleDays ?? DEFAULT_MAX_STALE_DAYS;
  const client = opts?.client ?? db;

  // Deduped by IDENTITY, then ordered by it, so the read is deterministic.
  const wanted = [...new Map(assets.map((a) => [a.assetKey, a])).values()]
    .sort((a, b) => a.assetKey.localeCompare(b.assetKey));
  if (wanted.length === 0) return () => null;

  // assetKey → instrumentId, for the assets that actually have one.
  const idByKey = new Map<string, string>();
  for (const asset of wanted) {
    const id = await lookupCryptoInstrumentId(asset, client);
    if (id) idByKey.set(asset.assetKey, id);
  }
  if (idByKey.size === 0) return () => null;

  const floorISO = minusDaysISO(fromISO, maxStaleDays);
  const rows =
    (await priceArchive.readRange?.([...idByKey.values()], PriceBasis.RAW_CLOSE, floorISO, toISO)) ?? [];

  // Partition once, so the per-date resolution below is a scan of ONE asset's
  // series — never a scan of every asset's rows filtered by instrument, which
  // would make the cost quadratic in assets for no reason.
  const rowsByKey = new Map<string, typeof rows>();
  for (const [assetKey, instrumentId] of idByKey) {
    rowsByKey.set(assetKey, rows.filter((r) => r.instrumentId === instrumentId));
  }

  return (assetKey: string, dateISO: string): number | null => {
    const series = rowsByKey.get(assetKey);
    if (!series || series.length === 0) return null;
    const hit = nearestOnOrBefore(series, dateISO, (r) => r.dateISO, { maxStaleDays });
    return hit ? hit.price : null;
  };
}
