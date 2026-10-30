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
 * Takes `client` explicitly. Never throws for a provider failure.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { acquireTokenHistoricalCloses } from "@/lib/prices/token-history-prices";
import type { TokenQuoteTarget } from "@/lib/prices/current-quotes";
import { coinGeckoBudgetConfig, defaultCoinGeckoBudget } from "@/lib/prices/coingecko-budget";
import { usageDayBucket } from "@/lib/usage/provider-budget.core";
import { todayUTCISO } from "@/lib/time/clock";
import { TOKEN_ALIAS_PROVIDER, parseTokenAssetKey } from "./token-asset";
import { loadTokenHeldSpans } from "./token-held-spans";

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

const num = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : d; };
export function erc20ProbeConfig(env: Record<string, string | undefined> = process.env) {
  return {
    dailyCap: Math.floor(num(env.ERC20_HISTORY_PROBE_DAILY_CAP, 20, 0, 1_000)),
    /** Fraction of the TOKEN share probes must leave untouched for held-token quotes and history closes. */
    heldReserve: num(env.ERC20_HISTORY_PROBE_HELD_RESERVE, 0.5, 0, 1),
  };
}

/**
 * PURE (F1) — probes allowed NOW: within the durable daily cap, and only while
 * the TOKEN share stays above its held-quote reserve. Unknown anything ⇒ 0.
 */
export function probeAllowance(f: { probesToday: number | null; tokenRemaining: number | null; tokenShareCap: number; dailyCap: number; heldReserve: number }): number {
  if (f.probesToday === null || f.tokenRemaining === null) return 0;
  const reserve = Math.ceil(f.tokenShareCap * f.heldReserve);
  return Math.max(0, Math.min(f.dailyCap - f.probesToday, f.tokenRemaining - reserve));
}

/** The durable probe gate: how many probes may be sent now, and record one sent. */
export interface Erc20ProbeGate { allowance(): Promise<number>; record(n: number): Promise<void> }

export function defaultProbeGate(
  client: Client, env: Record<string, string | undefined> = process.env,
  recordUsage?: (provider: string, metric: string, unit: string, n: number) => Promise<void>,
): Erc20ProbeGate {
  const cfg = erc20ProbeConfig(env);
  const cg = coinGeckoBudgetConfig(env);
  return {
    async allowance() {
      let probesToday: number | null = null;
      try {
        const rows = await (client as PrismaClient).apiUsageCounter.findMany({
          where: { provider: ERC20_PROBE_USAGE_PROVIDER, unit: ERC20_PROBE_USAGE_UNIT, day: usageDayBucket(todayUTCISO()) }, select: { metric: true, count: true },
        });
        probesToday = rows.reduce((a, r) => a + (Number(r.count) || 0), 0);
      } catch { probesToday = null; }
      const tokenRemaining = await defaultCoinGeckoBudget(client, env).remaining("token").catch(() => null);
      return probeAllowance({ probesToday, tokenRemaining, tokenShareCap: Math.floor(cg.dailyCallCap * cg.tokenShare), dailyCap: cfg.dailyCap, heldReserve: cfg.heldReserve });
    },
    async record(n) {
      if (n <= 0) return;
      const rec = recordUsage ?? (await import("@/lib/usage/record")).recordApiUsage;
      try { await rec(ERC20_PROBE_USAGE_PROVIDER, ERC20_PROBE_USAGE_METRIC, ERC20_PROBE_USAGE_UNIT, n); } catch { /* never fails a run */ }
    },
  };
}

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
  probeGate?: Erc20ProbeGate;
  now?: () => number;
}): Promise<Erc20PriceRun> {
  const out: Erc20PriceRun = { calls: 0, inserted: 0, tokensFetched: 0, earliestInsertedISO: null, probed: 0 };
  const probe = args.probe ?? defaultProbe;
  const now = args.now ?? Date.now;
  const ids = [...new Set(args.instrumentIds)];
  if (ids.length === 0 || args.maxTokens <= 0) return out;
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
  for (const instrumentId of ids) {
    if (out.tokensFetched >= args.maxTokens) break;
    const alias = aliases.find((a) => a.instrumentId === instrumentId);
    const assetKey = alias?.externalId;
    const parsed = parseTokenAssetKey(assetKey);
    if (parsed?.standard !== "ERC20") continue;
    const lic = coverage.find((c) => c.instrumentId === instrumentId);
    if (!lic?.coveredFromDate || !lic.coveredToDate) continue; // only a verified token is priced historically
    if (!held.has(`${args.accountId}|${instrumentId}`)) continue; // F2 — never held: nothing to value
    let probeCalls = 0;
    if (needsQuoteProbe(alias?.metadata, now())) {
      // Re-read before EVERY probe: acquisitions between probes spend the same TOKEN share.
      if ((await gate.allowance().catch(() => 0)) > 0) {
        try { probeCalls = await probe({ instrumentId, assetKey: assetKey!, platform: "ethereum", contract: parsed.contract }, args.client); }
        catch { /* a probe is an outcome; the token stays NOT_VALUED_YET and is disclosed */ }
        finally { await gate.record(1).catch(() => undefined); }
        out.probed++;
      }
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
