/**
 * lib/investments/crypto-instrument.ts
 *
 * P2-6 — the ONE canonical identity rule for a self-custodied crypto asset. A
 * SIBLING of the Plaid resolver (instrument-resolver.ts) and the import resolver
 * (instrument-resolver-import.ts): each binds a provider's identity to a canonical
 * Instrument, all sharing the InstrumentAlias `@@unique([provider, externalId])`
 * doctrine so identity can never fork.
 *
 * The economic asset is Instrument identity; the wallet/xpub is custody
 * (FinancialAccount); the balance is a PositionObservation. So the SAME asset must
 * resolve to ONE canonical Instrument regardless of which wallet, how many
 * wallets, which provider, or a future Coinbase/import path holds it — never one
 * Instrument per wallet.
 *
 * Phase 0 flagged two disjoint, uncoordinated BTC minters:
 *   1. btc-sync.ts   → per-account `Holding(symbol="BTC")` (no Instrument link),
 *   2. btc-price.ts  → a GLOBAL `Instrument(tickerSymbol="BTC", assetClass=CRYPTO)`
 *                      the RAW_CLOSE price series (coingecko) is written against,
 *                      with NO alias and NO position link.
 * This module converges them: it is the single crypto Instrument minter, and it
 * ADOPTS the existing price Instrument (matched on the exact predicate btc-price's
 * `findFirst` uses) so the position spine and the price series share ONE row by
 * construction — the position writer's valuation finds the very prices the
 * backfill wrote. `resolveBtcInstrumentId` delegates here.
 *
 * Identity precedence (deterministic — identical inputs, identical decision):
 *   1. crypto alias  (provider="crypto", externalId=asset symbol) — O(1) repeats.
 *   2. adopt the legacy price Instrument (tickerSymbol=symbol, assetClass=CRYPTO),
 *      attaching the alias so every future resolve is step 1.
 *   3. create a fresh canonical Instrument + alias.
 *
 * Generic by design: `resolveCryptoInstrumentId(asset)` takes a CryptoAsset, so
 * ETH/SOL land by adding their descriptor — no BTC-specific branch. Only BTC is
 * defined today (BTC_ASSET); no other adapter is built in this slice.
 */

import { AssetClass, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

type Client = PrismaClient | Prisma.TransactionClient;

/** The InstrumentAlias namespace for canonical crypto-asset identity. */
export const CRYPTO_PROVIDER = "crypto";

/** A canonical crypto asset — the deterministic identity is its `symbol`. */
export interface CryptoAsset {
  /** Canonical asset symbol — the alias externalId AND the Instrument tickerSymbol. */
  symbol:   string;
  /** Human display name (Instrument.name). */
  name:     string;
  /** Quote currency the asset is priced/valued in (Instrument.currency, e.g. "USD"). */
  currency: string;
}

/** The only crypto asset this slice defines. ETH/SOL are future descriptors. */
export const BTC_ASSET: CryptoAsset = { symbol: "BTC", name: "Bitcoin", currency: "USD" };

// ─── Pure decision core (no I/O) ──────────────────────────────────────────────

export type CryptoResolution =
  | { action: "use";    instrumentId: string } // canonical alias already exists
  | { action: "adopt";  instrumentId: string } // legacy price Instrument → attach alias
  | { action: "create" };                       // nothing safe to reuse

/**
 * Pure precedence: alias hit wins; else adopt the legacy price Instrument; else
 * create. Deterministic — the DB binding just supplies the two lookups.
 */
export function decideCryptoResolution(input: {
  aliasInstrumentId:  string | null;
  legacyInstrumentId: string | null;
}): CryptoResolution {
  if (input.aliasInstrumentId)  return { action: "use",   instrumentId: input.aliasInstrumentId };
  if (input.legacyInstrumentId) return { action: "adopt", instrumentId: input.legacyInstrumentId };
  return { action: "create" };
}

// ─── DB binding ───────────────────────────────────────────────────────────────

/**
 * Resolve THE ONE canonical Instrument id for a crypto asset, creating identity +
 * alias only when nothing safe to reuse exists. Idempotent and dedupe-safe: the
 * alias `@@unique([provider, externalId])` refuses a second canonical mapping, so
 * concurrent creators converge — the loser re-reads the alias the winner wrote.
 * The legacy adoption is ordered by createdAt so a pre-existing duplicate resolves
 * deterministically to the OLDEST row (and is unified onto it via the alias).
 */
export async function resolveCryptoInstrumentId(
  asset: CryptoAsset,
  opts?: { client?: Client },
): Promise<string> {
  const client = opts?.client ?? db;

  // 1. Canonical alias — the deterministic fast path.
  const alias = await client.instrumentAlias.findUnique({
    where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.symbol } },
    select: { instrumentId: true },
  });

  // 2. Adopt the legacy price Instrument (btc-price.ts's get-or-create predicate),
  //    oldest-first so adoption is deterministic even if a prior duplicate exists.
  const legacy = alias
    ? null
    : await client.instrument.findFirst({
        where:   { tickerSymbol: asset.symbol, assetClass: AssetClass.CRYPTO },
        orderBy: { createdAt: "asc" },
        select:  { id: true },
      });

  const decision = decideCryptoResolution({
    aliasInstrumentId:  alias?.instrumentId ?? null,
    legacyInstrumentId: legacy?.id ?? null,
  });

  if (decision.action === "use") return decision.instrumentId;

  if (decision.action === "adopt") {
    // Attach the canonical alias to the adopted price Instrument (idempotent).
    await client.instrumentAlias.upsert({
      where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.symbol } },
      create: { instrumentId: decision.instrumentId, provider: CRYPTO_PROVIDER, externalId: asset.symbol, metadata: { adopted: true } },
      update: {},
    });
    return decision.instrumentId;
  }

  // 3. Create the canonical Instrument + alias in one atomic write. tickerSymbol +
  //    assetClass match btc-price's findFirst, so the price backfill adopts THIS
  //    row rather than minting a second one — the two paths converge either order.
  try {
    const created = await client.instrument.create({
      data: {
        tickerSymbol:     asset.symbol,
        name:             asset.name,
        assetClass:       AssetClass.CRYPTO,
        currency:         asset.currency,
        isCashEquivalent: false,
        aliases: { create: { provider: CRYPTO_PROVIDER, externalId: asset.symbol, metadata: {} } },
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    // Lost a concurrent create race — the alias unique fired and rolled the whole
    // nested create back (no orphan Instrument). Re-read the winner's alias.
    const won = await client.instrumentAlias.findUnique({
      where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.symbol } },
      select: { instrumentId: true },
    });
    if (won) return won.instrumentId;
    throw err;
  }
}

/** Convenience — the canonical BTC Instrument id. */
export function resolveCanonicalBtcInstrumentId(opts?: { client?: Client }): Promise<string> {
  return resolveCryptoInstrumentId(BTC_ASSET, opts);
}
