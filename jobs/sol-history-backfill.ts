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
 *     syncs — at every commit. The cap is the sum, so it holds across runs,
 *     overlapping triggers and runs killed mid-flight.
 *   - one global token bucket; per-wallet budget; fair order.
 *   - each wallet under its sync lock, renewed before regeneration and released
 *     only while still ours — a normal sync is never blocked or unlocked.
 *   - wealth history over changed days is regenerated (as a sync does, and
 *     only when WEALTH_REGENERATION_ENABLED), when enough wake time remains;
 *     otherwise it is marked pending in the checkpoint and done first next run.
 *
 * Completion is the backfill's own verdict (beginning reached, head verified,
 * continuity proven) — never "the job succeeded".
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

export const SOL_BACKFILL_JOB = "sol-history-backfill";
/** The dispatcher's invocation is 300 s; plan nothing past this point of a wake. */
export const WAKE_SAFE_MS = 260_000;
/** Do not start a wealth-history regeneration with less than this left. */
export const REGEN_RESERVE_MS = 60_000;

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
  /** Today's requests across every SOL wallet's backfill (worker + syncs), before this run. */
  dailyRequestsUsedBefore: number;
  dailyRequestCap: number;
  budgetMs: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "ALL_RUN";
  /** > 0 ⇒ the dispatcher self-continues this job. */
  deferred: number;
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

export async function solHistoryBackfill(opts: { config?: SolBackfillWorkerConfig; deps?: SolBackfillJobDeps } = {}): Promise<SolBackfillJobSummary> {
  const cfg = opts.config ?? workerConfig();
  const summary: SolBackfillJobSummary = {
    enabled: cfg.enabled, eligible: 0, walletsRun: 0, walletsSkippedLocked: 0, completed: 0, promoted: 0,
    failures: {}, signaturesProcessed: 0, rowsWritten: 0, regenerated: 0, regenerationsDeferred: 0,
    requests: { total: 0 }, estimatedUnits: 0, dailyRequestsUsedBefore: 0, dailyRequestCap: cfg.dailyRequestCap,
    budgetMs: 0, stoppedBecause: "DISABLED", deferred: 0,
  };
  if (!cfg.enabled) return summary;
  const deps = opts.deps ?? await productionDeps();
  const meter: Record<string, number> = {};
  const total = () => Object.values(meter).reduce((a, b) => a + b, 0);

  const start = deps.now();
  const wake = await deps.wakeStartedAt();
  const jobDeadline = Math.min(start + cfg.jobBudgetMs, (wake ?? start) + WAKE_SAFE_MS);
  summary.budgetMs = Math.max(0, jobDeadline - start);

  const wallets = await deps.wallets();
  const day = new Date(start).toISOString().slice(0, 10);
  const parsed = wallets.map((w) => ({ ...w, checkpoint: parseCheckpoint(w.cursor, w.accountId, w.address) }));
  summary.dailyRequestsUsedBefore = parsed.reduce((a, w) => a + usageOn(w.checkpoint, day), 0);

  // Regenerations owed by earlier runs come first — snapshots must catch up with rows.
  const pending = parsed.filter((w) => w.checkpoint?.snapshotPendingFromISO);
  const candidates = orderCandidates(parsed, start);
  summary.eligible = candidates.length;
  if (candidates.length === 0 && pending.length === 0) { summary.stoppedBecause = "NO_WORK"; return summary; }

  const take = createRateLimiter(cfg.maxRequestsPerSecond, deps.now, deps.sleep);
  summary.stoppedBecause = "ALL_RUN";

  /** Returns the outcome and the lock stamp now in force (renewed, or unchanged). */
  const regenerateUnderLock = async (w: WorkerWallet, fromISO: string, lockStamp: number): Promise<{ outcome: "DONE" | "DEFERRED"; stamp: number }> => {
    if (!deps.regenerationEnabled()) return { outcome: "DONE", stamp: lockStamp }; // nothing to keep in step (sync-crypto applies the same rule)
    if (jobDeadline - deps.now() < REGEN_RESERVE_MS) return { outcome: "DEFERRED", stamp: lockStamp };
    const renewed = Math.max(deps.now(), lockStamp + 1);
    if (!(await deps.renewLock(w.connectionId, lockStamp, renewed))) return { outcome: "DEFERRED", stamp: lockStamp };
    try { await deps.regenerate(w.accountId, fromISO, start); return { outcome: "DONE", stamp: renewed }; }
    catch (e) {
      console.warn(`[${SOL_BACKFILL_JOB}] wealth-history regen failed (non-fatal):`, e instanceof Error ? e.message : String(e));
      return { outcome: "DEFERRED", stamp: renewed };
    }
  };

  const work: Array<{ w: (typeof parsed)[number]; kind: "PENDING" | "BACKFILL" }> = [
    ...pending.map((w) => ({ w, kind: "PENDING" as const })),
    ...candidates.filter((c) => !pending.some((p) => p.accountId === c.accountId)).map((w) => ({ w, kind: "BACKFILL" as const })),
  ];

  for (let i = 0; i < work.length; i++) {
    const { w, kind } = work[i];
    const left = jobDeadline - deps.now();
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

  summary.requests = { ...meter, total: total() };
  summary.estimatedUnits = (meter.getTransaction ?? 0) * ALCHEMY_PAYG.unitsPerGetTransaction
    + (meter.getSignaturesForAddress ?? 0) * ALCHEMY_PAYG.unitsPerGetSignatures;
  return summary;
}

/** Production wiring. fm_system: the sweep spans every customer's wallets (lazy, as the other jobs). */
async function productionDeps(): Promise<SolBackfillJobDeps> {
  const { systemDb } = await import("@/lib/db");
  const { reconstructSolHistoryResumable, prismaSolBackfillStore } = await import("@/lib/crypto/sol-history-backfill.store");
  const { resolveHistoricalWorkWindow } = await import("@/lib/snapshots/historical-work-window");
  const { regenerateWealthHistoryForAccounts, wealthRegenerationEnabled } = await import("@/lib/snapshots/regenerate-history");
  const { WALLET_LOCK_TTL_MS } = await import("@/lib/refresh/wallet-lock");
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
    async regenerate(accountId, fromISO, startedAtMs) {
      const plan = await resolveHistoricalWorkWindow({ financialAccountIds: [accountId], changedSince: new Date(startedAtMs), positionHistoryImpactedFromISO: fromISO });
      await regenerateWealthHistoryForAccounts([accountId], { fromDate: plan.fromDate, toDate: plan.toDate });
    },
  };
}
