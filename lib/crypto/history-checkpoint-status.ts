/**
 * lib/crypto/history-checkpoint-status.ts
 *
 * No database access. One reader for every resumable history checkpoint a wallet connection
 * can carry, in the SOL/BTC/ETH shared vocabulary (QUEUED / IMPORTING /
 * COMPLETE / FAILED / RECOVERY_REQUIRED):
 *
 *   Connection.cursor             Solana's checkpoint (sol-history-backfill.core)
 *   Connection.historyCheckpoint  Bitcoin's (btc-history-backfill.core) or
 *                                 Ethereum's (eth-history-backfill.core)
 *
 * Connections (walletHistory.historyImport) and Platform Ops
 * (connection-diagnostics historyBackfill) read through here so each chain is
 * reported truthfully and none is relabelled as another: `signaturesProcessed`
 * is Solana's alone; Bitcoin's transactions and Ethereum's movements are
 * `processed` with their own label. States, dates, counts and failure CODES
 * only — no address, no balance, no provider text.
 */

import { statusFromCursor } from "./sol-history-backfill.core";
import {
  parseCheckpoint as parseBtcCheckpoint, backfillStatus as btcBackfillStatus, usageOn as btcUsageOn,
  BTC_BACKFILL_KIND, FAILED_RETRY_INTERVAL_MS as BTC_FAILED_RETRY_INTERVAL_MS,
} from "./btc-history-backfill.core";
import { ethStatusFromCursor, ethWorkerEnabled } from "./eth-history-backfill.core";
import { btcWorkerEnabled } from "./btc-history-backfill";

export interface WalletHistoryCheckpointStatus {
  chain: "SOL" | "BTC" | "ETH";
  state: string;
  mode: "DIRECT" | "STAGING";
  historyFromISO: string | null;
  historyToISO: string | null;
  headVerified: boolean;
  failures: number;
  lastFailureCode: string | null;
  nextAutomaticRetryISO: string | null;
  lastProgressAtISO: string | null;
  /** Solana signatures; 0 for the other chains (they have none). */
  signaturesProcessed: number;
  /** What was processed, in the chain's own unit. */
  processed: { count: number; unit: "signatures" | "transactions" | "movements" };
  requestsToday: number;
  legacyDiscrepancyDays: number | null;
}

function btcStatus(raw: string | null | undefined, todayISO: string): WalletHistoryCheckpointStatus | null {
  if (!raw) return null;
  let accountId: unknown;
  try { const v = JSON.parse(raw) as { kind?: unknown; accountId?: unknown }; if (v?.kind !== BTC_BACKFILL_KIND) return null; accountId = v.accountId; }
  catch { return null; }
  if (typeof accountId !== "string") return null;
  const cp = parseBtcCheckpoint(raw, accountId);
  if (!cp) return null;
  const st = btcBackfillStatus(cp);
  return {
    chain: "BTC", state: st.state, mode: cp.mode === "STAGING" ? "STAGING" : "DIRECT",
    historyFromISO: st.historyFromISO, historyToISO: st.historyToISO, headVerified: st.headVerified,
    failures: cp.failures, lastFailureCode: st.lastFailureCode,
    nextAutomaticRetryISO: st.state === "FAILED" && cp.lastFailure
      ? new Date(Date.parse(cp.lastFailure.atISO) + BTC_FAILED_RETRY_INTERVAL_MS).toISOString() : null,
    lastProgressAtISO: st.lastProgressAtISO, signaturesProcessed: 0,
    processed: { count: st.txsProcessed, unit: "transactions" },
    requestsToday: btcUsageOn(cp, todayISO), legacyDiscrepancyDays: st.legacyDiscrepancy?.days ?? null,
  };
}

/** The status of whichever checkpoint the connection carries, or null (no claim). */
export function walletHistoryCheckpointStatus(
  cursor: string | null | undefined, historyCheckpoint: string | null | undefined, todayISO: string,
): WalletHistoryCheckpointStatus | null {
  const sol = statusFromCursor(cursor, todayISO);
  if (sol) {
    return {
      chain: "SOL", state: sol.state, mode: sol.mode, historyFromISO: sol.historyFromISO, historyToISO: sol.historyToISO,
      headVerified: sol.headVerified, failures: sol.failures, lastFailureCode: sol.lastFailureCode,
      nextAutomaticRetryISO: sol.nextAutomaticRetryISO, lastProgressAtISO: sol.lastProgressAtISO,
      signaturesProcessed: sol.signaturesProcessed, processed: { count: sol.signaturesProcessed, unit: "signatures" },
      requestsToday: sol.requestsToday, legacyDiscrepancyDays: sol.legacyDiscrepancy?.days ?? null,
    };
  }
  const eth = ethStatusFromCursor(historyCheckpoint, todayISO);
  if (eth) {
    return {
      chain: "ETH", state: eth.state, mode: "DIRECT", historyFromISO: eth.historyFromISO, historyToISO: eth.historyToISO,
      headVerified: eth.headVerified, failures: eth.failures, lastFailureCode: eth.lastFailureCode,
      nextAutomaticRetryISO: eth.nextAutomaticRetryISO, lastProgressAtISO: eth.lastProgressAtISO,
      signaturesProcessed: 0, processed: { count: eth.movementsFound, unit: "movements" },
      requestsToday: eth.requestsToday, legacyDiscrepancyDays: null,
    };
  }
  return btcStatus(historyCheckpoint, todayISO);
}

/**
 * Does history continue automatically in the background for a wallet on this
 * chain, here? Per chain, because each chain has its own gate: Solana's worker
 * (SOL_BACKFILL_ENABLED), Bitcoin's pass within it (BTC_BACKFILL_ENABLED, on
 * unless "false"), Ethereum's (ETH_BACKFILL_ENABLED=true). Other chains: false.
 */
export function historyWorkerEnabledFor(chain: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const k = chain?.trim().toUpperCase();
  if (k === "SOL") return env.SOL_BACKFILL_ENABLED === "true";
  if (k === "BTC") return btcWorkerEnabled(env);
  if (k === "ETH") return ethWorkerEnabled(env);
  return false;
}
