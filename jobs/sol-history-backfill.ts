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
 *     this worker flushes after each wallet. The cap reads the LARGER of the
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
 * unless BTC_BACKFILL_ENABLED=false. When both chains have work, Solana is
 * planned to the first half of the job budget and Bitcoin gets the rest;
 * either chain alone gets all of it. The job name and registration are
 * unchanged.
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
import { effectiveDailyUsage } from "@/lib/usage/provider-budget.core";
import { DEFAULT_PRICE_GAP_MAX_INSTRUMENTS } from "@/lib/prices/price-gap.core";
import type { PriceGapRun, RevaluationOwed } from "@/lib/prices/price-gap";
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
  dailyRequestCap: number;
  budgetMs: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "ALL_RUN";
  /** > 0 ⇒ the dispatcher self-continues this job (Solana + Bitcoin). */
  deferred: number;
  /** Bitcoin's pass, when its deps are wired (always in production). */
  btc?: BtcBackfillPassSummary;
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
  /** Absent ⇒ the job carries Solana only. */
  btc?: BtcBackfillJobDeps;
}

async function setPending(store: SolBackfillStore, accountId: string, address: string, mutate: (cp: SolBackfillCheckpoint) => SolBackfillCheckpoint): Promise<boolean> {
  const raw = await store.readCursor();
  const cp = parseCheckpoint(raw, accountId, address);
  if (!cp) return false;
  const next = mutate(cp);
  try {
    await store.commit({ expectedCursor: raw, nextCursor: serializeCheckpoint(next), replaceAll: false, deleteFromISO: null, deleteToISO: null, rows: [], coverage: null });
    return true;
  } catch { return false; } // CAS lost: someone advanced it — the marker is re-derived next run
}

async function setBtcPending(store: BtcBackfillStore, accountId: string, mutate: (cp: BtcBackfillCheckpoint) => BtcBackfillCheckpoint): Promise<boolean> {
  const raw = await store.readCursor();
  const cp = parseBtcCheckpoint(raw, accountId);
  if (!cp) return false;
  try {
    await store.commit({ expectedCursor: raw, nextCursor: serializeBtcCheckpoint(mutate(cp)), replaceAll: false, deleteFromISO: null, deleteToISO: null, rows: [], coverage: null, rawTxs: [] });
    return true;
  } catch { return false; } // CAS lost: someone advanced it — the marker is re-derived next run
}

export async function solHistoryBackfill(opts: { config?: SolBackfillWorkerConfig; btcConfig?: BtcBackfillWorkerConfig; deps?: SolBackfillJobDeps } = {}): Promise<SolBackfillJobSummary> {
  const cfg = opts.config ?? workerConfig();
  const summary: SolBackfillJobSummary = {
    enabled: cfg.enabled, eligible: 0, walletsRun: 0, walletsSkippedLocked: 0, completed: 0, promoted: 0,
    failures: {}, signaturesProcessed: 0, rowsWritten: 0, regenerated: 0, regenerationsDeferred: 0,
    requests: { total: 0 }, estimatedUnits: 0, dailyRequestsUsedBefore: 0, providerRequestsUsedBefore: null,
    dailyRequestCap: cfg.dailyRequestCap, priceGaps: { acquired: 0, inserted: 0, failures: 0, deferred: 0 }, holdersMarkedPending: 0,
    holdersFlagFailed: 0, revaluationsRederived: 0,
    budgetMs: 0, stoppedBecause: "DISABLED", deferred: 0,
  };
  if (!cfg.enabled) return summary;
  const deps = opts.deps ?? await productionDeps();
  const meter: Record<string, number> = {};
  const flushed: Record<string, number> = {};
  const total = () => Object.values(meter).reduce((a, b) => a + b, 0);
  const flushUsage = async () => { if (deps.recordUsage) { try { await deps.recordUsage(meter, flushed); } catch { /* metering never fails a run */ } } };
  const priceGapAttempted = new Map<string, string>();

  const start = deps.now();
  const wake = await deps.wakeStartedAt();
  const jobDeadline = Math.min(start + cfg.jobBudgetMs, (wake ?? start) + WAKE_SAFE_MS);
  summary.budgetMs = Math.max(0, jobDeadline - start);
  const day = new Date(start).toISOString().slice(0, 10);

  // Bitcoin's work is planned first so the two chains can share the budget.
  const btcCfg = opts.btcConfig ?? btcWorkerConfig();
  const btcPlan = deps.btc && btcCfg.enabled ? await planBtc(deps.btc, start, day) : null;
  const btcHasWork = !!btcPlan && btcPlan.work.length > 0;
  /** The deadline the CURRENT chain's pass plans to (Solana: half when Bitcoin waits). */
  let phaseDeadline = btcHasWork ? start + Math.floor((jobDeadline - start) / 2) : jobDeadline;

  const wallets = await deps.wallets();
  const parsed = wallets.map((w) => ({ ...w, checkpoint: parseCheckpoint(w.cursor, w.accountId, w.address) }));
  const checkpointCalls = parsed.reduce((a, w) => a + usageOn(w.checkpoint, day), 0);
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

  // SELF-HEAL: a wallet whose PERSISTED state owes a revaluation — valued-from
  // (max of licence start and price floor) earlier than its Spaces' earliest
  // snapshot — is flagged now, at most once per price floor. This is what
  // makes a flag lost to a race (above) temporary rather than permanent.
  if (deps.revaluationOwed) {
    const licensed = parsed.filter((w) => w.checkpoint?.licensedFromISO && !w.checkpoint.snapshotPendingFromISO);
    const owed = licensed.length ? await deps.revaluationOwed(licensed.map((w) => w.accountId)).catch(() => [] as RevaluationOwed[]) : [];
    for (const o of owed) {
      if (summary.revaluationsRederived >= REVALUATION_REDERIVE_MAX) break;
      const w = parsed.find((x) => x.accountId === o.accountId);
      if (!w?.checkpoint || w.checkpoint.valuationCheckedFloorISO === o.floorISO) continue;
      if (await flagHolder(w, o.fromISO, o.floorISO)) summary.revaluationsRederived++;
      else summary.holdersFlagFailed++;
    }
  }

  // Regenerations owed by earlier runs come first — snapshots must catch up with rows.
  const pending = parsed.filter((w) => w.checkpoint?.snapshotPendingFromISO);
  const candidates = orderCandidates(parsed, start);
  summary.eligible = candidates.length;
  const solHasWork = !(candidates.length === 0 && pending.length === 0);
  if (!solHasWork && !btcHasWork) {
    summary.stoppedBecause = "NO_WORK";
    if (btcPlan) summary.btc = { ...btcPlan.summary, stoppedBecause: "NO_WORK" };
    return summary;
  }

  const take = createRateLimiter(cfg.maxRequestsPerSecond, deps.now, deps.sleep);
  summary.stoppedBecause = solHasWork ? "ALL_RUN" : "NO_WORK";

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

  const work: Array<{ w: (typeof parsed)[number]; kind: "PENDING" | "BACKFILL" }> = solHasWork ? [
    ...pending.map((w) => ({ w, kind: "PENDING" as const })),
    ...candidates.filter((c) => !pending.some((p) => p.accountId === c.accountId)).map((w) => ({ w, kind: "BACKFILL" as const })),
  ] : [];

  for (let i = 0; i < work.length; i++) {
    const { w, kind } = work[i];
    const left = phaseDeadline - deps.now();
    if (left < Math.max(cfg.startReserveMs, 2_000)) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred += work.length - i; break; }
    const allowance = cfg.dailyRequestCap - summary.dailyRequestsUsedBefore - total();
    if (kind === "BACKFILL" && allowance <= 0) { summary.stoppedBecause = "DAILY_CAP"; break; } // resumes after UTC midnight, on cadence
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

  // ── BITCOIN ────────────────────────────────────────────────────────────────
  if (btcPlan && deps.btc) {
    phaseDeadline = jobDeadline;
    summary.btc = await runBtcPass(deps, deps.btc, btcCfg, btcPlan, { start, jobDeadline, regenerateUnderLock });
    summary.deferred += summary.btc.deferred;
  }
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
  ctx: { start: number; jobDeadline: number; regenerateUnderLock: (w: { accountId: string; connectionId: string }, fromISO: string, lockStamp: number, withPriceGaps?: boolean) => Promise<{ outcome: "DONE" | "DEFERRED"; stamp: number }> },
): Promise<BtcBackfillPassSummary> {
  const summary: BtcBackfillPassSummary = { ...plan.summary, dailyRequestCap: cfg.dailyRequestCap };
  const meter: Record<string, number> = {};
  const total = () => Object.values(meter).reduce((a, b) => a + b, 0);
  const take = createRateLimiter(cfg.maxRequestsPerSecond, deps.now, deps.sleep);
  const flushed: Record<string, number> = {};
  const flushUsage = async () => { if (btc.recordUsage) { try { await btc.recordUsage(meter, flushed); } catch { /* metering never fails a run */ } } };
  if (plan.work.length === 0) summary.stoppedBecause = "NO_WORK";

  for (let i = 0; i < plan.work.length; i++) {
    const { w, kind } = plan.work[i];
    const left = ctx.jobDeadline - deps.now();
    if (left < Math.max(cfg.startReserveMs, 2_000)) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred += plan.work.length - i; break; }
    const allowance = cfg.dailyRequestCap - summary.dailyRequestsUsedBefore - total();
    if (kind === "BACKFILL" && allowance <= 0) { summary.stoppedBecause = "DAILY_CAP"; break; } // resumes after UTC midnight, on cadence
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
  const { acquireHistoricalPriceGaps, prismaPriceGapDeps, revaluationOwed } = await import("@/lib/prices/price-gap");
  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
