/**
 * lib/crypto/token-instrument.ts
 *
 * TOKEN HOLDINGS FOUNDATION (PR-A) — the canonical identity rule for an SPL /
 * ERC-20 token. A SIBLING of crypto-instrument.ts (native assets), sharing its
 * alias namespace (CRYPTO_PROVIDER, CAIP-19 assetKey) and its pure precedence
 * (`decideCryptoResolution`), so identity cannot fork between the two.
 */

import { AssetClass, type Prisma, type PrismaClient } from "@prisma/client";
import { CRYPTO_PROVIDER, decideCryptoResolution } from "@/lib/investments/crypto-instrument";

type Client = PrismaClient | Prisma.TransactionClient;

// ─── Tokens (TOKEN HOLDINGS FOUNDATION, PR-A) ────────────────────────────────
//
// A token resolves through the SAME alias namespace (provider "crypto", the
// CAIP-19 assetKey as externalId — lib/crypto/token-asset.ts) and the same
// race-safe create, with two differences that are the whole point:
//
//   1. NEVER ticker adoption. A token's symbol is attacker-controlled; step 2
//      above is unreachable for it by construction (no legacy lookup is issued).
//   2. `tickerSymbol` is NULL. Price routing is keyed by ticker today
//      (coingecko.ts COINGECKO_COIN_IDS: "an ERC-20 tickered ETH would route to
//      coin id ethereum and be priced as native Ether"). A null ticker makes
//      every ticker-routed path refuse a token (resolvePriceability →
//      NO_PROVIDER_SYMBOL), so a token can only ever be priced by its CONTRACT
//      (lib/prices/current-quotes.ts refreshCurrentTokenQuotes). The display
//      symbol lives on the alias metadata.
//
// One Instrument per token across ALL customers — the alias unique makes that
// structural, exactly as for native assets.

/** Instrument.securityType stamped on token instruments (display/diagnostic only — identity is the alias). */
export const TOKEN_SECURITY_TYPE: Readonly<Record<"SPL" | "ERC20", string>> = { SPL: "spl_token", ERC20: "erc20_token" };

export interface TokenInstrumentSpec {
  assetKey: string;
  standard: "SPL" | "ERC20";
  contract: string;
  decimals: number;
  symbol:   string | null;
  name:     string | null;
  program?: string;
}

/** The alias metadata a token carries — display + decimals evidence, never identity. */
export interface TokenAliasMetadata {
  token:    true;
  standard: "SPL" | "ERC20";
  contract: string;
  decimals: number;
  symbol:   string | null;
  name:     string | null;
  program?: string;
}

export function tokenAliasMetadata(t: TokenInstrumentSpec): TokenAliasMetadata {
  return {
    token: true, standard: t.standard, contract: t.contract, decimals: t.decimals,
    symbol: t.symbol, name: t.name, ...(t.program ? { program: t.program } : {}),
  };
}

/** Read token alias metadata back (null when the row is not a token alias). */
export function readTokenAliasMetadata(meta: unknown): TokenAliasMetadata | null {
  const m = meta as Partial<TokenAliasMetadata> | null;
  if (!m || m.token !== true || (m.standard !== "SPL" && m.standard !== "ERC20") || typeof m.contract !== "string") return null;
  if (typeof m.decimals !== "number" || !Number.isInteger(m.decimals)) return null;
  return {
    token: true, standard: m.standard, contract: m.contract, decimals: m.decimals,
    symbol: typeof m.symbol === "string" ? m.symbol : null,
    name: typeof m.name === "string" ? m.name : null,
    ...(typeof m.program === "string" ? { program: m.program } : {}),
  };
}

/**
 * Resolve THE ONE canonical Instrument for a token, creating identity + alias
 * only when none exists. `client` is REQUIRED (no defaulted authority).
 *
 * Metadata is written at creation and refreshed only when the alias lacks it or
 * a display field was empty — decimals of a mint/contract never change, and
 * nothing ever resolves by the display fields, so a later rename is cosmetic.
 */
export async function resolveTokenInstrumentId(
  token: TokenInstrumentSpec,
  opts: { client: Client },
): Promise<string> {
  const client = opts.client;
  const where = { provider_externalId: { provider: CRYPTO_PROVIDER, externalId: token.assetKey } };
  const alias = await client.instrumentAlias.findUnique({ where, select: { instrumentId: true, metadata: true } });

  const decision = decideCryptoResolution({
    aliasInstrumentId: alias?.instrumentId ?? null,
    legacyInstrumentId: null,
    legacyAdoptionPermitted: false,
  });

  if (decision.action === "use") {
    const known = readTokenAliasMetadata(alias?.metadata);
    if (!known || (!known.symbol && token.symbol) || (!known.name && token.name)) {
      // Merge, never replace: other keys on the alias (the quote marker —
      // lib/prices/current-quotes TokenQuoteMarker) must survive a display refresh.
      const existing = (alias?.metadata && typeof alias.metadata === "object" ? alias.metadata : {}) as Record<string, unknown>;
      await client.instrumentAlias.update({ where, data: { metadata: { ...existing, ...tokenAliasMetadata(token) } as unknown as Prisma.InputJsonValue } });
    }
    return decision.instrumentId;
  }

  try {
    const created = await client.instrument.create({
      data: {
        tickerSymbol:     null,
        name:             token.name ?? token.symbol ?? token.contract,
        assetClass:       AssetClass.CRYPTO,
        currency:         "USD",
        securityType:     TOKEN_SECURITY_TYPE[token.standard],
        isCashEquivalent: false,
        aliases: { create: { provider: CRYPTO_PROVIDER, externalId: token.assetKey, metadata: tokenAliasMetadata(token) as unknown as Prisma.InputJsonValue } },
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    const won = await client.instrumentAlias.findUnique({ where, select: { instrumentId: true } });
    if (won) return won.instrumentId;
    throw err;
  }
}

/** Known token metadata by assetKey (for skipping repeat metadata calls). */
export async function loadTokenAliasMetadata(
  client: Client,
  assetKeys: readonly string[],
): Promise<Map<string, TokenAliasMetadata & { instrumentId: string }>> {
  const out = new Map<string, TokenAliasMetadata & { instrumentId: string }>();
  if (assetKeys.length === 0) return out;
  const rows = await client.instrumentAlias.findMany({
    where:  { provider: CRYPTO_PROVIDER, externalId: { in: [...assetKeys] } },
    select: { externalId: true, instrumentId: true, metadata: true },
  });
  for (const r of rows) {
    const m = readTokenAliasMetadata(r.metadata);
    if (m) out.set(r.externalId, { ...m, instrumentId: r.instrumentId });
  }
  return out;
}
