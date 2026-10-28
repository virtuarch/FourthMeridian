/**
 * lib/crypto/sol-backfill-worker.core.ts
 *
 * PURE. The background Solana history worker's decisions (owner decision 2,
 * 2026-10-28): which wallets run, in what order, on what budget, and what it
 * costs. jobs/sol-history-backfill.ts executes them.
 *
 *   - FAIR: wallets that have waited longest since their last progress go
 *     first; a wallet that has never started goes before all of them. One
 *     wallet's backlog can never starve another's, because each run gives each
 *     wallet at most `walletBudgetMs`.
 *   - BOUNDED: a job budget (wall clock), a per-wallet budget, a global request
 *     rate (one token bucket for every wallet in the run — the job is the only
 *     writer, the JobRun claim guarantees one instance), and a DAILY request cap
 *     read from the job's own ledger. Nothing here can spend without limit.
 *   - OFF BY DEFAULT: `SOL_BACKFILL_ENABLED=true` turns it on, after the owner
 *     has seen the cost model below.
 */

import { backfillStatus, shouldRunAutomatically, type SolBackfillCheckpoint } from "./sol-history-backfill.core";

export interface SolBackfillWorkerConfig {
  enabled: boolean;
  /** Whole-job wall clock. Shares the dispatcher's 300 s invocation with other jobs. */
  jobBudgetMs: number;
  /** Per-wallet wall clock within a run (fairness). */
  walletBudgetMs: number;
  /** Do not START a wallet with less than this left. */
  startReserveMs: number;
  /** Global provider request rate across every wallet in the run. */
  maxRequestsPerSecond: number;
  /** In-flight transaction fetches per wallet. */
  concurrency: number;
  /** Provider requests per UTC day across all runs of this job. */
  dailyRequestCap: number;
}

const num = (env: Record<string, string | undefined>, k: string, d: number, min: number, max: number) => {
  const n = Number(env[k]);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

/** Env-configured, clamped to safe bounds. A bad value falls back to the default, never to "unlimited". */
export function workerConfig(env: Record<string, string | undefined> = process.env): SolBackfillWorkerConfig {
  return {
    enabled: env.SOL_BACKFILL_ENABLED === "true",
    jobBudgetMs:          num(env, "SOL_BACKFILL_JOB_BUDGET_MS", 120_000, 10_000, 240_000),
    walletBudgetMs:       num(env, "SOL_BACKFILL_WALLET_BUDGET_MS", 60_000, 5_000, 200_000),
    startReserveMs:       num(env, "SOL_BACKFILL_START_RESERVE_MS", 15_000, 1_000, 60_000),
    maxRequestsPerSecond: num(env, "SOL_BACKFILL_MAX_RPS", 10, 1, 200),
    concurrency:          num(env, "SOL_BACKFILL_CONCURRENCY", 4, 1, 16),
    dailyRequestCap:      num(env, "SOL_BACKFILL_DAILY_REQUEST_CAP", 100_000, 0, 10_000_000),
  };
}

export interface BackfillCandidate {
  accountId: string;
  connectionId: string;
  cursor: string | null;
  address: string;
}

/**
 * Who runs, in order. Skipped: COMPLETE (new activity is the normal sync's
 * head), RECOVERY_REQUIRED (operator), FAILED within its daily pause.
 * Order: never started → least recently progressed.
 */
export function orderCandidates(
  rows: readonly (BackfillCandidate & { checkpoint: SolBackfillCheckpoint | null })[],
  nowMs: number,
): Array<BackfillCandidate & { checkpoint: SolBackfillCheckpoint | null }> {
  return rows
    .filter((r) => {
      const s = backfillStatus(r.checkpoint).state;
      if (s === "COMPLETE" || s === "RECOVERY_REQUIRED" || s === "UNAVAILABLE") return false;
      return shouldRunAutomatically(r.checkpoint, nowMs).run;
    })
    .sort((a, b) => {
      const ka = a.checkpoint?.lastProgressAtISO ?? "";
      const kb = b.checkpoint?.lastProgressAtISO ?? "";
      return ka.localeCompare(kb) || a.accountId.localeCompare(b.accountId);
    });
}

/** A token bucket: `take()` resolves when a request may be sent. One per run. */
export function createRateLimiter(rps: number, now: () => number, sleep: (ms: number) => Promise<void>) {
  const interval = 1000 / rps;
  let next = now();
  return async function take(): Promise<void> {
    const t = now();
    const at = Math.max(t, next);
    next = at + interval;
    if (at > t) await sleep(at - t);
  };
}

// ── Cost and throughput model ────────────────────────────────────────────────

/**
 * Provider request model for ONE wallet's full history: one getTransaction per
 * signature, one getSignaturesForAddress per 1,000 signatures, plus at most one
 * deferred slot re-fetched per page (sol-history-backfill.ts). Head activity
 * after completion is the normal wallet sync's, not this job's.
 */
export function requestsForHistory(transactions: number): { getTransaction: number; getSignaturesForAddress: number; total: number } {
  const pages = Math.ceil(transactions / 1000) || 1;
  const getTransaction = transactions + pages; // + ≤1 deferred re-fetch per page
  return { getTransaction, getSignaturesForAddress: pages, total: getTransaction + pages };
}

export interface ProviderPricing {
  name: string;
  /** Compute/credit units per call. */
  unitsPerGetTransaction: number;
  unitsPerGetSignatures: number;
  /** USD per 1M units on the plan being modelled. */
  usdPerMillionUnits: number;
}

/** Alchemy Solana, pay-as-you-go (alchemy.com/docs/reference/compute-unit-costs, /pricing — read 2026-10-28). */
export const ALCHEMY_PAYG: ProviderPricing = { name: "Alchemy pay-as-you-go", unitsPerGetTransaction: 40, unitsPerGetSignatures: 40, usdPerMillionUnits: 0.52 };

export function estimateBackfill(transactions: number, cfg: Pick<SolBackfillWorkerConfig, "maxRequestsPerSecond" | "jobBudgetMs" | "dailyRequestCap">, pricing: ProviderPricing = ALCHEMY_PAYG, runsPerDay = 96) {
  const r = requestsForHistory(transactions);
  const units = r.getTransaction * pricing.unitsPerGetTransaction + r.getSignaturesForAddress * pricing.unitsPerGetSignatures;
  const usd = (units / 1e6) * pricing.usdPerMillionUnits;
  // Rate-bound processing time; each run contributes at most jobBudgetMs.
  const processingSeconds = r.total / cfg.maxRequestsPerSecond;
  const runs = Math.ceil(processingSeconds / (cfg.jobBudgetMs / 1000));
  const perDayByRate = (cfg.jobBudgetMs / 1000) * cfg.maxRequestsPerSecond * runsPerDay;
  const perDay = Math.min(perDayByRate, cfg.dailyRequestCap);
  const days = r.total / perDay;
  return { requests: r, units, usd, processingSeconds, runs, requestsPerDay: perDay, elapsedHoursAlone: Math.max(runs * 0.25, days * 24) };
}
