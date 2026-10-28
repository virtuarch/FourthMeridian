/**
 * lib/crypto/token-valuation.ts
 *
 * The ONE read behind token-valuation.core.ts, shared by the live wallet value
 * and historical regeneration so both value a token from the same rows by the
 * same rule. Takes `client` explicitly.
 */

import { PositionOrigin, PriceBasis, type Prisma, type PrismaClient } from "@prisma/client";
import { STALE_AFTER_DAYS } from "@/lib/freshness/observation";
import { IS_TOKEN_INSTRUMENT, WALLET_TOKEN_POSITION_SOURCE, TOKEN_ALIAS_PROVIDER, parseTokenAssetKey } from "./token-asset";
import { tokenReadWindow, type TokenObservationRow, type TokenPriceRow } from "./token-valuation.core";

type Client = PrismaClient | Prisma.TransactionClient;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export interface TokenDayRows {
  /** Token observations per account (only token instruments, OBSERVED wallet-token rows). */
  observationsByAccount: Map<string, TokenObservationRow[]>;
  /** USD RAW_CLOSE / INTRADAY prices for those instruments. */
  prices: TokenPriceRow[];
  /** Identity per token instrument, from its alias (rows without a token alias are dropped). */
  identity: Map<string, { assetKey: string; contract: string; symbol: string | null }>;
}

/** Rows sufficient to value every day in [fromISO, toISO] for these accounts. */
export async function loadTokenDayRows(
  client: Client,
  accountIds: readonly string[],
  fromISO: string,
  toISO: string,
): Promise<TokenDayRows> {
  const observationsByAccount = new Map<string, TokenObservationRow[]>();
  const identity = new Map<string, { assetKey: string; contract: string; symbol: string | null }>();
  if (accountIds.length === 0) return { observationsByAccount, prices: [], identity };
  const w = tokenReadWindow(fromISO, toISO, STALE_AFTER_DAYS);
  const obs = await client.positionObservation.findMany({
    where: {
      financialAccountId: { in: [...accountIds] },
      source: WALLET_TOKEN_POSITION_SOURCE, origin: PositionOrigin.OBSERVED,
      supersededById: null, deletedAt: null,
      date: { gte: day(w.observationsFromISO), lte: day(w.toISO) },
      instrument: IS_TOKEN_INSTRUMENT,
    },
    select: { financialAccountId: true, instrumentId: true, date: true, quantity: true },
  });
  // Identity from the alias — and the alias is what makes a row a TOKEN row: a
  // row whose instrument carries no token alias is never valued as one.
  const candidateIds = [...new Set(obs.map((o) => o.instrumentId))];
  const aliases = candidateIds.length === 0 ? [] : await client.instrumentAlias.findMany({
    where: { instrumentId: { in: candidateIds }, provider: TOKEN_ALIAS_PROVIDER },
    select: { instrumentId: true, externalId: true, metadata: true },
  });
  for (const a of aliases) {
    const parsed = parseTokenAssetKey(a.externalId);
    if (!parsed) continue;
    const sym = (a.metadata as { symbol?: unknown } | null)?.symbol;
    identity.set(a.instrumentId, { assetKey: a.externalId, contract: parsed.contract, symbol: typeof sym === "string" ? sym : null });
  }
  for (const o of obs) {
    if (!identity.has(o.instrumentId)) continue;
    const list = observationsByAccount.get(o.financialAccountId) ?? [];
    list.push({ instrumentId: o.instrumentId, dateISO: isoOf(o.date), quantity: o.quantity });
    observationsByAccount.set(o.financialAccountId, list);
  }
  const ids = [...identity.keys()];
  const prices = ids.length === 0 ? [] : (await client.priceObservation.findMany({
    where: {
      instrumentId: { in: ids }, currency: "USD",
      basis: { in: [PriceBasis.RAW_CLOSE, PriceBasis.INTRADAY] },
      date: { gte: day(w.pricesFromISO), lte: day(w.toISO) },
    },
    select: { instrumentId: true, date: true, basis: true, price: true },
  })).map((p) => ({ instrumentId: p.instrumentId, dateISO: isoOf(p.date), basis: p.basis as "RAW_CLOSE" | "INTRADAY", priceUsd: p.price }));
  return { observationsByAccount, prices, identity };
}
