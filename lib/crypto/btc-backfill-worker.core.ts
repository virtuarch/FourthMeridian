/**
 * lib/crypto/btc-backfill-worker.core.ts
 *
 * PURE. The background history worker's BITCOIN decisions — which wallets run,
 * in what order, on what budget. jobs/sol-history-backfill.ts executes them in
 * the same job as Solana (one job, one dispatcher claim, one wake budget).
 *
 * Bitcoin is a DIFFERENT PROVIDER (keyless Esplora, blockstream.info by
 * default) from Solana's Alchemy RPC, so it has its own token bucket and its own
 * daily request cap — one shared bucket would let either chain's backlog spend
 * the other provider's allowance. The semantics are Solana's: off unless the
 * worker is on, durable per-wallet usage summed into the cap, fair order.
 *
 * Eligible: BTC wallets whose history the resumable backfill owns (a checkpoint
 * on `Connection.historyCheckpoint`). Every other BTC wallet keeps the wholesale
 * reconstruction its syncs already run.
 */

import { backfillStatus, shouldRunAutomatically, type BtcBackfillCheckpoint } from "./btc-history-backfill.core";
import { btcWorkerEnabled } from "./btc-history-backfill";

export interface BtcBackfillWorkerConfig {
  enabled: boolean;
  /** Per-wallet wall clock within a run (fairness). */
  walletBudgetMs: number;
  /** Do not START a wallet with less than this left. */
  startReserveMs: number;
  /** Esplora request rate across every BTC wallet in the run. */
  maxRequestsPerSecond: number;
  /** Esplora requests per UTC day across all BTC backfills (worker + syncs). */
  dailyRequestCap: number;
}

const num = (env: Record<string, string | undefined>, k: string, d: number, min: number, max: number) => {
  const n = Number(env[k]);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

/** Env-configured, clamped. A bad value falls back to the default, never to "unlimited". */
export function btcWorkerConfig(env: Record<string, string | undefined> = process.env): BtcBackfillWorkerConfig {
  return {
    enabled:              btcWorkerEnabled(env),
    walletBudgetMs:       num(env, "BTC_BACKFILL_WALLET_BUDGET_MS", 60_000, 5_000, 200_000),
    startReserveMs:       num(env, "BTC_BACKFILL_START_RESERVE_MS", 15_000, 1_000, 60_000),
    // Public Esplora is keyless and shared: conservative by default.
    maxRequestsPerSecond: num(env, "BTC_BACKFILL_MAX_RPS", 4, 1, 50),
    dailyRequestCap:      num(env, "BTC_BACKFILL_DAILY_REQUEST_CAP", 20_000, 0, 2_000_000),
  };
}

export interface BtcBackfillCandidate { accountId: string; connectionId: string; cursor: string | null }

/**
 * Who runs, in order. Skipped: COMPLETE (new activity is the sync's head),
 * RECOVERY_REQUIRED (operator), FAILED within its daily pause.
 * Order: never progressed → least recently progressed → account id.
 */
export function orderBtcCandidates<T extends BtcBackfillCandidate & { checkpoint: BtcBackfillCheckpoint | null }>(rows: readonly T[], nowMs: number): T[] {
  return rows
    .filter((r) => {
      const s = backfillStatus(r.checkpoint).state;
      if (s === "COMPLETE" || s === "RECOVERY_REQUIRED") return false;
      return shouldRunAutomatically(r.checkpoint, nowMs).run;
    })
    .sort((a, b) => (a.checkpoint?.lastProgressAtISO ?? "").localeCompare(b.checkpoint?.lastProgressAtISO ?? "") || a.accountId.localeCompare(b.accountId));
}

/**
 * Request model for ONE address's full history: one `/txs/chain` page per 25
 * transactions (+1 for the short last page), plus one tip and one chain_stats
 * read per run. Keyless — no unit cost; the cap bounds load on the provider.
 */
export function btcRequestsForHistory(transactions: number, runs = 1): number {
  return Math.floor(transactions / 25) + 1 + runs * 2;
}
