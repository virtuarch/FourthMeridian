/**
 * jobs/sol-history-backfill.ts
 *
 * The dedicated background worker for large Solana histories (owner decision
 * 2, 2026-10-28). With the worker enabled a wallet sync runs the backfill only
 * briefly (15 s) so the holdings refresh stays responsive; this job carries the
 * rest. With it disabled, syncs keep their standalone 45 s.
 *
 * SCHEDULING: registered `selfContinues` (lib/jobs/registry.core.ts). While any
 * eligible wallet remains it reports `deferred > 0`, and the dispatcher (every
 * 15 minutes) runs it again CONTINUATION_DELAY_MS later. One instance at a time
 * (the JobRun claim: one running row per job).
 *
 * BOUNDED, per run (decisions: lib/crypto/sol-backfill-worker.core.ts):
 *   - OFF unless SOL_BACKFILL_ENABLED=true. Turning it off is the rollback: the
 *     next wake returns at once; every checkpoint stays valid for re-enabling.
 *   - WAKE-AWARE: the dispatcher runs a wake's jobs in one 300 s invocation.
 *     The job reads when this wake started (the earliest JobRun of the last
 *     300 s) and never plans past WAKE_SAFE_MS of it, so it cannot get the
 *     invocation killed or starve the jobs after it.
 *   - DAILY CAP from DURABLE usage: every wallet checkpoint records the
 *     requests its backfill sent today — from this worker AND from wallet
 *     syncs — at every commit. SHARED PROVIDER BUDGET (2026-10-28): every
 *     Alchemy-backed history path (this worker, SOL sync history, ETH history)
 *     also records its requests in ApiUsageCounter (provider ALCHEMY), which
 *     this worker flushes WHILE each pass sends (every 100 calls / 10 s —
 *     incrementalMeter) and after each wallet. The cap reads the LARGER of the
 *     two (lib/usage/provider-budget.core.ts), so it holds across runs,
 *     overlapping triggers, runs killed mid-flight, and the other chains.
 *   - one global token bucket; per-wallet budget; fair order.
 *   - each wallet under its sync lock, renewed before regeneration and released
 *     only while still ours — a normal sync is never blocked or unlocked.
 *   - wealth history over changed days is regenerated (as a sync does, and
 *     only when WEALTH_REGENERATION_ENABLED), when enough wake time remains;
 *     otherwise it is marked pending in the checkpoint and done first next run.
 *   - PRICE GAPS (2026-10-28): before that regeneration, when the shared
 *     RAW_CLOSE archive does not reach back as far as the wallet's proven
 *     balance history and the provider can serve older dates, a bounded,
 *     per-INSTRUMENT acquisition runs through the canonical path
 *     (lib/prices/price-gap.ts) — at most DEFAULT_PRICE_GAP_MAX_INSTRUMENTS per
 *     run, deduplicated within the run. The regeneration's planner then
 *     measures the new closes. Other wallets whose licensed history the new
 *     prices reach are flagged pending — under their own sync lock when free,
 *     the checkpoint CAS retried once — so they are revalued next run. A flag
 *     that still could not be written is counted (holdersFlagFailed) and
 *     RE-DERIVED from persisted state: every run flags wallets whose
 *     valued-from precedes their Spaces' earliest snapshot, once per floor.
 *
 * Completion is the backfill's own verdict (beginning reached, head verified,
 * continuity proven) — never "the job succeeded".
 *
 * BITCOIN (2026-10-28) — the same job also carries Bitcoin wallets whose
 * history the resumable backfill owns (lib/crypto/btc-history-backfill.ts),
 * with the same lock, wake, regeneration and pending-marker semantics, its own
 * token bucket and daily cap (a different provider — keyless Esplora), and on
 * unless BTC_BACKFILL_ENABLED=false. The job name and registration are
 * unchanged.
 *
 * ETHEREUM (2026-10-28) — and Ethereum wallets whose FULL rebuild a sync
 * handed over (lib/crypto/eth-history-backfill.ts): only when
 * ETH_BACKFILL_ENABLED=true (otherwise syncs rebuild inline, as before). Each
 * step is bounded by a probe budget and resumes at the proof's boundary; rows
 * are written once, when the whole proof closes and reconciles. Its requests
 * spend the SAME Alchemy key as Solana, so they count against the SAME daily
 * cap (SOL_BACKFILL_DAILY_REQUEST_CAP), read from the shared provider ledger.
 *
 * SHARING THE RUN (2026-10-28, lib/crypto/history-worker-schedule.core.ts):
 * the chains with work run in a ROTATING order — the leader changes every run
 * (persisted in this job's summary) — and each phase gets a fair share of what
 * is left, never less than its chain needs to start a step. Every chain with
 * eligible work therefore starts a step within 3 runs whatever the others'
 * backlogs (a fixed SOL → BTC → ETH order starved Ethereum's 75 s step). A
 * single chain gets the whole budget, as before.
 *
 * PRICE GAPS FOR EVERY HOLDER (2026-10-28): each run first plans and acquires
 * historical price gaps across every licensed crypto holder (not only wallets
 * whose backfill moved), then revalues the holders the new floor reaches.
 *
 * SUMMARY: counts, request meter and estimated units only — no ids, no
 * addresses, no balances.
 */

import { parseCheckpoint, serializeCheckpoint, usageOn, type SolBackfillCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import {
  workerConfig, orderCandidates, createRateLimiter, ALCHEMY_PAYG,
  type SolBackfillWorkerConfig,
} from "@/lib/crypto/sol-backfill-worker.core";
import type { SolBackfillStore } from "@/lib/crypto/sol-history-backfill";
import type { SolResumableResult } from "@/lib/crypto/sol-history-backfill.store";
import {
  parseCheckpoint as parseBtcCheckpoint, serializeCheckpoint as serializeBtcCheckpoint, usageOn as btcUsageOn,
  type BtcBackfillCheckpoint,
} from "@/lib/crypto/btc-history-backfill.core";
import {
  btcWorkerConfig, orderBtcCandidates, ESPLORA_USAGE_PROVIDER, ESPLORA_USAGE_NETWORK, type BtcBackfillWorkerConfig,
} from "@/lib/crypto/btc-backfill-worker.core";
import type { BtcBackfillStore, BtcBackfillDeps } from "@/lib/crypto/btc-history-backfill";
import type { BtcResumableResult } from "@/lib/crypto/btc-history-backfill.store";
import {
  parseCheckpoint as parseEthCheckpoint, serializeCheckpoint as serializeEthCheckpoint, usageOn as ethUsageOn,
  ethWorkerConfig, orderEthCandidates, probeBudgetFor, stepProbeBudget, type EthBackfillCheckpoint, type EthBackfillWorkerConfig,
} from "@/lib/crypto/eth-history-backfill.core";
import type { EthBackfillStore, EthBackfillDeps, EthBackfillOutcome } from "@/lib/crypto/eth-history-backfill";
import { planErc20History, runErc20HistoryPass, type Erc20HistoryPassDeps, type Erc20HistoryPassSummary } from "@/lib/crypto/erc20-history-pass";
import {
  billableSkipCode, createBillableBatchGate, tallyBillableDenial,
  type BillableDecision, type BillableDenialTally,
} from "@/lib/entitlements/billable-gate";
import type { BillableSkipCode } from "@/lib/entitlements/billable-gate-core";
import type { GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";
import { erc20HistoryConfig, type Erc20HistoryConfig } from "@/lib/crypto/erc20-history.core";
import { SPL_PRICE_RUN_SEVERITY, type SplPriceRunStatus } from "@/lib/crypto/spl-history.core";
import { effectiveDailyUsage, incrementalMeter, meterTotal, type IncrementalMeter, type MeterRecorder } from "@/lib/usage/provider-budget.core";
import { DEFAULT_PRICE_GAP_MAX_INSTRUMENTS, REVALUATION_RESERVE_MS, REVALUATION_MAX_ATTEMPTS } from "@/lib/prices/price-gap.core";
import type { PriceGapRun, RevaluationOwed, RevaluationRun } from "@/lib/prices/price-gap";
import {
  chainOrder, nextRotation, phaseDeadlineFor, PHASE_SETUP_MS, ROTATION_LOOKBACK_RUNS, ROTATION_SLOT_MS,
  type HistoryChain, type HistoryWorkerSchedule,
} from "@/lib/crypto/history-worker-schedule.core";
import type { LedgerCalls } from "@/lib/usage/provider-budget.core";

export const SOL_BACKFILL_JOB = "sol-history-backfill";
/** The dispatcher's invocation is 300 s; plan nothing past this point of a wake. */
export const WAKE_SAFE_MS = 260_000;
/** Do not start a wealth-history regeneration with less than this left. */
export const REGEN_RESERVE_MS = 60_000;
/** At most this many state-derived revaluations are flagged per run. */
export const REVALUATION_REDERIVE_MAX = 10;
/** Extra time a price-gap acquisition needs before a regeneration (one provider request per instrument). */
export const PRICE_GAP_RESERVE_MS = 15_000;

export interface SolBackfillJobSummary {
  enabled: boolean;
  eligible: number;
  walletsRun: number;
  walletsSkippedLocked: number;
  completed: number;
  promoted: number;
  failures: Record<string, number>;
  signaturesProcessed: number;
  rowsWritten: number;
  regenerated: number;
  regenerationsDeferred: number;
  requests: Record<string, number> & { total: number };
  /** Estimated provider units at the modelled price (Alchemy PAYG), for observability only. */
  estimatedUnits: number;
  /**
   * Today's requests counted against the cap before this run: the larger of
   * every SOL checkpoint's usage and the shared provider ledger (ALCHEMY).
   */
  dailyRequestsUsedBefore: number;
  /** The shared provider ledger's calls today before this run (null: unreadable or not wired). */
  providerRequestsUsedBefore: number | null;
  /** Historical price-gap acquisition this run (per instrument, shared across customers). */
  priceGaps: { acquired: number; inserted: number; failures: number; deferred: number };
  /** Other wallets marked for regeneration because newly acquired prices reach their history. */
  holdersMarkedPending: number;
  /** Holders whose flag could not be written (lock busy AND CAS lost twice) — re-derived from state next run. */
  holdersFlagFailed: number;
  /** Wallets flagged this run because PERSISTED state says they are owed a revaluation (self-healing a lost flag). */
  revaluationsRederived: number;
  /** The all-holder price-gap pass (every licensed crypto holder, every chain), when wired. */
  priceGapSweep?: { holders: number; skippedForTime: boolean };
  /** Crypto holders (every chain) revalued (state-derived, once per evidence state; existing rows included). */
  holderRevaluation?: { holders: number; owed: number; revalued: number; chunksRebuilt: number; deferred: number; alreadyRevalued: number;
    abandonedBlocks: number; rowsStampedUnavailable: number; rowsStampedPending?: number; failures: number; skippedForTime: boolean };
  /** A revaluation was owed at the start of the run, so its slice of the budget was reserved after the leader. */
  revaluationReserved?: boolean;
  /** This run's chain rotation and pass order — persisted, read back by the next run. Absent on a NO_WORK run. */
  schedule?: HistoryWorkerSchedule;
  dailyRequestCap: number;
  budgetMs: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "ALL_RUN" | "NOT_ADMITTED" | "COST_FREEZE";
  /** > 0 ⇒ the dispatcher self-continues this job (Solana + Bitcoin). */
  deferred: number;
  /** BETA LIFECYCLE L2 — the platform admission reason when the run was not admitted (maintenance / ingestion paused). */
  notAdmitted?: string;
  /** BETA LIFECYCLE L2 — the billable skip code when the GLOBAL cost freeze (or an unreadable flag) stopped the whole run. */
  platformSkipped?: BillableSkipCode;
  /**
   * BETA LIFECYCLE L2 — wallets (any chain) whose billed owner may not cause
   * paid work: frozen / paused / ended / unverifiable / deactivated / NO owner.
   * Skipped before their lock, with their checkpoints untouched (they resume
   * from them when the restriction lifts); never counted as `deferred`, so
   * the self-continuation does not spin on them. Reasons in `planRestrictedReasons`.
   */
  planRestricted?: number;
  planRestrictedReasons?: BillableDenialTally;
  /** Bitcoin's pass, when its deps are wired (always in production). */
  btc?: BtcBackfillPassSummary;
  /** Ethereum's pass, when enabled and wired. */
  eth?: EthBackfillPassSummary;
  /** ERC-20 token history's pass (lib/crypto/erc20-history-pass.ts) — part of Ethereum's phase. */
  ethTokens?: Erc20HistoryPassSummary;
  /** Re-review F4 — SPL historical price acquisition, when any wallet's stopped short (absent ⇒ none did). */
  splPrices?: { status: Exclude<SplPriceRunStatus, "COMPLETE">; reason: string | null; mintsSkipped: number; wallets: number };
  /**
   * THE JOB'S OWN OUTCOME (re-review F4) — a SUMMARY field, read from
   * `JobRun.summary.outcome` / `JobRun.summary.partialReasons` (Platform Ops can
   * surface it later). Deliberately NOT the JobRun status: `lib/jobs/run.ts`
   * `succeeded | failed` is a shared contract meaning "did the run crash", and a
   * budget stop is by design, not a failure — the run still SUCCEEDS.
   *
   *   outcome "COMPLETE"  every historical token price run asked what it owed;
   *   outcome "PARTIAL"   a token price run (SPL or ERC-20) stopped short: the
   *                       CoinGecko token budget, an exhausted probe allowance,
   *                       or the per-run token limit — the rest resumes later.
   *   partialReasons      one entry per stop, `<SPL|ERC20>_PRICES_<STATUS>: <why>`
   *                       (e.g. "SPL_PRICES_BUDGET_STOPPED: CoinGecko token budget
   *                       reached; …"); empty when COMPLETE. Set on every return.
   */
  outcome?: "COMPLETE" | "PARTIAL" | "SKIPPED";
  /** BETA LIFECYCLE L2 — the skip code when outcome is SKIPPED (job health reads it). */
  skipReason?: string;
  partialReasons?: string[];
}

/** PURE (re-review F4) — the job's outcome from its summary: PARTIAL when any token price run stopped short. */
export function solBackfillJobOutcome(s: Pick<SolBackfillJobSummary, "splPrices" | "ethTokens"> & Partial<Pick<SolBackfillJobSummary, "holderRevaluation">>): { outcome: "COMPLETE" | "PARTIAL"; partialReasons: string[] } {
  const reasons: string[] = [];
  const abandoned = s.holderRevaluation?.abandonedBlocks ?? 0;
  if (abandoned > 0) reasons.push(revaluationAbandonedReason(abandoned, s.holderRevaluation?.rowsStampedUnavailable ?? 0));
  if (s.splPrices) reasons.push(`SPL_PRICES_${s.splPrices.status}: ${s.splPrices.reason ?? s.splPrices.status}`);
  const erc = s.ethTokens?.prices;
  if (erc && erc.status !== "COMPLETE") reasons.push(`ERC20_PRICES_${erc.status}: ${erc.reason ?? erc.status}`);
  return { outcome: reasons.length > 0 ? "PARTIAL" : "COMPLETE", partialReasons: reasons };
}

/** The PARTIAL reason for revaluation blocks abandoned at the attempt cap (shared by the worker and sync-crypto). */
export function revaluationAbandonedReason(blocks: number, rowsStamped: number): string {
  return `REVALUATION_ABANDONED: ${blocks} block(s) failed ${REVALUATION_MAX_ATTEMPTS} rebuilds; their estimate rows are stamped unavailable (${rowsStamped} this run), never shown as complete`;
}

export interface EthBackfillPassSummary {
  enabled: boolean;
  eligible: number;
  walletsRun: number;
  walletsSkippedLocked: number;
  completed: number;
  failures: Record<string, number>;
  rowsWritten: number;
  regenerated: number;
  regenerationsDeferred: number;
  requests: { total: number };
  /** The shared Alchemy budget already spent today before this pass (every network). */
  dailyRequestsUsedBefore: number;
  dailyRequestCap: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "ALL_RUN";
  deferred: number;
}

/** An ETH wallet whose full rebuild the worker owns; `cursor` is its history checkpoint. */
export interface EthWorkerWallet { accountId: string; connectionId: string; cursor: string | null }

/** Ethereum's half of the job's deps. Locks, regeneration and the Alchemy ledger read are shared with Solana's. */
export interface EthBackfillJobDeps {
  wallets(): Promise<EthWorkerWallet[]>;
  reconstruct(args: { accountId: string; todayISO: string; deps: EthBackfillDeps }): Promise<EthBackfillOutcome>;
  store(accountId: string): Promise<EthBackfillStore | null>;
  /** Record `meter` beyond `flushed` on the ledger under ALCHEMY/ethereum; advances `flushed`. */
  recordUsage?(meter: Readonly<Record<string, number>>, flushed: Record<string, number>): Promise<void>;
}

export interface BtcBackfillPassSummary {
  enabled: boolean;
  eligible: number;
  walletsRun: number;
  walletsSkippedLocked: number;
  completed: number;
  promoted: number;
  failures: Record<string, number>;
  txsProcessed: number;
  rowsWritten: number;
  regenerated: number;
  regenerationsDeferred: number;
  requests: Record<string, number> & { total: number };
  dailyRequestsUsedBefore: number;
  dailyRequestCap: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "ALL_RUN";
  deferred: number;
}

/** A BTC wallet whose history the resumable backfill owns; `cursor` is its history checkpoint. */
export interface BtcWorkerWallet { accountId: string; connectionId: string; cursor: string | null }

/** Bitcoin's half of the job's deps. Locks and regeneration are shared with Solana's. */
export interface BtcBackfillJobDeps {
  wallets(): Promise<BtcWorkerWallet[]>;
  reconstruct(args: { accountId: string; deps: BtcBackfillDeps }): Promise<BtcResumableResult>;
  store(accountId: string): Promise<BtcBackfillStore | null>;
  /** Today's ESPLORA calls on the shared provider ledger (ApiUsageCounter), or null. Absent ⇒ checkpoints only. */
  providerUsageToday?(dayISO: string): Promise<LedgerCalls | null>;
  /** Record `meter` beyond `flushed` on the ledger under ESPLORA; advances `flushed`. */
  recordUsage?(meter: Readonly<Record<string, number>>, flushed: Record<string, number>): Promise<void>;
}

export interface WorkerWallet { accountId: string; connectionId: string; address: string; cursor: string | null }

/** Everything the job touches — production wiring below, fakes in tests. */
export interface SolBackfillJobDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** When the current dispatcher wake began (earliest JobRun started in the last 300 s), or null. */
  wakeStartedAt(): Promise<number | null>;
  /** One row per SOL wallet ACCOUNT, on the link the history store uses. */
  wallets(): Promise<WorkerWallet[]>;
  claimLock(connectionId: string, stampMs: number): Promise<boolean>;
  /** Re-stamp only if still ours. */
  renewLock(connectionId: string, fromMs: number, toMs: number): Promise<boolean>;
  /** Release only if still ours. */
  releaseLock(connectionId: string, stampMs: number): Promise<void>;
  reconstruct(args: { accountId: string; deps: Parameters<typeof import("@/lib/crypto/sol-history-backfill")["runSolHistoryBackfill"]>[1] }): Promise<SolResumableResult>;
  store(accountId: string): Promise<SolBackfillStore | null>;
  regenerationEnabled(): boolean;
  regenerate(accountId: string, fromISO: string, startedAtMs: number): Promise<void>;
  /** Today's calls on the shared provider ledger (ALCHEMY), split Solana / other, or null. Optional: absent ⇒ checkpoints only. */
  providerUsageToday?(dayISO: string): Promise<LedgerCalls | null>;
  /** Of these accounts, those whose persisted state owes a revaluation (lib/prices/price-gap.ts revaluationOwed). */
  revaluationOwed?(accountIds: string[]): Promise<RevaluationOwed[]>;
  /** Record `meter` beyond `flushed` on the shared provider ledger; advances `flushed`. */
  recordUsage?(meter: Readonly<Record<string, number>>, flushed: Record<string, number>): Promise<void>;
  /** Detect + acquire historical price gaps for these accounts (lib/prices/price-gap.ts). */
  acquirePriceGaps?(accountIds: string[], opts: { attempted: Map<string, string>; maxInstruments: number }): Promise<PriceGapRun>;
  /** The job's previous FINISHED runs, newest first (≤ ROTATION_LOOKBACK_RUNS), for the chain rotation. Absent ⇒ rotation 0. */
  previousRuns?(): Promise<Array<{ summary: unknown }>>;
  /** Every account holding a licensed CRYPTO balance history (any chain) — the all-holder price-gap pass. */
  cryptoHolders?(): Promise<string[]>;
  /** Revalue these holders where persisted state owes it (lib/prices/price-gap.ts revalueHoldersAfterPriceGaps). */
  revalueHolders?(accountIds: string[], opts: { deadlineMs: number; attempted: Map<string, string>; maxInstruments: number }): Promise<RevaluationRun>;
  /**
   * Is any of these holders owed revaluation work under its current evidence
   * (lib/prices/price-gap.ts revaluationPending)? Reads only. When true the run
   * RESERVES REVALUATION_RESERVE_MS for it after the leader, so a history
   * backlog can no longer starve it (live 2026-10-31: BTC took the whole budget).
   */
  revaluationPending?(accountIds: string[]): Promise<boolean>;
  /**
   * BETA LIFECYCLE L2 — REQUIRED gates (production wires all three):
   *   admit           platform admission (maintenance / ingestion pause) — the worker had none;
   *   costFreeze      the GLOBAL cost freeze, before any vendor call;
   *   billableAccounts  each account's decision by its billed OWNER (one batch read;
   *                   an ownerless wallet is NO_OWNER ⇒ refused — owner ruling 2026-10-31).
   */
  admit(): Promise<Pick<StampedAdmissionVerdict, "decision" | "reason">>;
  costFreeze(): Promise<GlobalCostFreezeVerdict>;
  billableAccounts(accountIds: readonly string[]): Promise<Map<string, BillableDecision>>;
  /** Absent ⇒ the job carries Solana only. */
  btc?: BtcBackfillJobDeps;
  /** Absent ⇒ no Ethereum pass. */
  eth?: EthBackfillJobDeps;
  /** Absent ⇒ no ERC-20 token-history pass. */
  ethTokens?: Erc20HistoryPassDeps;
}

/**
 * Mutate a wallet's checkpoint with no rows (the regeneration-pending marker).
 * False ⇒ not written (CAS lost). Exported for the operator resume
 * (lib/platform/wallet-history-recovery.ts), which marks the regeneration its
 * pass owes so this worker performs it, exactly as for a deferred one.
 */
export async function setPending(store: SolBackfillStore, accountId: string, address: string, mutate: (cp: SolBackfillCheckpoint) => SolBackfillCheckpoint): Promise<boolean> {
  const raw = await store.readCursor();
  const cp = parseCheckpoint(raw, accountId, address);
  if (!cp) return false;
  const next = mutate(cp);
  try {
    await store.commit({ expectedCursor: raw, nextCursor: serializeCheckpoint(next), replaceAll: false, deleteFromISO: null, deleteToISO: null, rows: [], coverage: null });
    return true;
  } catch { return false; } // CAS lost: someone advanced it — the marker is re-derived next run
}

export async function setBtcPending(store: BtcBackfillStore, accountId: string, mutate: (cp: BtcBackfillCheckpoint) => BtcBackfillCheckpoint): Promise<boolean> {
  const raw = await store.readCursor();
  const cp = parseBtcCheckpoint(raw, accountId);
  if (!cp) return false;
  try {
    await store.commit({ expectedCursor: raw, nextCursor: serializeBtcCheckpoint(mutate(cp)), replaceAll: false, deleteFromISO: null, deleteToISO: null, rows: [], coverage: null, rawTxs: [] });
    return true;
  } catch { return false; } // CAS lost: someone advanced it — the marker is re-derived next run
}

export async function setEthPending(store: EthBackfillStore, accountId: string, mutate: (cp: EthBackfillCheckpoint) => EthBackfillCheckpoint): Promise<boolean> {
  const raw = await store.readCursor();
  const cp = parseEthCheckpoint(raw, accountId);
  if (!cp) return false;
  try { return await store.casCursor(raw, serializeEthCheckpoint(mutate(cp))); }
  catch { return false; } // the marker is re-derived next run
}

/** A pass's meter: crash-safe (flushed while it sends) when a recorder is wired, a plain counter otherwise. */
function runMeter(recordUsage: MeterRecorder | undefined, now: () => number): IncrementalMeter {
  if (!recordUsage) return { meter: {}, flushed: {}, flush: async () => {} };
  return incrementalMeter(recordUsage, { now });
}

function addPriceGaps(summary: SolBackfillJobSummary, g: PriceGapRun): void {
  summary.priceGaps.acquired += g.acquired;
  summary.priceGaps.inserted += g.inserted;
  summary.priceGaps.failures += g.failures;
  summary.priceGaps.deferred += g.decisions.filter((d) => d.kind === "DEFERRED_RUN_CAP").length;
}

export async function solHistoryBackfill(opts: { config?: SolBackfillWorkerConfig; btcConfig?: BtcBackfillWorkerConfig; ethConfig?: EthBackfillWorkerConfig; erc20Config?: Erc20HistoryConfig; deps?: SolBackfillJobDeps } = {}): Promise<SolBackfillJobSummary> {
  const cfg = opts.config ?? workerConfig();
  const summary: SolBackfillJobSummary = {
    enabled: cfg.enabled, eligible: 0, walletsRun: 0, walletsSkippedLocked: 0, completed: 0, promoted: 0,
    failures: {}, signaturesProcessed: 0, rowsWritten: 0, regenerated: 0, regenerationsDeferred: 0,
    requests: { total: 0 }, estimatedUnits: 0, dailyRequestsUsedBefore: 0, providerRequestsUsedBefore: null,
    dailyRequestCap: cfg.dailyRequestCap, priceGaps: { acquired: 0, inserted: 0, failures: 0, deferred: 0 }, holdersMarkedPending: 0,
    holdersFlagFailed: 0, revaluationsRederived: 0,
    budgetMs: 0, stoppedBecause: "DISABLED", deferred: 0, outcome: "COMPLETE", partialReasons: [],
  };
  if (!cfg.enabled) return summary;
  const deps = opts.deps ?? await productionDeps();

  // ── BETA LIFECYCLE L2 — PLATFORM GATES, BEFORE ANY READ THAT LEADS TO A VENDOR ──
  // Platform admission (the worker previously ignored a maintenance / ingestion
  // pause) and the GLOBAL cost freeze. Either refusal returns with nothing
  // claimed, no checkpoint touched and `deferred` 0 (no self-continuation spin).
  const admission = await deps.admit();
  if (admission.decision === "DENY") {
    summary.stoppedBecause = "NOT_ADMITTED";
    summary.notAdmitted = admission.reason ?? "DENIED";
    console.log(`[${SOL_BACKFILL_JOB}] NOT ADMITTED — ${summary.notAdmitted}; no wallet touched.`);
    return summary;
  }
  const freeze = await deps.costFreeze();
  if (freeze.frozen) {
    summary.stoppedBecause = "COST_FREEZE";
    summary.platformSkipped = billableSkipCode(freeze.reason!);
    summary.outcome = "SKIPPED"; summary.skipReason = summary.platformSkipped;
    console.log(`[${SOL_BACKFILL_JOB}] global cost freeze (${freeze.state}) — SKIPPED (${summary.platformSkipped}); no vendor call, no checkpoint moved.`);
    return summary;
  }
  // CRASH-SAFE metering: each meter reaches the shared ledger while its pass
  // sends (every METER_FLUSH_EVERY_CALLS calls / _MS), not only at wallet end —
  // a run killed mid-pass leaves at most one flush's worth uncounted.
  const solUsage = runMeter(deps.recordUsage, deps.now);
  const meter = solUsage.meter;
  const total = () => meterTotal(meter);
  const flushUsage = () => solUsage.flush();
  /** Ethereum spends the SAME Alchemy cap: whichever of the two runs second sees the other's calls. */
  const ethUsage = runMeter(deps.eth?.recordUsage, deps.now);
  const priceGapAttempted = new Map<string, string>();

  const start = deps.now();
  const wake = await deps.wakeStartedAt();
  const jobDeadline = Math.min(start + cfg.jobBudgetMs, (wake ?? start) + WAKE_SAFE_MS);
  summary.budgetMs = Math.max(0, jobDeadline - start);
  const day = new Date(start).toISOString().slice(0, 10);

  // Bitcoin's work is planned first so the two chains can share the budget.
  const btcCfg = opts.btcConfig ?? btcWorkerConfig();
  const btcPlan = deps.btc && btcCfg.enabled ? await planBtc(deps.btc, start, day) : null;
  let btcHasWork = !!btcPlan && btcPlan.work.length > 0;
  const ethCfgIn = opts.ethConfig ?? ethWorkerConfig();
  // A start reserve the job budget can never hold would freeze Ethereum for good:
  // clamp it (a step's probes are sized to its time, so a shorter step is safe) and say so.
  const ethCfg = ethCfgIn.enabled && ethCfgIn.startReserveMs > cfg.jobBudgetMs - PHASE_SETUP_MS
    ? (console.warn(`[${SOL_BACKFILL_JOB}] ETH_BACKFILL_START_RESERVE_MS ${ethCfgIn.startReserveMs} exceeds the job budget ${cfg.jobBudgetMs} — clamped`),
      { ...ethCfgIn, startReserveMs: Math.max(2_000, cfg.jobBudgetMs - PHASE_SETUP_MS) })
    : ethCfgIn;
  const ethPlan = deps.eth && ethCfg.enabled ? await planEth(deps.eth, start) : null;
  // ERC-20 token history is part of Ethereum's phase: it runs after the native pass, on what is left of it.
  const erc20Cfg = opts.erc20Config ?? erc20HistoryConfig();
  const tokenPlan = deps.ethTokens && erc20Cfg.enabled ? await planErc20History(deps.ethTokens, erc20Cfg, day, deps.now()) : null;
  let ethHasWork = (!!ethPlan && ethPlan.work.length > 0) || (!!tokenPlan && tokenPlan.work.length > 0);
  /** The deadline the CURRENT chain's pass plans to (lib/crypto/history-worker-schedule.core.ts). */
  let phaseDeadline = jobDeadline;

  const wallets = await deps.wallets();
  const parsedAll = wallets.map((w) => ({ ...w, checkpoint: parseCheckpoint(w.cursor, w.accountId, w.address) }));
  // Today's usage counts EVERY wallet's checkpoint, refused or not (the cap is shared).
  const checkpointCalls = parsedAll.reduce((a, w) => a + usageOn(w.checkpoint, day), 0);

  // ── BETA LIFECYCLE L2 — THE PER-WALLET BILLABLE GATE (every chain, every pass) ──
  // ONE batch read for every account the run knows (each by its billed OWNER),
  // re-read at most every BILLABLE_BATCH_MAX_AGE_MS. A refused wallet is dropped
  // from every plan BEFORE its lock, and re-asked before each lock claim, so a
  // freeze landing mid-run stops the next wallet. Checkpoints are never written.
  const accountGate = createBillableBatchGate([
    ...parsedAll.map((w) => w.accountId),
    ...(btcPlan?.work.map((x) => x.w.accountId) ?? []),
    ...(ethPlan?.work.map((x) => x.w.accountId) ?? []),
    ...(tokenPlan?.work.map((x) => x.w.accountId) ?? []),
  ], "crypto_backfill", { load: (ids) => deps.billableAccounts(ids), clock: deps.now });
  const refusedAccounts = new Set<string>();
  const allows = async (accountId: string): Promise<boolean> => {
    const d = await accountGate.decide(accountId);
    if (d.allowed) return true;
    if (!refusedAccounts.has(accountId)) {
      refusedAccounts.add(accountId);
      summary.planRestricted = (summary.planRestricted ?? 0) + 1;
      tallyBillableDenial((summary.planRestrictedReasons ??= {}), d.reason);
    }
    return false;
  };
  const allowedOnly = async <T extends { accountId: string }>(xs: readonly T[]): Promise<T[]> => {
    const out: T[] = [];
    for (const x of xs) if (await allows(x.accountId)) out.push(x);
    return out;
  };
  const parsed = await allowedOnly(parsedAll);
  if (btcPlan) { btcPlan.work = (await allowedOnly(btcPlan.work.map((x) => ({ ...x, accountId: x.w.accountId })))); btcHasWork = btcPlan.work.length > 0; }
  // (ethPlan.parsed stays whole: it only counts today's checkpoint usage, which refused wallets still spent.)
  if (ethPlan) ethPlan.work = await allowedOnly(ethPlan.work.map((x) => ({ ...x, accountId: x.w.accountId })));
  if (tokenPlan) tokenPlan.work = await allowedOnly(tokenPlan.work.map((x) => ({ ...x, accountId: x.w.accountId })));
  ethHasWork = (!!ethPlan && ethPlan.work.length > 0) || (!!tokenPlan && tokenPlan.work.length > 0);
  const ledger = deps.providerUsageToday ? await deps.providerUsageToday(day).catch(() => null) : null;
  summary.providerRequestsUsedBefore = ledger ? ledger.solana + ledger.other : null;
  summary.dailyRequestsUsedBefore = effectiveDailyUsage({ ledger, checkpointCalls });

  /**
   * Flag another wallet for revaluation from `from` under price floor
   * `floorISO`: under ITS sync lock when free (released only if still ours),
   * the checkpoint CAS retried once. False ⇒ not written; the state-derived
   * pass below re-derives it next run, so a lost flag is never permanent.
   */
  const flagHolder = async (o: (typeof parsed)[number], from: string, floorISO: string): Promise<boolean> => {
    const store = await deps.store(o.accountId);
    if (!store) return false;
    const stamp = deps.now();
    const locked = await deps.claimLock(o.connectionId, stamp).catch(() => false);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await setPending(store, o.accountId, o.address, (cp) => ({ ...cp, valuationCheckedFloorISO: floorISO,
          snapshotPendingFromISO: cp.snapshotPendingFromISO && cp.snapshotPendingFromISO < from ? cp.snapshotPendingFromISO : from }))) {
          o.checkpoint = o.checkpoint ? { ...o.checkpoint, valuationCheckedFloorISO: floorISO,
            snapshotPendingFromISO: o.checkpoint.snapshotPendingFromISO && o.checkpoint.snapshotPendingFromISO < from ? o.checkpoint.snapshotPendingFromISO : from } : o.checkpoint;
          return true;
        }
      }
      return false;
    } finally {
      if (locked) await deps.releaseLock(o.connectionId, stamp);
    }
  };

  // PRICE GAPS FOR EVERY HOLDER (2026-10-28): the per-wallet acquisition below
  // runs only inside a regeneration, i.e. after a wallet's backfill moved — a
  // wallet whose history is already COMPLETE never got its gap planned. So,
  // each run, while it has PRICE_GAP_RESERVE_MS: plan + acquire across ALL
  // licensed crypto holders (every chain). Shared per instrument, bounded by
  // DEFAULT_PRICE_GAP_MAX_INSTRUMENTS, at most once per instrument per floor
  // per day (the durable attempt marker), covered ranges never requested. It
  // runs AFTER the leader's phase, so it can never eat the leader's reserve.
  // The holders the new floor reaches are then owed by PERSISTED state:
  // Solana's are flagged by the self-heal (and rebuilt under their lock in
  // this run's Solana pass when it is still to come, else the next); every
  // other holder is revalued at the end (holderRevaluation).
  let holderIds: string[] = [];
  const priceGapSweep = async (): Promise<boolean> => {
    if (!deps.acquirePriceGaps || !deps.cryptoHolders) return false;
    if (jobDeadline - deps.now() < PRICE_GAP_RESERVE_MS) { summary.priceGapSweep = { holders: 0, skippedForTime: true }; return false; }
    const holders = await deps.cryptoHolders().catch(() => [] as string[]);
    // L2 — a price fetch only for holders whose billed owner may cause one (one batch read).
    await accountGate.prime(holders);
    holderIds = [];
    for (const id of holders) if (await allows(id)) holderIds.push(id);
    const g = holderIds.length > 0 ? await deps.acquirePriceGaps(holderIds, { attempted: priceGapAttempted, maxInstruments: DEFAULT_PRICE_GAP_MAX_INSTRUMENTS }) : null;
    if (g) addPriceGaps(summary, g);
    summary.priceGapSweep = { holders: holderIds.length, skippedForTime: false };
    return !!g?.newlyPricedFromISO;
  };

  // SELF-HEAL: a wallet whose PERSISTED state owes a revaluation — valued-from
  // (max of licence start and price floor) earlier than its Spaces' earliest
  // snapshot — is flagged now, at most once per price floor. This is what
  // makes a flag lost to a race (above) temporary rather than permanent.
  const selfHeal = async () => {
    if (!deps.revaluationOwed) return;
    const licensed = parsed.filter((w) => w.checkpoint?.licensedFromISO && !w.checkpoint.snapshotPendingFromISO);
    const owed = licensed.length ? await deps.revaluationOwed(licensed.map((w) => w.accountId)).catch(() => [] as RevaluationOwed[]) : [];
    for (const o of owed) {
      if (summary.revaluationsRederived >= REVALUATION_REDERIVE_MAX) break;
      const w = parsed.find((x) => x.accountId === o.accountId);
      if (!w?.checkpoint || w.checkpoint.valuationCheckedFloorISO === o.floorISO) continue;
      if (await flagHolder(w, o.fromISO, o.floorISO)) summary.revaluationsRederived++;
      else summary.holdersFlagFailed++;
    }
  };
  await selfHeal();

  // Regenerations owed by earlier runs come first — snapshots must catch up with rows.
  // Read when the Solana pass starts: a price-gap fill earlier in the run may have flagged more.
  const candidates = orderCandidates(parsed, start);
  summary.eligible = candidates.length;
  const solWork = (): Array<{ w: (typeof parsed)[number]; kind: "PENDING" | "BACKFILL" }> => {
    const pending = parsed.filter((w) => w.checkpoint?.snapshotPendingFromISO);
    return [
      ...pending.map((w) => ({ w, kind: "PENDING" as const })),
      ...candidates.filter((c) => !pending.some((p) => p.accountId === c.accountId)).map((w) => ({ w, kind: "BACKFILL" as const })),
    ];
  };
  const solHasWork = solWork().length > 0;
  let revalued = false;
  /**
   * Revalue EVERY holder (all chains, Solana included — parity with the
   * sync-crypto sweep) whose evidence state is not yet revalued, existing rows
   * included (state-derived, once per evidence state, kill-safe batches,
   * wake-bounded). A Solana wallet newly linked to a Space with rows is thus
   * repaired by the worker too, not only when sync-crypto runs. Its own pass may
   * also rebuild it (a pending flag); the second rebuild recomputes UNCHANGED
   * days and writes nothing.
   */
  const revalueOtherHolders = async () => {
    if (revalued) return; // once per run (it may run early, when reserved)
    if (!deps.revalueHolders || holderIds.length === 0) return;
    const ids = holderIds;
    revalued = true;
    const r = await deps.revalueHolders(ids, { deadlineMs: jobDeadline, attempted: priceGapAttempted,
      maxInstruments: Math.max(0, DEFAULT_PRICE_GAP_MAX_INSTRUMENTS - summary.priceGaps.acquired) }).catch(() => null);
    if (!r) return;
    if (r.priceGaps) addPriceGaps(summary, r.priceGaps);
    summary.holderRevaluation = { holders: ids.length, owed: r.owed, revalued: r.revalued, chunksRebuilt: r.chunksRebuilt, deferred: r.deferred,
      alreadyRevalued: r.alreadyRevalued, abandonedBlocks: r.abandonedBlocks, rowsStampedUnavailable: r.rowsStampedUnavailable, rowsStampedPending: r.rowsStampedPending,
      failures: r.failures, skippedForTime: r.skippedForTime };
    summary.deferred += r.deferred; // still owed on disk: the next (self-continued) run takes them
  };

  let swept = false;
  if (!solHasWork && !btcHasWork && !ethHasWork) {
    // No leader to protect: the sweep runs now, and a Solana holder it flags is rebuilt in this run.
    swept = true;
    if (await priceGapSweep()) await selfHeal();
  }
  if (!solHasWork && !btcHasWork && !ethHasWork && solWork().length === 0) {
    await revalueOtherHolders();
    summary.stoppedBecause = "NO_WORK";
    if (btcPlan) summary.btc = { ...btcPlan.summary, stoppedBecause: "NO_WORK" };
    if (ethPlan) summary.eth = { ...ethPlan.summary, dailyRequestCap: cfg.dailyRequestCap, stoppedBecause: "NO_WORK" };
    if (tokenPlan) summary.ethTokens = { ...tokenPlan.summary, dailyRequestCap: cfg.dailyRequestCap };
    Object.assign(summary, solBackfillJobOutcome(summary));
    return summary;
  }

  // FAIRNESS (P1 2026-10-31) — when a holder revaluation is owed, reserve its
  // slice: the leader stops short of it and it runs right after the sweep,
  // BEFORE the other chains. Asked by state (reads only), so a run with nothing
  // owed keeps the whole budget for history work, as before.
  let reserveRevaluation = false;
  if (deps.revalueHolders && deps.revaluationPending && deps.cryptoHolders) {
    const holders = await deps.cryptoHolders().catch(() => [] as string[]);
    // L2 — the revaluation's first step is a paid price-gap fetch: only holders
    // whose billed owner may cause one (the same batch gate as the sweep).
    await accountGate.prime(holders);
    const early: string[] = [];
    for (const id of holders) if (await allows(id)) early.push(id);
    reserveRevaluation = early.length > 0 && await deps.revaluationPending(early).catch(() => false);
    if (reserveRevaluation) { summary.revaluationReserved = true; if (holderIds.length === 0) holderIds = early; }
  }

  const take = createRateLimiter(cfg.maxRequestsPerSecond, deps.now, deps.sleep);
  summary.stoppedBecause = "NO_WORK"; // Solana's verdict, set by its pass when it runs

  /** Returns the outcome and the lock stamp now in force (renewed, or unchanged). */
  const regenerateUnderLock = async (w: { accountId: string; connectionId: string }, fromISO: string, lockStamp: number, withPriceGaps = true): Promise<{ outcome: "DONE" | "DEFERRED"; stamp: number }> => {
    if (!deps.regenerationEnabled()) return { outcome: "DONE", stamp: lockStamp }; // nothing to keep in step (sync-crypto applies the same rule)
    if (phaseDeadline - deps.now() < REGEN_RESERVE_MS + (withPriceGaps && deps.acquirePriceGaps ? PRICE_GAP_RESERVE_MS : 0)) return { outcome: "DEFERRED", stamp: lockStamp };
    // Prices before valuation: widen the shared archive below its floor where
    // this wallet's proven history needs it. The regeneration's planner then
    // measures the new closes (createdAt ≥ this run's start) and reads the
    // lowered floor, so its window reaches them with no override.
    // (Solana wallets only: the pass marks the other SOL holders it reaches.)
    if (withPriceGaps && deps.acquirePriceGaps) await priceGapsFor(w);
    const renewed = Math.max(deps.now(), lockStamp + 1);
    if (!(await deps.renewLock(w.connectionId, lockStamp, renewed))) return { outcome: "DEFERRED", stamp: lockStamp };
    try { await deps.regenerate(w.accountId, fromISO, start); return { outcome: "DONE", stamp: renewed }; }
    catch (e) {
      console.warn(`[${SOL_BACKFILL_JOB}] wealth-history regen failed (non-fatal):`, e instanceof Error ? e.message : String(e));
      return { outcome: "DEFERRED", stamp: renewed };
    }
  };

  /** Per-instrument price-gap pass for one wallet; marks the other holders the new prices reach. */
  const priceGapsFor = async (w: { accountId: string }) => {
    const left = DEFAULT_PRICE_GAP_MAX_INSTRUMENTS - summary.priceGaps.acquired;
    const g = await deps.acquirePriceGaps!([w.accountId], { attempted: priceGapAttempted, maxInstruments: Math.max(0, left) });
    summary.priceGaps.acquired += g.acquired;
    summary.priceGaps.inserted += g.inserted;
    summary.priceGaps.failures += g.failures;
    summary.priceGaps.deferred += g.decisions.filter((d) => d.kind === "DEFERRED_RUN_CAP").length;
    if (!g.newlyPricedFromISO) return;
    // Every wallet here holds the SOL native instrument. One whose licensed
    // history starts before the OLD floor gains valued days from the new prices.
    const oldFloor = g.instruments.reduce<string | null>((m, i) => (i.earliestBeforeISO === null ? m : m === null || i.earliestBeforeISO > m ? i.earliestBeforeISO : m), null);
    for (const o of parsed) {
      if (o.accountId === w.accountId) continue;
      const lic = o.checkpoint?.licensedFromISO ?? null;
      if (!lic || (oldFloor !== null && lic >= oldFloor)) continue;
      const from = lic > g.newlyPricedFromISO ? lic : g.newlyPricedFromISO;
      if (await flagHolder(o, from, g.newlyPricedFromISO)) {
        summary.holdersMarkedPending++;
        summary.deferred++; // revalued by the next (self-continued) run
      } else {
        summary.holdersFlagFailed++; // re-derived from state next run (self-heal above)
        summary.deferred++;
      }
    }
  };

  // ── SOLANA ─────────────────────────────────────────────────────────────────
  const runSolPass = async () => {
    const work = solWork();
    if (work.length > 0) summary.stoppedBecause = "ALL_RUN";
    for (let i = 0; i < work.length; i++) {
      const { w, kind } = work[i];
      const left = phaseDeadline - deps.now();
      if (left < Math.max(cfg.startReserveMs, 2_000)) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred += work.length - i; break; }
      const allowance = cfg.dailyRequestCap - summary.dailyRequestsUsedBefore - total() - meterTotal(ethUsage.meter);
      if (kind === "BACKFILL" && allowance <= 0) { summary.stoppedBecause = "DAILY_CAP"; break; } // resumes after UTC midnight, on cadence
      if (!(await allows(w.accountId))) continue; // L2 — re-asked before the lock (a mid-run freeze)
      let stamp = deps.now();
      if (!(await deps.claimLock(w.connectionId, stamp))) { summary.walletsSkippedLocked++; summary.deferred++; continue; }
      try {
        let fromISO = w.checkpoint?.snapshotPendingFromISO ?? null;
        if (kind === "BACKFILL") {
          const r = await deps.reconstruct({ accountId: w.accountId,
            deps: { budgetMs: Math.max(1_000, Math.min(cfg.walletBudgetMs, left - REGEN_RESERVE_MS / 2)), concurrency: cfg.concurrency,
              beforeRequest: take, meter, requestBudget: allowance, now: deps.now } });
          summary.walletsRun++;
          await flushUsage();
          // Re-review F4 — an SPL price run the token budget stopped is reported, never silent.
          const sp = r.tokens?.prices;
          if (sp && sp.status !== "COMPLETE") {
            const prev = summary.splPrices;
            // Worst wins across wallets (STEP_FAILED > BUDGET_STOPPED > ALLOWANCE_EXHAUSTED), as ERC-20's pass.
            const worse = !prev || SPL_PRICE_RUN_SEVERITY[sp.status] > SPL_PRICE_RUN_SEVERITY[prev.status];
            summary.splPrices = { status: worse ? sp.status : prev.status, reason: worse ? sp.reason : prev.reason,
              mintsSkipped: (prev?.mintsSkipped ?? 0) + sp.mintsSkipped, wallets: (prev?.wallets ?? 0) + 1 };
          }
          const o = r.backfill;
          if (o) {
            summary.signaturesProcessed += o.signaturesProcessed;
            summary.rowsWritten += o.rowsWritten;
            if (o.promoted) summary.promoted++;
            if (o.status.state === "COMPLETE") summary.completed++;
            else if (o.status.state === "IMPORTING" || o.status.state === "QUEUED") summary.deferred++;
            if (o.failure) summary.failures[o.failure.code] = (summary.failures[o.failure.code] ?? 0) + 1;
          }
          if (r.derivedRowsWritten > 0 && r.impactedFromISO) fromISO = fromISO && fromISO < r.impactedFromISO ? fromISO : r.impactedFromISO;
        }
        if (fromISO) {
          const regen = await regenerateUnderLock(w, fromISO, stamp);
          const outcome = regen.outcome;
          stamp = regen.stamp; // release below checks ownership against the stamp in force
          const store = await deps.store(w.accountId);
          if (outcome === "DONE") {
            summary.regenerated++;
            if (store && w.checkpoint?.snapshotPendingFromISO) await setPending(store, w.accountId, w.address, (cp) => ({ ...cp, snapshotPendingFromISO: null }));
          } else {
            summary.regenerationsDeferred++;
            summary.deferred++;
            if (store) await setPending(store, w.accountId, w.address, (cp) => ({ ...cp,
              snapshotPendingFromISO: cp.snapshotPendingFromISO && cp.snapshotPendingFromISO < fromISO! ? cp.snapshotPendingFromISO : fromISO }));
          }
        }
      } finally {
        await deps.releaseLock(w.connectionId, stamp);
      }
    }

    await flushUsage();
    summary.requests = { ...meter, total: total() };
    summary.estimatedUnits = (meter.getTransaction ?? 0) * ALCHEMY_PAYG.unitsPerGetTransaction
      + (meter.getSignaturesForAddress ?? 0) * ALCHEMY_PAYG.unitsPerGetSignatures;
  };

  // ── THE PASSES, in this run's rotation (lib/crypto/history-worker-schedule.core.ts) ──
  // Each chain with work leads once in any 3 consecutive runs in which the
  // leader could start, and a phase is never shorter than what its chain needs
  // to start its first item (a step, or a pending regeneration), so no chain's
  // backlog can starve another's.
  const rotation = deps.previousRuns
    ? nextRotation(await deps.previousRuns().catch(() => [] as Array<{ summary: unknown }>), Math.floor(start / ROTATION_SLOT_MS))
    : 0;
  const solFirstPending = solWork()[0]?.kind === "PENDING";
  const withWork = new Set<HistoryChain>([...(solWork().length > 0 ? ["SOL" as const] : []), ...(btcHasWork ? ["BTC" as const] : []), ...(ethHasWork ? ["ETH" as const] : [])]);
  const order = chainOrder(rotation, withWork);
  const regenNeed = REGEN_RESERVE_MS + PHASE_SETUP_MS;
  // N3 — ERC-20 token work rides the ETH phase AFTER the native pass: it gets its
  // own slice (its start reserve, or a regeneration's when its first item is a
  // PENDING one) on top of native's need, and native stops short of it — so a
  // native backlog can no longer starve the token pass.
  const tokenNeedMs = tokenPlan && tokenPlan.work.length > 0
    ? Math.max(Math.max(erc20Cfg.startReserveMs, 2_000) + PHASE_SETUP_MS, tokenPlan.work[0]?.kind === "PENDING" && deps.regenerationEnabled() ? regenNeed : 0)
    : 0;
  const needMs: Record<HistoryChain, number> = {
    SOL: Math.max(Math.max(cfg.startReserveMs, 2_000) + PHASE_SETUP_MS,
      solFirstPending && deps.regenerationEnabled() ? regenNeed + (deps.acquirePriceGaps ? PRICE_GAP_RESERVE_MS : 0) : 0),
    BTC: Math.max(Math.max(btcCfg.startReserveMs, 2_000) + PHASE_SETUP_MS,
      btcPlan?.work[0]?.kind === "PENDING" && deps.regenerationEnabled() ? regenNeed : 0),
    ETH: (tokenNeedMs > 0 && !(ethPlan && ethPlan.work.length > 0) ? 0 : Math.max(Math.max(ethCfg.startReserveMs, 2_000) + PHASE_SETUP_MS,
      ethPlan?.work[0]?.kind === "PENDING" && deps.regenerationEnabled() ? regenNeed : 0)) + tokenNeedMs,
  };
  summary.schedule = { rotation, order: [...order], leaderShort: false };
  const runPhase = async (chain: HistoryChain, chainsLeft: number, endBy = jobDeadline) => {
    phaseDeadline = phaseDeadlineFor({ nowMs: deps.now(), jobDeadlineMs: endBy, chainsLeft, needMs: needMs[chain] });
    if (chain === "SOL") await runSolPass();
    else if (chain === "BTC" && btcPlan && deps.btc) {
      summary.btc = await runBtcPass(deps, deps.btc, btcCfg, btcPlan, { start, jobDeadline: phaseDeadline, regenerateUnderLock, allows });
      summary.deferred += summary.btc.deferred;
    } else if (chain === "ETH") {
      if (ethPlan && deps.eth) {
        // Native stops short of the token slice (never before now).
        const nativeEnd = tokenNeedMs > 0 ? Math.max(deps.now(), phaseDeadline - tokenNeedMs) : phaseDeadline;
        summary.eth = await runEthPass(deps, deps.eth, ethCfg, ethPlan, {
          jobDeadline: nativeEnd, day, dailyRequestCap: cfg.dailyRequestCap, solCheckpointCalls: checkpointCalls, solRunCalls: total(),
          usage: ethUsage, regenerateUnderLock, allows,
        });
        summary.deferred += summary.eth.deferred;
      }
      await runTokenPass(phaseDeadline);
    }
  };
  /** ERC-20 token history (one isolated call; the pass owns its listing, budget and regeneration). */
  const runTokenPass = async (endBy: number) => {
    if (!tokenPlan || !deps.ethTokens || summary.ethTokens) return;
    // L2 — the token pass claims its wallet's lock before each step: a wallet
    // refused since planning is answered "not claimable" (no lock, no step).
    const tokenAccountOf = new Map(tokenPlan.work.map((x) => [x.w.connectionId, x.w.accountId] as const));
    const claimLock = async (connectionId: string, stampMs: number) => {
      const accountId = tokenAccountOf.get(connectionId);
      if (accountId !== undefined && !(await allows(accountId))) return false;
      return deps.claimLock(connectionId, stampMs);
    };
    summary.ethTokens = await runErc20HistoryPass(tokenPlan, deps.ethTokens, erc20Cfg, {
      jobDeadline: endBy, day, dailyRequestCap: cfg.dailyRequestCap, now: deps.now, claimLock, releaseLock: deps.releaseLock,
      providerUsageToday: deps.providerUsageToday, regenerateUnderLock,
    });
    summary.deferred += summary.ethTokens.deferred;
  };
  const queue = [...order];
  if (queue.length > 0) {
    // A leader whose phase cannot hold its first item (a short wake) keeps the
    // lead: the next run starts from the same rotation (nextRotation).
    const leader = queue.shift()!;
    if (jobDeadline - deps.now() < needMs[leader]) summary.schedule.leaderShort = true;
    // The sweep after it keeps its PRICE_GAP_RESERVE_MS — or a single-chain
    // backlog (whose leader phase is the whole budget) would skip it every run.
    // Never at the cost of the leader's own need.
    const sweepPending = !swept && !!deps.acquirePriceGaps && !!deps.cryptoHolders;
    // The leader's own need first; then, as it fits, the revaluation's and the sweep's reserves.
    const fits = (reserve: number) => reserve > 0 && jobDeadline - reserve - deps.now() >= needMs[leader];
    const both = (sweepPending ? PRICE_GAP_RESERVE_MS : 0) + (reserveRevaluation ? REVALUATION_RESERVE_MS : 0);
    const endBy = fits(both) ? jobDeadline - both
      : sweepPending && fits(PRICE_GAP_RESERVE_MS) ? jobDeadline - PRICE_GAP_RESERVE_MS
      : jobDeadline;
    await runPhase(leader, queue.length + 1, endBy);
  }
  if (!swept) {
    // After the leader, never before it: the sweep cannot eat the leader's reserve.
    if (await priceGapSweep()) {
      await selfHeal();
      // A Solana holder flagged now is rebuilt in this run when Solana is still to come — or joins the run.
      if (!order.includes("SOL") && solWork().length > 0) { queue.push("SOL"); summary.schedule.order.push("SOL"); }
    }
  }
  if (reserveRevaluation) await revalueOtherHolders(); // its reserved slice, before the other chains
  while (queue.length > 0) {
    const chain = queue.shift()!;
    await runPhase(chain, queue.length + 1);
  }
  // A chain listed but without work still reports its (NO_WORK) pass, as before.
  if (btcPlan && deps.btc && !summary.btc) {
    summary.btc = await runBtcPass(deps, deps.btc, btcCfg, btcPlan, { start, jobDeadline, regenerateUnderLock, allows });
    summary.deferred += summary.btc.deferred;
  }
  if (ethPlan && deps.eth && !summary.eth) {
    summary.eth = await runEthPass(deps, deps.eth, ethCfg, ethPlan, {
      jobDeadline, day, dailyRequestCap: cfg.dailyRequestCap, solCheckpointCalls: checkpointCalls, solRunCalls: total(),
      usage: ethUsage, regenerateUnderLock, allows,
    });
    summary.deferred += summary.eth.deferred;
  }
  await runTokenPass(jobDeadline);
  summary.requests = { ...meter, total: total() }; // (Solana's pass set the same when it ran)

  await revalueOtherHolders();
  Object.assign(summary, solBackfillJobOutcome(summary));
  if (summary.outcome === "PARTIAL") console.warn(`[${SOL_BACKFILL_JOB}] PARTIAL — ${summary.partialReasons!.join(" | ")}`);
  return summary;
}

type EthParsed = EthWorkerWallet & { checkpoint: EthBackfillCheckpoint | null };

async function planEth(eth: EthBackfillJobDeps, start: number) {
  let listed: EthWorkerWallet[] = [];
  try { listed = await eth.wallets(); }
  catch (e) {
    // Ethereum's listing must never take the other chains' passes down with it.
    console.warn(`[${SOL_BACKFILL_JOB}] ETH wallet listing failed (non-fatal — Ethereum skipped this run):`, e instanceof Error ? e.message : String(e));
  }
  const parsed: EthParsed[] = listed.map((w) => ({ ...w, checkpoint: parseEthCheckpoint(w.cursor, w.accountId) }));
  const pending = parsed.filter((w) => w.checkpoint?.snapshotPendingFromISO);
  const candidates = orderEthCandidates(parsed, start);
  const work: Array<{ w: EthParsed; kind: "PENDING" | "BACKFILL" }> = [
    ...pending.map((w) => ({ w, kind: "PENDING" as const })),
    ...candidates.filter((c) => !pending.some((p) => p.accountId === c.accountId)).map((w) => ({ w, kind: "BACKFILL" as const })),
  ];
  const summary: EthBackfillPassSummary = {
    enabled: true, eligible: candidates.length, walletsRun: 0, walletsSkippedLocked: 0, completed: 0, failures: {},
    rowsWritten: 0, regenerated: 0, regenerationsDeferred: 0, requests: { total: 0 }, dailyRequestsUsedBefore: 0,
    dailyRequestCap: 0, stoppedBecause: "ALL_RUN", deferred: 0,
  };
  return { work, parsed, summary };
}

/**
 * Ethereum's pass: Bitcoin's loop with Ethereum's step. Its cap is the SHARED
 * Alchemy cap: what the ledger says every network spent today (re-read now, so
 * the Solana pass just flushed is in it), never less than the checkpoints say
 * — Solana's, this run's unflushed Solana calls, and Ethereum's own.
 */
async function runEthPass(
  deps: SolBackfillJobDeps, eth: EthBackfillJobDeps, cfg: EthBackfillWorkerConfig,
  plan: Awaited<ReturnType<typeof planEth>>,
  ctx: {
    jobDeadline: number; day: string; dailyRequestCap: number; solCheckpointCalls: number; solRunCalls: number;
    /** The run's Ethereum meter (crash-safe; the Solana pass reads it for the shared cap). */
    usage: IncrementalMeter;
    regenerateUnderLock: (w: { accountId: string; connectionId: string }, fromISO: string, lockStamp: number, withPriceGaps?: boolean) => Promise<{ outcome: "DONE" | "DEFERRED"; stamp: number }>;
    /** BETA LIFECYCLE L2 — the per-wallet billable re-check before each lock. */
    allows: (accountId: string) => Promise<boolean>;
  },
): Promise<EthBackfillPassSummary> {
  const summary: EthBackfillPassSummary = { ...plan.summary, dailyRequestCap: ctx.dailyRequestCap };
  const meter = ctx.usage.meter;
  const flushUsage = () => ctx.usage.flush();
  const ethCheckpointCalls = plan.parsed.reduce((a, w) => a + ethUsageOn(w.checkpoint, ctx.day), 0);
  const ledger = deps.providerUsageToday ? await deps.providerUsageToday(ctx.day).catch(() => null) : null;
  summary.dailyRequestsUsedBefore = ledger
    ? effectiveDailyUsage({ ledger, checkpointCalls: ctx.solCheckpointCalls + ctx.solRunCalls }) + Math.max(0, ethCheckpointCalls - ledger.other)
    : ctx.solCheckpointCalls + ctx.solRunCalls + ethCheckpointCalls;
  if (plan.work.length === 0) summary.stoppedBecause = "NO_WORK";

  for (let i = 0; i < plan.work.length; i++) {
    const { w, kind } = plan.work[i];
    const left = ctx.jobDeadline - deps.now();
    if (left < Math.max(cfg.startReserveMs, 2_000)) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred += plan.work.length - i; break; }
    const allowed = probeBudgetFor(ctx.dailyRequestCap - summary.dailyRequestsUsedBefore - meterTotal(meter), cfg.probeBudget);
    if (kind === "BACKFILL" && allowed <= 0) { summary.stoppedBecause = "DAILY_CAP"; break; } // resumes after UTC midnight, on cadence
    // The step stops on the clock (the acquisition checks the deadline before
    // every batch), and a clock stop that closes no chunk HALVES the chunk —
    // walking a dense wallet toward FAILED at the floor. So the step is given
    // the whole phase (no regeneration reserve: a backfill step writes rows
    // only when its proof closes, and a regeneration that then lacks time is
    // deferred to a pending marker, which leads the chain's next phase), and
    // plans only the probes that time proves at the assumed rate.
    const stepDeadline = deps.now() + Math.max(1_000, left - PHASE_SETUP_MS);
    const probeBudget = Math.max(1, stepProbeBudget(allowed, stepDeadline - deps.now(), cfg.probesPerSecond));
    if (!(await ctx.allows(w.accountId))) continue; // L2 — re-asked before the lock
    let stamp = deps.now();
    if (!(await deps.claimLock(w.connectionId, stamp))) { summary.walletsSkippedLocked++; summary.deferred++; continue; }
    try {
      let fromISO = w.checkpoint?.snapshotPendingFromISO ?? null;
      if (kind === "BACKFILL") {
        const o = await eth.reconstruct({ accountId: w.accountId, todayISO: ctx.day, deps: { probeBudget, now: deps.now, eth: { meter },
          deadlineMs: stepDeadline } });
        summary.walletsRun++;
        await flushUsage();
        summary.rowsWritten += o.rowsWritten;
        if (o.stoppedBecause === "COMPLETE") summary.completed++;
        else if (o.stoppedBecause === "PROBE_BUDGET" || o.stoppedBecause === "CONFLICT") summary.deferred++;
        if (o.failure) summary.failures[o.failure.code] = (summary.failures[o.failure.code] ?? 0) + 1;
        if (o.impactedFromISO) fromISO = fromISO && fromISO < o.impactedFromISO ? fromISO : o.impactedFromISO;
      }
      if (fromISO) {
        const regen = await ctx.regenerateUnderLock(w, fromISO, stamp, false); // no SOL price-gap pass for an ETH wallet
        stamp = regen.stamp; // release below checks ownership against the stamp in force
        const store = await eth.store(w.accountId);
        if (regen.outcome === "DONE") {
          summary.regenerated++;
          if (store && w.checkpoint?.snapshotPendingFromISO) await setEthPending(store, w.accountId, (cp) => ({ ...cp, snapshotPendingFromISO: null }));
        } else {
          summary.regenerationsDeferred++;
          summary.deferred++;
          if (store) await setEthPending(store, w.accountId, (cp) => ({ ...cp,
            snapshotPendingFromISO: cp.snapshotPendingFromISO && cp.snapshotPendingFromISO < fromISO! ? cp.snapshotPendingFromISO : fromISO }));
        }
      }
    } finally {
      await deps.releaseLock(w.connectionId, stamp);
    }
  }
  await flushUsage();
  summary.requests = { total: meterTotal(meter) };
  return summary;
}

type BtcParsed = BtcWorkerWallet & { checkpoint: BtcBackfillCheckpoint | null };

async function planBtc(btc: BtcBackfillJobDeps, start: number, day: string) {
  let listed: BtcWorkerWallet[] = [];
  try { listed = await btc.wallets(); }
  catch (e) {
    // Bitcoin's listing must never take Solana's pass down with it (a transient
    // read failure): no BTC work this run. (The column's migration must precede
    // this code everywhere — see lib/crypto/btc-history-checkpoint.ts.)
    console.warn(`[${SOL_BACKFILL_JOB}] BTC wallet listing failed (non-fatal — Bitcoin skipped this run):`, e instanceof Error ? e.message : String(e));
  }
  const parsed: BtcParsed[] = listed.map((w) => ({ ...w, checkpoint: parseBtcCheckpoint(w.cursor, w.accountId) }));
  const pending = parsed.filter((w) => w.checkpoint?.snapshotPendingFromISO);
  const candidates = orderBtcCandidates(parsed, start);
  const work: Array<{ w: BtcParsed; kind: "PENDING" | "BACKFILL" }> = [
    ...pending.map((w) => ({ w, kind: "PENDING" as const })),
    ...candidates.filter((c) => !pending.some((p) => p.accountId === c.accountId)).map((w) => ({ w, kind: "BACKFILL" as const })),
  ];
  // Bitcoin's OWN daily cap, read like Solana's: every BTC backfill request is
  // in both its checkpoint and the ESPLORA ledger, so the larger of the two
  // (a killed run may have reached only one of them).
  const checkpointCalls = parsed.reduce((a, w) => a + btcUsageOn(w.checkpoint, day), 0);
  const ledger = btc.providerUsageToday ? await btc.providerUsageToday(day).catch(() => null) : null;
  const ledgerCalls = ledger ? ledger.solana + ledger.other : 0;
  const summary: BtcBackfillPassSummary = {
    enabled: true, eligible: candidates.length, walletsRun: 0, walletsSkippedLocked: 0, completed: 0, promoted: 0,
    failures: {}, txsProcessed: 0, rowsWritten: 0, regenerated: 0, regenerationsDeferred: 0, requests: { total: 0 },
    dailyRequestsUsedBefore: Math.max(checkpointCalls, ledgerCalls),
    dailyRequestCap: 0, stoppedBecause: "ALL_RUN", deferred: 0,
  };
  return { work, summary };
}

/**
 * Bitcoin's pass: Solana's loop with Bitcoin's run, bucket and cap. Each wallet
 * under its sync lock (claimed, renewed for regeneration, released only while
 * still ours — the shared lock deps).
 */
async function runBtcPass(
  deps: SolBackfillJobDeps, btc: BtcBackfillJobDeps, cfg: BtcBackfillWorkerConfig,
  plan: Awaited<ReturnType<typeof planBtc>>,
  ctx: { start: number; jobDeadline: number; regenerateUnderLock: (w: { accountId: string; connectionId: string }, fromISO: string, lockStamp: number, withPriceGaps?: boolean) => Promise<{ outcome: "DONE" | "DEFERRED"; stamp: number }>;
    /** BETA LIFECYCLE L2 — the per-wallet billable re-check before each lock. */
    allows: (accountId: string) => Promise<boolean> },
): Promise<BtcBackfillPassSummary> {
  const summary: BtcBackfillPassSummary = { ...plan.summary, dailyRequestCap: cfg.dailyRequestCap };
  const usage = runMeter(btc.recordUsage, deps.now); // crash-safe: flushed while the pass sends
  const meter = usage.meter;
  const total = () => meterTotal(meter);
  const take = createRateLimiter(cfg.maxRequestsPerSecond, deps.now, deps.sleep);
  const flushUsage = () => usage.flush();
  if (plan.work.length === 0) summary.stoppedBecause = "NO_WORK";

  for (let i = 0; i < plan.work.length; i++) {
    const { w, kind } = plan.work[i];
    const left = ctx.jobDeadline - deps.now();
    if (left < Math.max(cfg.startReserveMs, 2_000)) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred += plan.work.length - i; break; }
    const allowance = cfg.dailyRequestCap - summary.dailyRequestsUsedBefore - total();
    if (kind === "BACKFILL" && allowance <= 0) { summary.stoppedBecause = "DAILY_CAP"; break; } // resumes after UTC midnight, on cadence
    if (!(await ctx.allows(w.accountId))) continue; // L2 — re-asked before the lock
    let stamp = deps.now();
    if (!(await deps.claimLock(w.connectionId, stamp))) { summary.walletsSkippedLocked++; summary.deferred++; continue; }
    try {
      let fromISO = w.checkpoint?.snapshotPendingFromISO ?? null;
      if (kind === "BACKFILL") {
        const r = await btc.reconstruct({ accountId: w.accountId,
          deps: { budgetMs: Math.max(1_000, Math.min(cfg.walletBudgetMs, left - REGEN_RESERVE_MS / 2)),
            beforeRequest: take, meter, requestBudget: allowance, now: deps.now, sleep: deps.sleep } });
        summary.walletsRun++;
        await flushUsage();
        const o = r.backfill;
        if (o) {
          summary.txsProcessed += o.txsProcessed;
          summary.rowsWritten += o.rowsWritten;
          if (o.promoted) summary.promoted++;
          if (o.status.state === "COMPLETE") summary.completed++;
          // More listing owed ⇒ continue soon. A wallet that is merely waiting
          // to verify (discovery unfinished, a racing block) retries on cadence.
          else if (o.stoppedBecause === "BUDGET" || o.status.state === "QUEUED") summary.deferred++;
          if (o.failure) summary.failures[o.failure.code] = (summary.failures[o.failure.code] ?? 0) + 1;
        }
        if (r.impactedFromISO) fromISO = fromISO && fromISO < r.impactedFromISO ? fromISO : r.impactedFromISO;
      }
      if (fromISO) {
        const regen = await ctx.regenerateUnderLock(w, fromISO, stamp, false); // no SOL price-gap pass for a BTC wallet
        stamp = regen.stamp; // release below checks ownership against the stamp in force
        const store = await btc.store(w.accountId);
        if (regen.outcome === "DONE") {
          summary.regenerated++;
          if (store && w.checkpoint?.snapshotPendingFromISO) await setBtcPending(store, w.accountId, (cp) => ({ ...cp, snapshotPendingFromISO: null }));
        } else {
          summary.regenerationsDeferred++;
          summary.deferred++;
          if (store) await setBtcPending(store, w.accountId, (cp) => ({ ...cp,
            snapshotPendingFromISO: cp.snapshotPendingFromISO && cp.snapshotPendingFromISO < fromISO! ? cp.snapshotPendingFromISO : fromISO }));
        }
      }
    } finally {
      await deps.releaseLock(w.connectionId, stamp);
    }
  }
  await flushUsage();
  summary.requests = { ...meter, total: total() };
  return summary;
}

/** Production wiring. fm_system: the sweep spans every customer's wallets (lazy, as the other jobs). */
async function productionDeps(): Promise<SolBackfillJobDeps> {
  const { systemDb } = await import("@/lib/db");
  const { reconstructSolHistoryResumable, prismaSolBackfillStore } = await import("@/lib/crypto/sol-history-backfill.store");
  const { resolveHistoricalWorkWindow } = await import("@/lib/snapshots/historical-work-window");
  const { regenerateWealthHistoryForAccounts, wealthRegenerationEnabled } = await import("@/lib/snapshots/regenerate-history");
  const { WALLET_LOCK_TTL_MS } = await import("@/lib/refresh/wallet-lock");
  const { providerCallsOn, recordProviderMeter, ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK } = await import("@/lib/usage/provider-budget");
  const { acquireHistoricalPriceGaps, prismaPriceGapDeps, revaluationOwed, revalueHoldersAfterPriceGaps, prismaRevaluationDeps, revaluationPending } = await import("@/lib/prices/price-gap");
  const { admitOperationalWork } = await import("@/lib/platform/admission/facts");
  const { readGlobalCostFreeze } = await import("@/lib/platform/cost-freeze");
  const { billableForAccounts } = await import("@/lib/platform/policies/billable-subjects");
  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    admit: () => admitOperationalWork({ work: "REFRESH_EXECUTION" }),
    costFreeze: () => readGlobalCostFreeze(),
    billableAccounts: (accountIds) => billableForAccounts(accountIds, "crypto_backfill"),
    async wakeStartedAt() {
      const r = await systemDb.jobRun.findFirst({ where: { startedAt: { gte: new Date(Date.now() - 300_000) } }, orderBy: { startedAt: "asc" }, select: { startedAt: true } });
      return r ? r.startedAt.getTime() : null;
    },
    async wallets() {
      const links = await systemDb.accountConnection.findMany({
        where: { deletedAt: null, connectionId: { not: null },
          connection: { provider: "WALLET", status: "ACTIVE" },
          financialAccount: { deletedAt: null, walletChain: "SOL", walletAddress: { not: null } } },
        // The SAME link prismaSolBackfillStore uses: canonical first, then oldest.
        orderBy: [{ isCanonical: "desc" }, { createdAt: "asc" }],
        select: { financialAccountId: true, connectionId: true, connection: { select: { cursor: true } }, financialAccount: { select: { walletAddress: true } } },
      });
      const seen = new Set<string>();
      const out: WorkerWallet[] = [];
      for (const l of links) {
        if (seen.has(l.financialAccountId)) continue;
        seen.add(l.financialAccountId);
        out.push({ accountId: l.financialAccountId, connectionId: l.connectionId!, address: l.financialAccount.walletAddress!, cursor: l.connection?.cursor ?? null });
      }
      return out;
    },
    async claimLock(connectionId, stampMs) {
      const stale = new Date(stampMs - WALLET_LOCK_TTL_MS);
      const r = await systemDb.connection.updateMany({ where: { id: connectionId, OR: [{ syncLockedAt: null }, { syncLockedAt: { lte: stale } }] }, data: { syncLockedAt: new Date(stampMs) } });
      return r.count === 1;
    },
    async renewLock(connectionId, fromMs, toMs) {
      const r = await systemDb.connection.updateMany({ where: { id: connectionId, syncLockedAt: new Date(fromMs) }, data: { syncLockedAt: new Date(toMs) } });
      return r.count === 1;
    },
    async releaseLock(connectionId, stampMs) {
      try { await systemDb.connection.updateMany({ where: { id: connectionId, syncLockedAt: new Date(stampMs) }, data: { syncLockedAt: null } }); }
      catch (e) { console.error(`[${SOL_BACKFILL_JOB}] lock release failed:`, e instanceof Error ? e.message : String(e)); }
    },
    reconstruct: ({ accountId, deps }) => reconstructSolHistoryResumable({ accountId, client: systemDb, deps }),
    store: async (accountId) => (await prismaSolBackfillStore(accountId, systemDb))?.store ?? null,
    regenerationEnabled: wealthRegenerationEnabled,
    async previousRuns() {
      return systemDb.jobRun.findMany({ where: { jobName: SOL_BACKFILL_JOB, status: { not: "running" } },
        orderBy: { startedAt: "desc" }, take: ROTATION_LOOKBACK_RUNS, select: { summary: true } });
    },
    async cryptoHolders() {
      const rows = await systemDb.positionCoverage.findMany({
        where: { instrument: { assetClass: "CRYPTO" }, financialAccount: { deletedAt: null } },
        distinct: ["financialAccountId"], select: { financialAccountId: true }, orderBy: { financialAccountId: "asc" },
      });
      return rows.map((r) => r.financialAccountId);
    },
    revalueHolders: (accountIds, { deadlineMs, attempted, maxInstruments }) => {
      const log = (l: string) => console.log(`[${SOL_BACKFILL_JOB}] ${l}`);
      return revalueHoldersAfterPriceGaps({ accountIds, deadlineMs, log, deps: { ...prismaRevaluationDeps(systemDb, { log }),
        // The run's shared dedup: an instrument this run already acquired is not requested again.
        acquireGaps: (ids) => acquireHistoricalPriceGaps({ accountIds: ids, attempted, maxInstruments, deps: prismaPriceGapDeps(systemDb, { log }), log }) } });
    },
    revaluationPending: (accountIds) => revaluationPending(prismaRevaluationDeps(systemDb), accountIds),
    providerUsageToday: (dayISO) => providerCallsOn(systemDb, ALCHEMY_USAGE_PROVIDER, dayISO),
    revaluationOwed: (accountIds) => revaluationOwed(systemDb, accountIds),
    recordUsage: async (meter, flushed) => { await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK.SOLANA, meter, { flushed }); },
    acquirePriceGaps: (accountIds, { attempted, maxInstruments }) => acquireHistoricalPriceGaps({
      accountIds, attempted, maxInstruments,
      deps: prismaPriceGapDeps(systemDb, { log: (l) => console.log(`[${SOL_BACKFILL_JOB}] ${l}`) }),
      log: (l) => console.log(`[${SOL_BACKFILL_JOB}] ${l}`),
    }),
    async regenerate(accountId, fromISO, startedAtMs) {
      const plan = await resolveHistoricalWorkWindow({ financialAccountIds: [accountId], changedSince: new Date(startedAtMs), positionHistoryImpactedFromISO: fromISO });
      await regenerateWealthHistoryForAccounts([accountId], { fromDate: plan.fromDate, toDate: plan.toDate });
    },
    btc: await productionBtcDeps(systemDb),
    eth: await productionEthDeps(systemDb),
    ethTokens: (await import("@/lib/crypto/erc20-history.store")).prismaErc20HistoryPassDeps(systemDb),
  };
}

/** Ethereum's production wiring: wallets whose ETH history checkpoint is on their history link. */
async function productionEthDeps(systemDb: import("@prisma/client").PrismaClient): Promise<EthBackfillJobDeps> {
  const { reconstructEthHistoryResumable, prismaEthBackfillStore } = await import("@/lib/crypto/eth-history-backfill.store");
  const { isEthBackfillCursor } = await import("@/lib/crypto/eth-history-backfill.core");
  const { recordProviderMeter, ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK } = await import("@/lib/usage/provider-budget");
  return {
    async wallets() {
      // The SAME link btcHistoryLink uses (canonical first, then oldest), one per account.
      const rows = await systemDb.$queryRaw<Array<{ accountId: string; connectionId: string; cursor: string | null }>>`
        SELECT DISTINCT ON (ac."financialAccountId")
               ac."financialAccountId" AS "accountId", ac."connectionId" AS "connectionId", c."historyCheckpoint" AS "cursor"
        FROM "AccountConnection" ac
        JOIN "Connection" c ON c."id" = ac."connectionId"
        JOIN "FinancialAccount" fa ON fa."id" = ac."financialAccountId"
        WHERE ac."deletedAt" IS NULL AND ac."connectionId" IS NOT NULL
          AND fa."deletedAt" IS NULL AND UPPER(TRIM(fa."walletChain")) = 'ETH' AND fa."walletAddress" IS NOT NULL
          AND c."provider" = 'WALLET' AND c."status" = 'ACTIVE'
        ORDER BY ac."financialAccountId", ac."isCanonical" DESC, ac."createdAt" ASC`;
      return rows.filter((r) => isEthBackfillCursor(r.cursor));
    },
    reconstruct: ({ accountId, todayISO, deps }) => reconstructEthHistoryResumable({ accountId, client: systemDb, todayISO, deps }),
    store: async (accountId) => (await prismaEthBackfillStore(accountId, systemDb))?.store ?? null,
    recordUsage: async (meter, flushed) => { await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK.ETHEREUM, meter, { flushed }); },
  };
}

/** Bitcoin's production wiring: wallets whose history checkpoint is on their history link. */
async function productionBtcDeps(systemDb: import("@prisma/client").PrismaClient): Promise<BtcBackfillJobDeps> {
  const { reconstructBtcHistoryResumable, prismaBtcBackfillStore } = await import("@/lib/crypto/btc-history-backfill.store");
  const { providerCallsOn, recordProviderMeter } = await import("@/lib/usage/provider-budget");
  return {
    async wallets() {
      // The SAME link btcHistoryLink uses (canonical first, then oldest), one
      // per account; only accounts whose history the resumable backfill owns.
      const rows = await systemDb.$queryRaw<Array<{ accountId: string; connectionId: string; cursor: string | null }>>`
        SELECT DISTINCT ON (ac."financialAccountId")
               ac."financialAccountId" AS "accountId", ac."connectionId" AS "connectionId", c."historyCheckpoint" AS "cursor"
        FROM "AccountConnection" ac
        JOIN "Connection" c ON c."id" = ac."connectionId"
        JOIN "FinancialAccount" fa ON fa."id" = ac."financialAccountId"
        WHERE ac."deletedAt" IS NULL AND ac."connectionId" IS NOT NULL
          AND fa."deletedAt" IS NULL AND fa."walletChain" = 'BTC' AND fa."walletAddress" IS NOT NULL
          AND c."provider" = 'WALLET' AND c."status" = 'ACTIVE'
        ORDER BY ac."financialAccountId", ac."isCanonical" DESC, ac."createdAt" ASC`;
      return rows.filter((r) => r.cursor !== null);
    },
    reconstruct: ({ accountId, deps }) => reconstructBtcHistoryResumable({ accountId, client: systemDb, deps }),
    store: async (accountId) => (await prismaBtcBackfillStore(accountId, systemDb))?.store ?? null,
    providerUsageToday: (dayISO) => providerCallsOn(systemDb, ESPLORA_USAGE_PROVIDER, dayISO),
    recordUsage: async (meter, flushed) => { await recordProviderMeter(ESPLORA_USAGE_PROVIDER, ESPLORA_USAGE_NETWORK, meter, { flushed }); },
  };
}
