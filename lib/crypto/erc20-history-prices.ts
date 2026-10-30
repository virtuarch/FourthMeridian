/**
 * lib/crypto/erc20-history-prices.ts
 *
 * ERC-20 HISTORY — historical USD closes for a wallet's VERIFIED token
 * instruments, through THE one token price path (#120's
 * lib/prices/token-history-prices.ts `acquireTokenHistoricalCloses`: one source
 * constant, one `priceHistory` alias marker, metered under the token-history
 * prefix and spent from the CoinGecko TOKEN share). Nothing here talks to the
 * vendor itself.
 *
 * Per token: the wanted interval is the token's own licence on this account
 * (COMPLETE PositionCoverage); the shared path clamps it to the vendor floor
 * and yesterday, and asks only for what its marker does not already cover.
 * A token that needed no vendor call costs one alias read. `maxTokens` bounds
 * the tokens that reached the vendor this run.
 *
 * Takes `client` explicitly. Never throws for a provider failure.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import { TOKEN_ALIAS_PROVIDER, parseTokenAssetKey } from "./token-asset";

type Client = PrismaClient | Prisma.TransactionClient;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

export interface Erc20PriceRun { calls: number; inserted: number; tokensFetched: number; earliestInsertedISO: string | null }

export async function acquireErc20HistoricalPrices(args: {
  client: Client;
  accountId: string;
  instrumentIds: readonly string[];
  maxTokens: number;
  acquire?: typeof acquireTokenHistoricalCloses;
}): Promise<Erc20PriceRun> {
  const out: Erc20PriceRun = { calls: 0, inserted: 0, tokensFetched: 0, earliestInsertedISO: null };
  const ids = [...new Set(args.instrumentIds)];
  if (ids.length === 0 || args.maxTokens <= 0) return out;
  const acquire = args.acquire ?? acquireTokenHistoricalCloses;
  const [aliases, coverage] = await Promise.all([
    args.client.instrumentAlias.findMany({ where: { instrumentId: { in: ids }, provider: TOKEN_ALIAS_PROVIDER }, select: { instrumentId: true, externalId: true } }),
    args.client.positionCoverage.findMany({
      where: { financialAccountId: args.accountId, instrumentId: { in: ids }, kind: "COMPLETE", coveredFromDate: { not: null }, coveredToDate: { not: null } },
      select: { instrumentId: true, coveredFromDate: true, coveredToDate: true },
    }),
  ]);
  for (const instrumentId of ids) {
    if (out.tokensFetched >= args.maxTokens) break;
    const assetKey = aliases.find((a) => a.instrumentId === instrumentId)?.externalId;
    if (parseTokenAssetKey(assetKey)?.standard !== "ERC20") continue;
    const lic = coverage.find((c) => c.instrumentId === instrumentId);
    if (!lic?.coveredFromDate || !lic.coveredToDate) continue; // only a verified token is priced historically
    const r = await acquire({ client: args.client, instrumentId, assetKey: assetKey!, fromISO: isoOf(lic.coveredFromDate), toISO: isoOf(lic.coveredToDate) });
    if (r.calls > 0) out.tokensFetched++;
    out.calls += r.calls;
    out.inserted += r.inserted;
    if (r.earliestISO && (out.earliestInsertedISO === null || r.earliestISO < out.earliestInsertedISO)) out.earliestInsertedISO = r.earliestISO;
    if (r.status === "BUDGET") break; // the shared token share is spent: nothing more this run
  }
  return out;
}
