/**
 * lib/platform/wallet-history-recovery.core.ts  (OPS — audited per-wallet history recovery)
 *
 * PURE. The decisions behind Platform Ops' "Resume history" for ONE wallet
 * connection (I/O: ./wallet-history-recovery.ts; route:
 * app/api/platform/platform-ops/connections/[id]/history-resume/route.ts).
 *
 * A wallet whose resumable history is RECOVERY_REQUIRED or FAILED is
 * deliberately not retried by the background worker (FAILED only after its
 * daily pause). Until now an operator could only resume it in code. This is the
 * operator lever, narrowed to exactly what the chains' existing `resume` option
 * already means (runSolHistoryBackfill / runBtcHistoryBackfill /
 * runEthHistoryBackfill):
 *
 *   ELIGIBLE      a WALLET connection, ACTIVE, with ONE live wallet account on
 *                 SOL / BTC / ETH whose history link IS this connection, and a
 *                 checkpoint of that chain in RECOVERY_REQUIRED or FAILED.
 *                 QUEUED / IMPORTING are refused: the worker already carries
 *                 them on cadence, and none of the three chains records a
 *                 "stalled" import distinctly — a stall surfaces as FAILED once
 *                 its failures reach the threshold, which IS eligible.
 *   WORKER FLAG   the chain's worker flag must be ON (historyWorkerEnabledFor).
 *                 The flags keep history workers off until activation per
 *                 environment; an operator pass must not become a way to run
 *                 one where it is off, and the follow-through (further passes,
 *                 the wealth-history regeneration this pass marks owed) IS the
 *                 worker's. Off ⇒ refused "worker disabled for <chain>".
 *   BUDGET        the SAME shared daily cap the worker spends: Alchemy for SOL
 *                 and ETH (SOL_BACKFILL_DAILY_REQUEST_CAP, both networks),
 *                 Esplora for BTC (BTC_BACKFILL_DAILY_REQUEST_CAP), read from
 *                 the provider ledger (ApiUsageCounter), never below this
 *                 wallet's own checkpoint usage. Exhausted ⇒ refused before
 *                 the lock, nothing touched.
 *   NO RESET      nothing here deletes rows, licences or checkpoints. Persisted
 *                 history stays exactly as it is; a pass only adds proof.
 *
 * Facts only cross this module: states, dates, counts, failure CODES. Never an
 * address, a balance, or provider text.
 */

import { walletHistoryCheckpointStatus, type WalletHistoryCheckpointStatus } from "@/lib/crypto/history-checkpoint-status";
import { effectiveDailyUsage, type LedgerCalls } from "@/lib/usage/provider-budget.core";

export const RESUMABLE_CHAINS = ["SOL", "BTC", "ETH"] as const;
export type ResumableChain = (typeof RESUMABLE_CHAINS)[number];

/** The states an operator may resume. Everything else continues (or is done) on its own. */
export const RESUMABLE_STATES: readonly string[] = ["RECOVERY_REQUIRED", "FAILED"];

export function isResumableChain(v: unknown): v is ResumableChain {
  return typeof v === "string" && (RESUMABLE_CHAINS as readonly string[]).includes(v);
}

/** A wallet chain as FinancialAccount stores it ("eth", " SOL ") → the canonical code, or null. */
export function normalizeChain(raw: string | null | undefined): string | null {
  const k = raw?.trim().toUpperCase();
  return k ? k : null;
}

/** What the server re-reads about the TARGET connection before acting. No address, no balance. */
export interface WalletHistoryTarget {
  connectionId: string;
  provider: string;
  status: string;
  /** Live wallet accounts (not deleted, with an address) linked to this connection. */
  accountIds: string[];
  /** The single account's chain, normalized; null when there is not exactly one account. */
  chain: string | null;
  /** The connection the chain's history store binds for that account (canonical first, then oldest). */
  historyLinkConnectionId: string | null;
  /** Connection.cursor — Solana's checkpoint (read only through isSolBackfillCursor). */
  cursor: string | null;
  /** Connection.historyCheckpoint — Bitcoin's or Ethereum's. */
  historyCheckpoint: string | null;
  /** Connection.syncLockedAt — the per-wallet sync lock. */
  lockedAt: Date | null;
}

export type RecoveryRefusalCode =
  | "NOT_FOUND" | "NOT_A_WALLET" | "NOT_ACTIVE" | "NO_WALLET_ACCOUNT" | "UNSUPPORTED_CHAIN" | "NOT_HISTORY_LINK"
  | "NO_CHECKPOINT" | "WRONG_STATE" | "WORKER_DISABLED" | "NOT_ADMITTED" | "BUDGET_EXHAUSTED" | "ALREADY_RUNNING";

export const REFUSAL_HTTP_STATUS: Readonly<Record<RecoveryRefusalCode, number>> = {
  NOT_FOUND: 404,
  NOT_A_WALLET: 422, NO_WALLET_ACCOUNT: 422, UNSUPPORTED_CHAIN: 422, NOT_HISTORY_LINK: 422,
  NOT_ACTIVE: 409, NO_CHECKPOINT: 409, WRONG_STATE: 409, WORKER_DISABLED: 409, BUDGET_EXHAUSTED: 409, ALREADY_RUNNING: 409,
  // A platform condition (maintenance / ingestion paused), not a permissions problem.
  NOT_ADMITTED: 503,
};

export interface RecoveryRefusal { code: RecoveryRefusalCode; message: string }

/** The checkpoint status for THIS chain's column only — never another chain's relabelled. */
export function chainCheckpointStatus(target: Pick<WalletHistoryTarget, "cursor" | "historyCheckpoint">, chain: ResumableChain, todayISO: string): WalletHistoryCheckpointStatus | null {
  const st = chain === "SOL"
    ? walletHistoryCheckpointStatus(target.cursor, null, todayISO)
    : walletHistoryCheckpointStatus(null, target.historyCheckpoint, todayISO);
  return st && st.chain === chain ? st : null;
}

export type Eligibility =
  | { ok: true; chain: ResumableChain; accountId: string; status: WalletHistoryCheckpointStatus }
  | { ok: false; refusal: RecoveryRefusal; chain: string | null; status: WalletHistoryCheckpointStatus | null };

/**
 * May this connection be resumed now (ignoring admission, budget and the lock,
 * which need I/O)? The order is the order an operator would want to be told.
 */
export function decideEligibility(
  target: WalletHistoryTarget | null, ctx: { todayISO: string; workerEnabled: (chain: ResumableChain) => boolean },
): Eligibility {
  const no = (code: RecoveryRefusalCode, message: string, chain: string | null = null, status: WalletHistoryCheckpointStatus | null = null): Eligibility =>
    ({ ok: false, refusal: { code, message }, chain, status });
  if (!target) return no("NOT_FOUND", "Connection not found.");
  if (target.provider !== "WALLET") return no("NOT_A_WALLET", "History recovery applies to self-custody wallet connections only.");
  if (target.status !== "ACTIVE") return no("NOT_ACTIVE", `The connection is ${target.status}; only an ACTIVE wallet can be resumed.`);
  if (target.accountIds.length !== 1) {
    return no("NO_WALLET_ACCOUNT", target.accountIds.length === 0
      ? "No live wallet account is linked to this connection."
      : "More than one wallet account is linked to this connection; resume is per wallet.");
  }
  const chain = target.chain;
  if (!isResumableChain(chain)) return no("UNSUPPORTED_CHAIN", `Resumable history exists for SOL, BTC and ETH only (this wallet: ${chain ?? "unknown"}).`, chain);
  if (target.historyLinkConnectionId !== target.connectionId) {
    return no("NOT_HISTORY_LINK", "This wallet's history is kept on another of its connections; resume that one.", chain);
  }
  const status = chainCheckpointStatus(target, chain, ctx.todayISO);
  if (!status) return no("NO_CHECKPOINT", `This wallet has no resumable ${chain} history checkpoint.`, chain);
  if (!RESUMABLE_STATES.includes(status.state)) {
    return no("WRONG_STATE", `History is ${status.state}; only RECOVERY_REQUIRED or FAILED can be resumed (the worker carries the rest).`, chain, status);
  }
  if (!ctx.workerEnabled(chain)) return no("WORKER_DISABLED", `The history worker is disabled for ${chain} in this environment.`, chain, status);
  return { ok: true, chain, accountId: target.accountIds[0], status };
}

/** The bounded configuration one operator pass runs under (from the chain's worker config). */
export interface PassLimits {
  /** Provider requests per UTC day for this chain's provider (the worker's cap). */
  dailyRequestCap: number;
  /** ETH: the configured per-step probe budget. */
  probeBudget?: number;
}

export interface PassBudget {
  dailyRequestCap: number;
  /** Requests already spent today on this chain's provider (ledger, never below the checkpoint). */
  usedToday: number;
  remaining: number;
  exhausted: boolean;
  /** SOL / BTC: the pass's request allowance. */
  requestBudget: number;
  /** ETH: the pass's probe budget (each probe ≈ 3 calls + evidence). */
  probeBudget: number;
}

/**
 * The shared daily budget for one pass, read like the worker reads it:
 *   SOL  Alchemy ledger (every network) with the Solana part never below the
 *        wallet's own checkpoint usage (effectiveDailyUsage);
 *   ETH  the SAME Alchemy cap; Ethereum's part never below its checkpoint;
 *   BTC  Esplora ledger, never below the wallet's checkpoint.
 * An unreadable ledger (null) falls back to the checkpoint alone.
 */
export function passBudget(
  chain: ResumableChain, limits: PassLimits, ledger: LedgerCalls | null, checkpointCalls: number,
  probeBudgetFor?: (allowanceCalls: number, configured: number) => number,
): PassBudget {
  const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const own = pos(checkpointCalls);
  let used: number;
  if (chain === "SOL") used = effectiveDailyUsage({ ledger, checkpointCalls: own });
  else if (chain === "ETH") used = ledger ? pos(ledger.solana) + Math.max(pos(ledger.other), own) : own;
  else used = Math.max(ledger ? pos(ledger.solana) + pos(ledger.other) : 0, own);
  const remaining = Math.max(0, limits.dailyRequestCap - used);
  const probeBudget = chain === "ETH" && probeBudgetFor ? probeBudgetFor(remaining, limits.probeBudget ?? 0) : 0;
  const exhausted = chain === "ETH" ? probeBudget <= 0 : remaining <= 0;
  return { dailyRequestCap: limits.dailyRequestCap, usedToday: used, remaining, exhausted, requestBudget: chain === "ETH" ? 0 : remaining, probeBudget };
}

/** What one bounded pass reports (any chain), in facts only. */
export interface PassResult {
  /** The chain runner's own stop word (COMPLETE, BUDGET, PROBE_BUDGET, FAILURE, FAILED, GAP, RECOVERY, CONFLICT…). */
  stoppedBecause: string;
  rowsWritten: number;
  impactedFromISO: string | null;
  failureCode: string | null;
}

/** A compact view of a checkpoint status for the audit envelope and the response. */
export interface HistoryStateView {
  state: string;
  lastFailureCode: string | null;
  failures: number;
  verifiedFromISO: string | null;
  verifiedToISO: string | null;
  headVerified: boolean;
  processed: { count: number; unit: "signatures" | "transactions" | "movements" };
  nextAutomaticRetryISO: string | null;
}

export function stateView(st: WalletHistoryCheckpointStatus | null): HistoryStateView | null {
  if (!st) return null;
  return {
    state: st.state, lastFailureCode: st.lastFailureCode, failures: st.failures,
    verifiedFromISO: st.historyFromISO, verifiedToISO: st.historyToISO, headVerified: st.headVerified,
    processed: st.processed, nextAutomaticRetryISO: st.nextAutomaticRetryISO,
  };
}

export interface ResumeSummary {
  /** SUCCESS when the pass ran and left the wallet neither FAILED nor RECOVERY_REQUIRED. */
  result: "SUCCESS" | "FAILURE";
  after: HistoryStateView | null;
  moreWorkRemains: boolean;
  continuesAutomatically: boolean;
  regenerationPending: boolean;
}

/** The outcome of one pass, as the operator is told it. */
export function summarizePass(
  after: WalletHistoryCheckpointStatus | null, pass: PassResult, opts: { workerEnabled: boolean; regenerationPending: boolean },
): ResumeSummary {
  const view = stateView(after);
  const state = view?.state ?? "UNKNOWN";
  const failed = pass.failureCode !== null || state === "FAILED" || state === "RECOVERY_REQUIRED" || state === "UNKNOWN";
  const moreWorkRemains = state !== "COMPLETE" || opts.regenerationPending;
  // The worker picks up QUEUED / IMPORTING on cadence, a FAILED wallet after its
  // pause, and an owed regeneration first thing. RECOVERY_REQUIRED waits for an operator.
  const autoState = state === "QUEUED" || state === "IMPORTING" || (state === "FAILED" && view?.nextAutomaticRetryISO != null);
  const continuesAutomatically = opts.workerEnabled && moreWorkRemains && (autoState || (opts.regenerationPending && state !== "RECOVERY_REQUIRED"));
  return { result: failed ? "FAILURE" : "SUCCESS", after: view, moreWorkRemains, continuesAutomatically, regenerationPending: opts.regenerationPending };
}

/** The required operator note on this action (in addition to the reason code). */
export const RESUME_NOTE_REQUIRED = "A note explaining why this wallet is being resumed is required.";
