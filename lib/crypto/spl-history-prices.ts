/**
 * lib/crypto/spl-history-prices.ts
 *
 * SPL HISTORY — historical USD closes for ONE mint whose licence was just
 * committed (spl-history.ts step 5), through THE one token price path
 * (lib/prices/token-history-prices.ts `acquireTokenHistoricalCloses`). Nothing
 * here talks to the vendor itself.
 *
 * FIRST-TIME QUOTE PROBE (parity with ERC-20, erc20-history-prices.ts). The
 * shared path prices only a token with a liquid current market (its quote
 * marker), which capture writes only for mints held NOW — so a mint sold before
 * capture began was never priced. Such a mint (verified rows, actually held at
 * some point, never priced and not asked within the shared retry window) is
 * first quoted through THE current-quote path by the shared probe
 * (token-history-probe.ts) — same eligibility, same thin-market floors. Unlisted
 * or thin ⇒ NO_MARKET (disclosed, never valued); unanswered ⇒ NOT_VALUED_YET.
 * A mint whose marker exists is never probed. A probe writes only the quote
 * marker and one attempt count — never balance rows or their completeness.
 *
 * BUDGET. SPL's own durable per-UTC-day cap (`SPL_HISTORY_PROBE_DAILY_CAP`,
 * default 20), counted on ApiUsageCounter under SPL_PROBE_USAGE_PROVIDER
 * ("SPL_HISTORY", metric "coingecko-probe", unit "attempts"), AND the same
 * CoinGecko TOKEN-share held reserve as ERC-20 (`SPL_HISTORY_PROBE_HELD_RESERVE`,
 * default 0.5). An unreadable ledger ⇒ no probe. Gated by SPL_HISTORY_ENABLED
 * (the caller passes `enabled`).
 *
 * Takes `client` explicitly. Never throws for a provider failure.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import { firstTimeQuoteProbe, tokenProbeGate, type TokenProbeGate, type TokenProbeLedger, type TokenProbeStep, type TokenQuoteProbe } from "./token-history-probe";
import { TOKEN_ALIAS_PROVIDER, splTokenAssetKey } from "./token-asset";
import { readTokenAliasMetadata } from "./token-instrument";
import { loadTokenHeldSpans } from "./token-held-spans";

type Client = PrismaClient | Prisma.TransactionClient;

export const SPL_PROBE_USAGE_PROVIDER = "SPL_HISTORY";
export const SPL_PROBE_USAGE_METRIC = "coingecko-probe";
export const SPL_PROBE_USAGE_UNIT = "attempts";

/** SPL's probe ledger: its own durable count, apart from ERC-20's (ERC20_HISTORY). */
export const SPL_PROBE_LEDGER: TokenProbeLedger = {
  provider: SPL_PROBE_USAGE_PROVIDER, metric: SPL_PROBE_USAGE_METRIC, unit: SPL_PROBE_USAGE_UNIT,
  dailyCapEnv: "SPL_HISTORY_PROBE_DAILY_CAP", heldReserveEnv: "SPL_HISTORY_PROBE_HELD_RESERVE",
};

export function splProbeGate(
  client: Client, env: Record<string, string | undefined> = process.env,
  recordUsage?: (provider: string, metric: string, unit: string, n: number) => Promise<void>,
): TokenProbeGate {
  return tokenProbeGate(client, SPL_PROBE_LEDGER, env, recordUsage);
}

export interface SplPriceAcquisition {
  inserted: number;
  earliestISO: string | null;
  /** The shared path's status ("BUDGET" stops pricing for this run); absent when it was not asked. */
  status?: string;
  /** What the first-time probe did (REFUSED ⇒ the caller reports ALLOWANCE_EXHAUSTED). */
  probe: TokenProbeStep["outcome"] | "DISABLED";
}

export async function acquireSplHistoricalPrices(args: {
  client: Client;
  accountId: string;
  mint: string;
  fromISO: string;
  toISO: string;
  /** SPL_HISTORY_ENABLED — the probe never runs when off. */
  enabled: boolean;
  acquire?: typeof acquireTokenHistoricalCloses;
  probe?: TokenQuoteProbe;
  probeGate?: TokenProbeGate;
  now?: () => number;
}): Promise<SplPriceAcquisition> {
  const assetKey = splTokenAssetKey(args.mint);
  const alias = await args.client.instrumentAlias.findUnique({
    where: { provider_externalId: { provider: TOKEN_ALIAS_PROVIDER, externalId: assetKey } }, select: { instrumentId: true, metadata: true },
  });
  if (!alias || !readTokenAliasMetadata(alias.metadata)) return { inserted: 0, earliestISO: null, probe: "NOT_NEEDED" };
  const instrumentId = alias.instrumentId;
  let probe: SplPriceAcquisition["probe"] = "DISABLED";
  if (args.enabled) {
    const step = await firstTimeQuoteProbe({
      client: args.client, target: { instrumentId, assetKey, platform: "solana", contract: args.mint }, metadata: alias.metadata,
      // Held at some point on THIS account (its committed rows): a never-held mint is never probed.
      held: async () => (await loadTokenHeldSpans(args.client, [args.accountId], [instrumentId])).has(`${args.accountId}|${instrumentId}`),
      gate: args.probeGate ?? splProbeGate(args.client), probe: args.probe, nowMs: (args.now ?? Date.now)(),
    });
    probe = step.outcome;
  }
  const r = await (args.acquire ?? acquireTokenHistoricalCloses)({ client: args.client, instrumentId, assetKey, fromISO: args.fromISO, toISO: args.toISO });
  return { inserted: r.inserted, earliestISO: r.earliestISO, status: r.status, probe };
}
