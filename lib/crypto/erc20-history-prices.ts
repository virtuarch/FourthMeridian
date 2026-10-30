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
 * QUOTE PROBE (PR #122 review B1). The shared path prices only a token with a
 * liquid CURRENT market (its quote marker) — and capture writes that marker
 * only for tokens the wallet holds NOW. A token sold before capture began has
 * verified rows and no marker, so it would never be priced and would vanish
 * from historical net worth. Such a token (never priced, not asked within
 * ERC20_PROBE_RETRY_MS) is first quoted through THE current-quote path
 * (refreshCurrentTokenQuotes: same marker, same thin-market floors, same
 * unlisted retry window, TOKEN share) — so the eligibility rules are the ones
 * every held token meets, never weaker. A vendor that does not list it, or
 * lists it thin, leaves it NO_MARKET (disclosed, never valued); anything else
 * unanswered leaves it NOT_VALUED_YET (disclosed; the wallet is not complete).
 *
 * Takes `client` explicitly. Never throws for a provider failure.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import type { TokenQuoteTarget } from "@/lib/prices/current-quotes";
import { TOKEN_ALIAS_PROVIDER, parseTokenAssetKey } from "./token-asset";

type Client = PrismaClient | Prisma.TransactionClient;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

export interface Erc20PriceRun { calls: number; inserted: number; tokensFetched: number; earliestInsertedISO: string | null; probed: number }

/** A never-priced token is quote-probed at most this often (an exited spam token costs ≤ 1 call a week). */
export const ERC20_PROBE_RETRY_MS = 7 * 24 * 3_600_000;

/** The probe: THE token current-quote path, for one token. Returns the vendor calls it spent. */
export type Erc20QuoteProbe = (target: TokenQuoteTarget, client: Client) => Promise<number>;

const defaultProbe: Erc20QuoteProbe = async (target, client) => {
  const { refreshCurrentTokenQuotes } = await import("@/lib/prices/current-quotes");
  const retryHours = String(ERC20_PROBE_RETRY_MS / 3_600_000);
  const o = await refreshCurrentTokenQuotes([target], { client, maxTokens: 1, env: { ...process.env, COINGECKO_UNLISTED_RETRY_HOURS: retryHours } });
  return o.calls ?? 0;
};

/** PURE — should this token be quote-probed now? Only one never priced, not asked within the window. */
export function needsQuoteProbe(metadata: unknown, nowMs: number): boolean {
  const q = (metadata as { quote?: { attemptedAt?: unknown; pricedAt?: unknown } } | null)?.quote;
  if (typeof q?.pricedAt === "string") return false; // ever priced: the shared path decides
  if (typeof q?.attemptedAt === "string" && nowMs - Date.parse(q.attemptedAt) < ERC20_PROBE_RETRY_MS) return false;
  return true;
}

export async function acquireErc20HistoricalPrices(args: {
  client: Client;
  accountId: string;
  instrumentIds: readonly string[];
  maxTokens: number;
  acquire?: typeof acquireTokenHistoricalCloses;
  probe?: Erc20QuoteProbe;
  now?: () => number;
}): Promise<Erc20PriceRun> {
  const out: Erc20PriceRun = { calls: 0, inserted: 0, tokensFetched: 0, earliestInsertedISO: null, probed: 0 };
  const probe = args.probe ?? defaultProbe;
  const now = args.now ?? Date.now;
  const ids = [...new Set(args.instrumentIds)];
  if (ids.length === 0 || args.maxTokens <= 0) return out;
  const acquire = args.acquire ?? acquireTokenHistoricalCloses;
  const [aliases, coverage] = await Promise.all([
    args.client.instrumentAlias.findMany({ where: { instrumentId: { in: ids }, provider: TOKEN_ALIAS_PROVIDER }, select: { instrumentId: true, externalId: true, metadata: true } }),
    args.client.positionCoverage.findMany({
      where: { financialAccountId: args.accountId, instrumentId: { in: ids }, kind: "COMPLETE", coveredFromDate: { not: null }, coveredToDate: { not: null } },
      select: { instrumentId: true, coveredFromDate: true, coveredToDate: true },
    }),
  ]);
  for (const instrumentId of ids) {
    if (out.tokensFetched >= args.maxTokens) break;
    const alias = aliases.find((a) => a.instrumentId === instrumentId);
    const assetKey = alias?.externalId;
    const parsed = parseTokenAssetKey(assetKey);
    if (parsed?.standard !== "ERC20") continue;
    const lic = coverage.find((c) => c.instrumentId === instrumentId);
    if (!lic?.coveredFromDate || !lic.coveredToDate) continue; // only a verified token is priced historically
    let probeCalls = 0;
    if (needsQuoteProbe(alias?.metadata, now())) {
      try { probeCalls = await probe({ instrumentId, assetKey: assetKey!, platform: "ethereum", contract: parsed.contract }, args.client); }
      catch { /* a probe is an outcome; the token stays NOT_VALUED_YET and is disclosed */ }
      out.probed++;
    }
    const r = await acquire({ client: args.client, instrumentId, assetKey: assetKey!, fromISO: isoOf(lic.coveredFromDate), toISO: isoOf(lic.coveredToDate) });
    if (r.calls + probeCalls > 0) out.tokensFetched++;
    out.calls += r.calls + probeCalls;
    out.inserted += r.inserted;
    if (r.earliestISO && (out.earliestInsertedISO === null || r.earliestISO < out.earliestInsertedISO)) out.earliestInsertedISO = r.earliestISO;
    if (r.status === "BUDGET") break; // the shared token share is spent: nothing more this run
  }
  return out;
}
