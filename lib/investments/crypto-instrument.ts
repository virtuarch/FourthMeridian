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
 * ── W-M1a — IDENTITY IS assetKey, NEVER THE TICKER ───────────────────────────
 * The alias `externalId` was the asset's SYMBOL, and step 2 adopted any
 * `Instrument(tickerSymbol=symbol, assetClass=CRYPTO)`. Both are ticker-as-
 * identity, and a ticker is not one: it is chosen by whoever mints the asset,
 * it is not unique, and for tokens it is attacker-controlled. Anyone can deploy
 * an ERC-20 called SOL. Under the old rule, minting that token's Instrument and
 * then resolving native Solana would have found it by ticker and ADOPTED IT as
 * the canonical SOL — every Solana wallet in the system silently repointed at a
 * scam contract's price series, with no error anywhere.
 *
 * Identity is now `assetKey`, a CAIP-19 asset id that names the chain and then
 * the asset on it (see lib/crypto/native-asset.ts). `tickerSymbol` is still
 * written, because display and denomination need it and the schema says plainly
 * what it is worth: "Display / weak identity — never the canonical primary key".
 *
 * Identity precedence (deterministic — identical inputs, identical decision):
 *   1. crypto alias  (provider="crypto", externalId=asset.assetKey) — O(1) repeats.
 *   2. adopt a pre-alias Instrument by ticker — ONLY for the closed, historical
 *      set in LEGACY_TICKER_ADOPTABLE, attaching the alias so every future
 *      resolve is step 1.
 *   3. create a fresh canonical Instrument + alias.
 *
 * Generic by design: `resolveCryptoInstrumentId(asset)` takes a CryptoAsset, so
 * a future ERC-20 lands by supplying `{assetKey: "eip155:1/erc20:0x…", …}` — no
 * new branch, and no way for it to reach step 2.
 */

import { AssetClass, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { BTC_NATIVE, ETH_NATIVE, SOL_NATIVE } from "@/lib/crypto/native-asset";

type Client = PrismaClient | Prisma.TransactionClient;

/** The InstrumentAlias namespace for canonical crypto-asset identity. */
export const CRYPTO_PROVIDER = "crypto";

/** A canonical crypto asset — the deterministic identity is its `assetKey`. */
export interface CryptoAsset {
  /**
   * THE identity: a CAIP-19 asset id, used verbatim as the InstrumentAlias
   * `externalId` under provider "crypto". Globally unique by construction, so
   * two assets may share a ticker forever without colliding.
   */
  assetKey: string;
  /**
   * Display ticker → `Instrument.tickerSymbol`. NOT identity: nothing resolves
   * by it, and `tickerSymbol` carries no unique constraint precisely because
   * duplicates are expected.
   */
  symbol:   string;
  /** Human display name (Instrument.name). */
  name:     string;
  /** Quote currency the asset is priced/valued in (Instrument.currency, e.g. "USD"). */
  currency: string;
}

/**
 * THE CLOSED, HISTORICAL SET OF ASSETS THAT MAY ADOPT A TICKER-MATCHED INSTRUMENT.
 *
 * Ticker adoption exists for exactly one reason: to absorb the global BTC
 * `Instrument(tickerSymbol="BTC", assetClass=CRYPTO)` that `btc-price.ts` minted
 * before canonical identity existed, so the position spine and the 378-row
 * RAW_CLOSE series converge on ONE row rather than forking. That instrument is a
 * finite historical artefact. The set of assets that predate canonical identity
 * cannot grow, because canonical identity now exists.
 *
 * So this is a grandfather list, not a policy. ETH and SOL are deliberately
 * ABSENT even though they are native assets we are about to support: there is no
 * pre-alias ETH or SOL instrument to absorb (verified — the crypto asset class
 * holds exactly one row, BTC), and admitting them would leave open the very
 * collision this slice closes. Never add to this set. A new asset gets a fresh
 * canonical Instrument keyed by its assetKey.
 */
export const LEGACY_TICKER_ADOPTABLE: ReadonlySet<string> = new Set<string>([BTC_NATIVE.assetKey]);

/** May this asset absorb a pre-alias Instrument that merely shares its ticker? */
export function legacyTickerAdoptionPermitted(asset: CryptoAsset): boolean {
  return LEGACY_TICKER_ADOPTABLE.has(asset.assetKey);
}

/**
 * The canonical native-asset descriptors.
 *
 * W-M0/W-M1a — these ARE the native-asset registry entries, not copies of them.
 * A `NativeAsset` structurally satisfies `CryptoAsset` (it adds `chain` and
 * `decimals`), so one declaration serves both the pure valuation layer and the
 * identity layer, and there is exactly ONE place that says what Bitcoin's
 * assetKey and ticker are. Declaring them twice would create precisely the
 * identity fork this module exists to prevent.
 *
 * ETH and SOL are declared HERE, in this slice, deliberately ahead of any
 * adapter that can sync them: identity is what a later adapter must resolve
 * INTO, and settling it first is what stops the adapter from inventing its own.
 * Nothing calls these yet.
 */
export const BTC_ASSET: CryptoAsset = BTC_NATIVE;
export const ETH_ASSET: CryptoAsset = ETH_NATIVE;
export const SOL_ASSET: CryptoAsset = SOL_NATIVE;

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
  /**
   * W-M1a — is this asset in the closed grandfather set? A ticker match alone is
   * NOT a reason to adopt, and the permission is carried explicitly rather than
   * inferred, so a future asset cannot acquire it by resembling an old one.
   * The binding additionally declines to even LOOK for a legacy row when this is
   * false, but the pure rule refuses independently: two refusals, not one.
   */
  legacyAdoptionPermitted: boolean;
}): CryptoResolution {
  if (input.aliasInstrumentId) return { action: "use", instrumentId: input.aliasInstrumentId };
  if (input.legacyInstrumentId && input.legacyAdoptionPermitted) {
    return { action: "adopt", instrumentId: input.legacyInstrumentId };
  }
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

  // 1. Canonical alias, keyed by assetKey — the deterministic fast path.
  const alias = await client.instrumentAlias.findUnique({
    where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.assetKey } },
    select: { instrumentId: true },
  });

  // 2. Adopt a pre-alias Instrument by ticker — ONLY for a grandfathered asset.
  //    The query is not even ISSUED otherwise, so there is no code path on which
  //    a ticker match for a non-grandfathered asset can be considered. Ordered
  //    oldest-first so adoption stays deterministic if a duplicate ever existed.
  const adoptionPermitted = legacyTickerAdoptionPermitted(asset);
  const legacy = alias || !adoptionPermitted
    ? null
    : await client.instrument.findFirst({
        where:   { tickerSymbol: asset.symbol, assetClass: AssetClass.CRYPTO },
        orderBy: { createdAt: "asc" },
        select:  { id: true },
      });

  const decision = decideCryptoResolution({
    aliasInstrumentId:       alias?.instrumentId ?? null,
    legacyInstrumentId:      legacy?.id ?? null,
    legacyAdoptionPermitted: adoptionPermitted,
  });

  if (decision.action === "use") return decision.instrumentId;

  if (decision.action === "adopt") {
    // Attach the canonical alias to the adopted price Instrument (idempotent).
    // Any pre-W-M1a symbol-keyed alias on the same row is LEFT IN PLACE: it was
    // a true mapping when it was written, an Instrument may carry many aliases,
    // and deleting it would be a data migration this slice does not perform.
    await client.instrumentAlias.upsert({
      where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.assetKey } },
      create: { instrumentId: decision.instrumentId, provider: CRYPTO_PROVIDER, externalId: asset.assetKey, metadata: { adopted: true, adoptedByTicker: asset.symbol } },
      update: {},
    });
    return decision.instrumentId;
  }

  // 3. Create the canonical Instrument + alias in one atomic write. The alias is
  //    keyed by assetKey, so the `@@unique([provider, externalId])` that refuses a
  //    second canonical mapping now refuses it PER ASSET rather than per ticker —
  //    two assets sharing a ticker each get their own row, which is correct.
  try {
    const created = await client.instrument.create({
      data: {
        tickerSymbol:     asset.symbol,
        name:             asset.name,
        assetClass:       AssetClass.CRYPTO,
        currency:         asset.currency,
        isCashEquivalent: false,
        aliases: { create: { provider: CRYPTO_PROVIDER, externalId: asset.assetKey, metadata: {} } },
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    // Lost a concurrent create race — the alias unique fired and rolled the whole
    // nested create back (no orphan Instrument). Re-read the winner's alias.
    const won = await client.instrumentAlias.findUnique({
      where:  { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: asset.assetKey } },
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
