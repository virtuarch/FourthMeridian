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
import { tokenReadWindow, tokenValuationExclusion, type TokenObservationRow, type TokenPriceRow } from "./token-valuation.core";
import { classifyAccounts } from "@/lib/account-classifier";
import type { ConversionContext } from "@/lib/money/types";
import { loadInstrumentCoverage, licensedInterval } from "./position-coverage";

type Client = PrismaClient | Prisma.TransactionClient;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export interface TokenDayRows {
  /**
   * Token observations per account: OBSERVED wallet-token rows, plus RECONSTRUCTED
   * (DERIVED) token rows that lie inside their own (account, instrument) licensed
   * coverage interval — a row is never its own licence. Observed wins on a shared day.
   */
  observationsByAccount: Map<string, TokenObservationRow[]>;
  /** USD RAW_CLOSE / INTRADAY prices for those instruments. */
  prices: TokenPriceRow[];
  /** Identity per token instrument, from its alias (rows without a token alias are dropped). */
  /** `excluded` — an EXPLICIT classification (token-valuation.core tokenValuationExclusion): never valued, never blocking. */
  identity: Map<string, { assetKey: string; contract: string; symbol: string | null; excluded?: boolean }>;
}

/** Rows sufficient to value every day in [fromISO, toISO] for these accounts. */
export async function loadTokenDayRows(
  client: Client,
  accountIds: readonly string[],
  fromISO: string,
  toISO: string,
): Promise<TokenDayRows> {
  const observationsByAccount = new Map<string, TokenObservationRow[]>();
  const identity = new Map<string, { assetKey: string; contract: string; symbol: string | null; excluded?: boolean }>();
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
  // TOKEN HISTORY (SPL / ERC-20 history PRs) — reconstructed days, licence-clamped.
  const derived = await client.positionObservation.findMany({
    where: {
      financialAccountId: { in: [...accountIds] },
      origin: PositionOrigin.DERIVED, supersededById: null, deletedAt: null,
      date: { gte: day(w.observationsFromISO), lte: day(w.toISO) },
      instrument: IS_TOKEN_INSTRUMENT,
    },
    select: { financialAccountId: true, instrumentId: true, date: true, quantity: true },
  });
  // Identity from the alias — and the alias is what makes a row a TOKEN row: a
  // row whose instrument carries no token alias is never valued as one.
  const candidateIds = [...new Set([...obs, ...derived].map((o) => o.instrumentId))];
  const aliases = candidateIds.length === 0 ? [] : await client.instrumentAlias.findMany({
    where: { instrumentId: { in: candidateIds }, provider: TOKEN_ALIAS_PROVIDER },
    select: { instrumentId: true, externalId: true, metadata: true },
  });
  for (const a of aliases) {
    const parsed = parseTokenAssetKey(a.externalId);
    if (!parsed) continue;
    const sym = (a.metadata as { symbol?: unknown } | null)?.symbol;
    identity.set(a.instrumentId, { assetKey: a.externalId, contract: parsed.contract, symbol: typeof sym === "string" ? sym : null, excluded: tokenValuationExclusion(a.metadata) !== null });
  }
  // Only rows of a TOKEN identity, and only inside their own licence.
  const tokenDerived = derived.filter((d) => identity.has(d.instrumentId));
  if (tokenDerived.length > 0) {
    const coverage = await loadInstrumentCoverage(client, [...new Set(tokenDerived.map((d) => d.financialAccountId))]);
    const observedDay = new Set(obs.map((o) => `${o.financialAccountId}|${o.instrumentId}|${isoOf(o.date)}`));
    for (const d of tokenDerived) {
      const cov = coverage.get(d.financialAccountId)?.get(d.instrumentId);
      const lic = cov ? licensedInterval(cov) : null;
      const iso = isoOf(d.date);
      if (!lic || iso < lic.fromISO || iso > lic.toISO) continue;
      if (observedDay.has(`${d.financialAccountId}|${d.instrumentId}|${iso}`)) continue;
      obs.push(d);
    }
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

/**
 * USD → reporting currency for a token value, through THE path regenerated days
 * use (classifyAccounts over a crypto row in USD with the Space conversion
 * context). One conversion authority for both writers.
 */
export function tokenValueInReporting(valueUsd: number, ctx: ConversionContext, dISO: string): number {
  return classifyAccounts([{ type: "crypto", balance: valueUsd, currency: "USD" }], ctx, dISO).totalDigitalAssets;
}
