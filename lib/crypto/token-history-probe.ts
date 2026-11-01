/**
 * lib/crypto/token-history-probe.ts
 *
 * THE FIRST-TIME QUOTE PROBE for token history — chain-neutral, shared by
 * ERC-20 (erc20-history-prices.ts) and SPL (spl-history.store.ts).
 *
 * WHY. The shared historical price path (lib/prices/token-history-prices.ts
 * `acquireTokenHistoricalCloses`) prices only a token with a liquid CURRENT
 * market (its quote marker), and capture writes that marker only for tokens a
 * wallet holds NOW. A token sold before capture began has verified rows and no
 * marker, so it would never be priced historically. Such a token (never
 * priced, not asked within TOKEN_PROBE_RETRY_MS) is first quoted through THE
 * current-quote path (refreshCurrentTokenQuotes: same marker, same thin-market
 * floors, same unlisted retry window, CoinGecko TOKEN share) — so the
 * eligibility rules are the ones every held token meets, never weaker. A vendor
 * that does not list it, or lists it thin, leaves it NO_MARKET (disclosed,
 * never valued); anything else unanswered leaves it NOT_VALUED_YET (disclosed).
 *
 * BUDGET. Probes are capped DURABLY per UTC day across every run and wallet —
 * one ApiUsageCounter row family per chain (`TokenProbeLedger`: provider,
 * metric, unit "attempts"; the daily-cap env name) — AND they only spend while
 * the CoinGecko TOKEN share keeps a reserve (the reserve env name, default half
 * of the share) untouched for HELD-token quotes and history closes. An
 * unreadable ledger or budget ⇒ no probe. The SPL and ERC-20 reserves are
 * separate env settings (SPL_HISTORY_PROBE_HELD_RESERVE, ERC20_HISTORY_PROBE_HELD_RESERVE),
 * and setting either to 0 lets that chain's probes spend into the held-quote part.
 *
 * NEVER HELD. A token whose rows never show a positive balance is not probed:
 * there is nothing to value.
 *
 * A probe never touches balance history or its completeness: it writes only
 * the token's quote marker (through the quote path) and one attempt count.
 *
 * Takes `client` explicitly. Never throws for a provider failure.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { TokenQuoteTarget } from "@/lib/prices/current-quotes";
import { coinGeckoBudgetConfig, defaultCoinGeckoBudget } from "@/lib/prices/coingecko-budget";
import { usageDayBucket } from "@/lib/usage/provider-budget.core";
import { todayUTCISO } from "@/lib/time/clock";

type Client = PrismaClient | Prisma.TransactionClient;

/** A never-priced token is quote-probed at most this often (an exited spam token costs ≤ 1 call a week). */
export const TOKEN_PROBE_RETRY_MS = 7 * 24 * 3_600_000;

/** The probe: THE token current-quote path, for one token. Returns the vendor calls it spent. */
export type TokenQuoteProbe = (target: TokenQuoteTarget, client: Client) => Promise<number>;

export const defaultTokenQuoteProbe: TokenQuoteProbe = async (target, client) => {
  const { refreshCurrentTokenQuotes } = await import("@/lib/prices/current-quotes");
  const retryHours = String(TOKEN_PROBE_RETRY_MS / 3_600_000);
  const o = await refreshCurrentTokenQuotes([target], { client, maxTokens: 1, env: { ...process.env, COINGECKO_UNLISTED_RETRY_HOURS: retryHours } });
  return o.calls ?? 0;
};

/**
 * Where one chain counts its probes. An ATTEMPT count (unit "attempts", like
 * PRICE_GAP / REVALUATION), never "calls": the probe's vendor call is already
 * metered under COINGECKO by the quote path, and a "calls" row would be listed
 * as an external provider and double-counted by Platform Ops.
 */
export interface TokenProbeLedger {
  provider: string;
  metric: string;
  unit: string;
  /** Env var holding the durable per-UTC-day probe cap (default 20, 0..1000). */
  dailyCapEnv: string;
  /** Env var holding the fraction of the TOKEN share probes must leave untouched (default 0.5, 0..1). */
  heldReserveEnv: string;
}

const num = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : d; };

export function tokenProbeConfig(ledger: Pick<TokenProbeLedger, "dailyCapEnv" | "heldReserveEnv">, env: Record<string, string | undefined> = process.env) {
  return {
    dailyCap: Math.floor(num(env[ledger.dailyCapEnv], 20, 0, 1_000)),
    /** Fraction of the TOKEN share probes must leave untouched for held-token quotes and history closes. */
    heldReserve: num(env[ledger.heldReserveEnv], 0.5, 0, 1),
  };
}

/**
 * PURE — probes allowed NOW: within the durable daily cap, and only while the
 * TOKEN share stays above its held-quote reserve. Unknown anything ⇒ 0.
 */
export function probeAllowance(f: { probesToday: number | null; tokenRemaining: number | null; tokenShareCap: number; dailyCap: number; heldReserve: number }): number {
  if (f.probesToday === null || f.tokenRemaining === null) return 0;
  const reserve = Math.ceil(f.tokenShareCap * f.heldReserve);
  return Math.max(0, Math.min(f.dailyCap - f.probesToday, f.tokenRemaining - reserve));
}

/** The durable probe gate: how many probes may be sent now, and record one sent. */
export interface TokenProbeGate { allowance(): Promise<number>; record(n: number): Promise<void> }

export function tokenProbeGate(
  client: Client, ledger: TokenProbeLedger, env: Record<string, string | undefined> = process.env,
  recordUsage?: (provider: string, metric: string, unit: string, n: number) => Promise<void>,
): TokenProbeGate {
  const cfg = tokenProbeConfig(ledger, env);
  const cg = coinGeckoBudgetConfig(env);
  return {
    async allowance() {
      let probesToday: number | null = null;
      try {
        const rows = await (client as PrismaClient).apiUsageCounter.findMany({
          where: { provider: ledger.provider, unit: ledger.unit, day: usageDayBucket(todayUTCISO()) }, select: { metric: true, count: true },
        });
        probesToday = rows.reduce((a, r) => a + (Number(r.count) || 0), 0);
      } catch { probesToday = null; }
      const tokenRemaining = await defaultCoinGeckoBudget(client, env).remaining("token").catch(() => null);
      return probeAllowance({ probesToday, tokenRemaining, tokenShareCap: Math.floor(cg.dailyCallCap * cg.tokenShare), dailyCap: cfg.dailyCap, heldReserve: cfg.heldReserve });
    },
    async record(n) {
      if (n <= 0) return;
      const rec = recordUsage ?? (await import("@/lib/usage/record")).recordApiUsage;
      try { await rec(ledger.provider, ledger.metric, ledger.unit, n); } catch { /* never fails a run */ }
    },
  };
}

/** PURE — should this token be quote-probed now? Only one never priced, not asked within the window. */
export function needsQuoteProbe(metadata: unknown, nowMs: number): boolean {
  const q = (metadata as { quote?: { attemptedAt?: unknown; pricedAt?: unknown } } | null)?.quote;
  if (typeof q?.pricedAt === "string") return false; // ever priced: the shared path decides
  if (typeof q?.attemptedAt === "string" && nowMs - Date.parse(q.attemptedAt) < TOKEN_PROBE_RETRY_MS) return false;
  return true;
}

/**
 * What one token's probe step did:
 *   NOT_NEEDED  it has a marker (ever priced, or asked within the window) — no probe;
 *   NEVER_HELD  no positive balance in its rows — nothing to value, no probe;
 *   PROBED      sent through the quote path (one attempt recorded, whatever it answered);
 *   REFUSED     needed a probe, but the durable allowance was 0 (or unreadable) —
 *               the token stays NOT_VALUED_YET; callers REPORT this, never silent.
 */
export type TokenProbeStep = { outcome: "NOT_NEEDED" | "NEVER_HELD" | "PROBED" | "REFUSED"; calls: number };

/**
 * One token's first-time probe. `held` is asked only when a probe is needed
 * (it may be a database read; a throw propagates, nothing spent). The allowance is re-read before EVERY probe:
 * acquisitions between probes spend the same TOKEN share.
 */
export async function firstTimeQuoteProbe(args: {
  client: Client;
  target: TokenQuoteTarget;
  metadata: unknown;
  held: () => boolean | Promise<boolean>;
  gate: TokenProbeGate;
  probe?: TokenQuoteProbe;
  nowMs: number;
}): Promise<TokenProbeStep> {
  if (!needsQuoteProbe(args.metadata, args.nowMs)) return { outcome: "NOT_NEEDED", calls: 0 };
  // An unreadable held fact throws to the caller (no spend; the caller's own retry applies).
  if (!(await args.held())) return { outcome: "NEVER_HELD", calls: 0 };
  if ((await args.gate.allowance().catch(() => 0)) <= 0) return { outcome: "REFUSED", calls: 0 };
  let calls = 0;
  try { calls = await (args.probe ?? defaultTokenQuoteProbe)(args.target, args.client); }
  catch { /* a probe is an outcome; the token stays NOT_VALUED_YET and is disclosed */ }
  finally { await args.gate.record(1).catch(() => undefined); }
  return { outcome: "PROBED", calls };
}
