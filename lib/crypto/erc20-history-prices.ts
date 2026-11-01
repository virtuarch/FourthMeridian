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
 * PROBE BUDGET (re-review F1). Probes are capped DURABLY per UTC day across
 * every run and wallet (`ERC20_HISTORY_PROBE_DAILY_CAP`, default 20, counted on
 * ApiUsageCounter under ERC20_PROBE_USAGE_PROVIDER — a run that self-continues
 * every 15 min cannot reset it), AND they only spend while the CoinGecko TOKEN
 * share keeps a reserve (`ERC20_HISTORY_PROBE_HELD_RESERVE`, default half of it)
 * untouched for HELD-token quotes and SPL / ERC-20 history closes. An
 * unreadable ledger ⇒ no probe.
 *
 * NEVER HELD (F2). A token whose rows never show a positive balance (zero-value
 * spam transfers) is neither probed nor priced: there is nothing to value.
 *
 * The chain-neutral probe parts (needs-probe check, allowance math, durable
 * gate, never-held skip) live in token-history-probe.ts, shared with SPL; this
 * module keeps ERC-20's own ledger (provider, metric, unit, env names).
 *
 * Takes `client` explicitly. Never throws for a provider failure.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import {
  TOKEN_PROBE_RETRY_MS, firstTimeQuoteProbe, needsQuoteProbe, probeAllowance, tokenProbeConfig, tokenProbeGate,
  type TokenProbeGate, type TokenProbeLedger, type TokenQuoteProbe,
} from "./token-history-probe";
import { TOKEN_ALIAS_PROVIDER, parseTokenAssetKey } from "./token-asset";
import { loadTokenHeldSpans } from "./token-held-spans";
import { ERC20_PRICE_RUN_SEVERITY, type Erc20PriceRunStatus } from "./erc20-history.core";

export { ERC20_PRICE_RUN_SEVERITY, type Erc20PriceRunStatus };

type Client = PrismaClient | Prisma.TransactionClient;

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

export interface Erc20PriceRun {
  calls: number; inserted: number; tokensFetched: number; earliestInsertedISO: string | null; probed: number;
  status: Erc20PriceRunStatus;
  /** Human-readable why, null when COMPLETE. */
  reason: string | null;
  /** Tokens left unasked by a stop, plus tokens whose probe was refused by the allowance. */
  tokensSkipped: number;
}

/** A never-priced token is quote-probed at most this often (the shared window, token-history-probe.ts). */
export const ERC20_PROBE_RETRY_MS = TOKEN_PROBE_RETRY_MS;

/** The probe: THE token current-quote path, for one token. Returns the vendor calls it spent. */
export type Erc20QuoteProbe = TokenQuoteProbe;

/**
 * ApiUsageCounter row for the durable per-day probe count (F1). An ATTEMPT
 * count (unit "attempts", like PRICE_GAP / REVALUATION), never "calls": the
 * probe's vendor call is already metered under COINGECKO by the quote path, and
 * a "calls" row would be listed as an external provider and double-counted by
 * Platform Ops (delta re-review L2).
 */
export const ERC20_PROBE_USAGE_PROVIDER = "ERC20_HISTORY";
export const ERC20_PROBE_USAGE_METRIC = "coingecko-probe";
export const ERC20_PROBE_USAGE_UNIT = "attempts";

/** ERC-20's probe ledger: its own durable count and env names (unchanged by the SPL extraction). */
export const ERC20_PROBE_LEDGER: TokenProbeLedger = {
  provider: ERC20_PROBE_USAGE_PROVIDER, metric: ERC20_PROBE_USAGE_METRIC, unit: ERC20_PROBE_USAGE_UNIT,
  dailyCapEnv: "ERC20_HISTORY_PROBE_DAILY_CAP", heldReserveEnv: "ERC20_HISTORY_PROBE_HELD_RESERVE",
};

export function erc20ProbeConfig(env: Record<string, string | undefined> = process.env) {
  return tokenProbeConfig(ERC20_PROBE_LEDGER, env);
}

export { probeAllowance, needsQuoteProbe };

/** The durable probe gate: how many probes may be sent now, and record one sent. */
export type Erc20ProbeGate = TokenProbeGate;

export function defaultProbeGate(
  client: Client, env: Record<string, string | undefined> = process.env,
  recordUsage?: (provider: string, metric: string, unit: string, n: number) => Promise<void>,
): Erc20ProbeGate {
  return tokenProbeGate(client, ERC20_PROBE_LEDGER, env, recordUsage);
}

export async function acquireErc20HistoricalPrices(args: {
  client: Client;
  accountId: string;
  instrumentIds: readonly string[];
  maxTokens: number;
  acquire?: typeof acquireTokenHistoricalCloses;
  probe?: Erc20QuoteProbe;
  probeGate?: Erc20ProbeGate;
  now?: () => number;
}): Promise<Erc20PriceRun> {
  const out: Erc20PriceRun = { calls: 0, inserted: 0, tokensFetched: 0, earliestInsertedISO: null, probed: 0, status: "COMPLETE", reason: null, tokensSkipped: 0 };
  const mark = (status: Erc20PriceRunStatus, reason: string) => {
    if (ERC20_PRICE_RUN_SEVERITY[status] > ERC20_PRICE_RUN_SEVERITY[out.status]) { out.status = status; out.reason = reason; }
  };
  const now = args.now ?? Date.now;
  const ids = [...new Set(args.instrumentIds)];
  if (ids.length === 0) return out;
  if (args.maxTokens <= 0) { mark("TOKEN_LIMIT", "no price-token allowance left this run"); out.tokensSkipped = ids.length; return out; }
  const acquire = args.acquire ?? acquireTokenHistoricalCloses;
  const gate = args.probeGate ?? defaultProbeGate(args.client);
  const [aliases, coverage, held] = await Promise.all([
    args.client.instrumentAlias.findMany({ where: { instrumentId: { in: ids }, provider: TOKEN_ALIAS_PROVIDER }, select: { instrumentId: true, externalId: true, metadata: true } }),
    args.client.positionCoverage.findMany({
      where: { financialAccountId: args.accountId, instrumentId: { in: ids }, kind: "COMPLETE", coveredFromDate: { not: null }, coveredToDate: { not: null } },
      select: { instrumentId: true, coveredFromDate: true, coveredToDate: true },
    }),
    loadTokenHeldSpans(args.client, [args.accountId], ids),
  ]);
  for (let i = 0; i < ids.length; i++) {
    const instrumentId = ids[i];
    if (out.tokensFetched >= args.maxTokens) {
      out.tokensSkipped += ids.length - i;
      mark("TOKEN_LIMIT", `price-token limit (${args.maxTokens}) reached; ${ids.length - i} token(s) left for a later run`);
      break;
    }
    const alias = aliases.find((a) => a.instrumentId === instrumentId);
    const assetKey = alias?.externalId;
    const parsed = parseTokenAssetKey(assetKey);
    if (parsed?.standard !== "ERC20") continue;
    const lic = coverage.find((c) => c.instrumentId === instrumentId);
    if (!lic?.coveredFromDate || !lic.coveredToDate) continue; // only a verified token is priced historically
    if (!held.has(`${args.accountId}|${instrumentId}`)) continue; // F2 — never held: nothing to value
    // The shared first-time probe (token-history-probe.ts): needs → held → durable allowance.
    const step = await firstTimeQuoteProbe({
      client: args.client, target: { instrumentId, assetKey: assetKey!, platform: "ethereum", contract: parsed.contract },
      metadata: alias?.metadata, held: () => true /* never-held already skipped above */, gate, probe: args.probe, nowMs: now(),
    });
    const probeCalls = step.calls;
    if (step.outcome === "PROBED") out.probed++;
    else if (step.outcome === "REFUSED") {
      out.tokensSkipped++;
      mark("ALLOWANCE_EXHAUSTED", "quote-probe allowance exhausted; never-priced token(s) left NOT_VALUED_YET for a later run");
    }
    const r = await acquire({ client: args.client, instrumentId, assetKey: assetKey!, fromISO: isoOf(lic.coveredFromDate), toISO: isoOf(lic.coveredToDate) });
    if (r.calls + probeCalls > 0) out.tokensFetched++;
    out.calls += r.calls + probeCalls;
    out.inserted += r.inserted;
    if (r.earliestISO && (out.earliestInsertedISO === null || r.earliestISO < out.earliestInsertedISO)) out.earliestInsertedISO = r.earliestISO;
    if (r.status === "BUDGET") {
      // The shared token share is spent: nothing more this run — said, never silent.
      // This token was not priced either (the shared path spent nothing on it).
      out.tokensSkipped += ids.length - i;
      mark("BUDGET_STOPPED", `CoinGecko token budget reached; ${ids.length - i} token(s) not priced this run`);
      break;
    }
  }
  return out;
}
