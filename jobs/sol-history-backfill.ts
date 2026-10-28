/**
 * jobs/sol-history-backfill.ts
 *
 * The dedicated background worker for large Solana histories (owner decision
 * 2, 2026-10-28). A wallet sync runs the backfill only briefly (15 s) so the
 * holdings refresh stays responsive; this job carries the rest.
 *
 * SCHEDULING: registered `selfContinues` (lib/jobs/registry.core.ts). While any
 * eligible wallet remains it reports `deferred > 0`, and the dispatcher (every
 * 15 minutes) runs it again CONTINUATION_DELAY_MS later — automatic
 * continuation across executions, through the existing Jobs ledger. One
 * instance at a time: the JobRun claim (one running row per job).
 *
 * PER RUN (decisions: lib/crypto/sol-backfill-worker.core.ts):
 *   - OFF unless SOL_BACKFILL_ENABLED=true;
 *   - stops starting wallets at the job budget, gives each wallet at most the
 *     wallet budget, fair order (never started → least recently progressed);
 *   - one global token bucket for provider requests, and a DAILY request cap
 *     summed from this job's own JobRun summaries — spending cannot run away;
 *   - each wallet under its sync lock (a normal wallet sync is never blocked:
 *     a wallet being synced is simply skipped this run);
 *   - rows changed ⇒ that account's wealth history is regenerated over the
 *     impacted window, exactly as a wallet sync does (no new snapshot writer).
 *
 * Completion is the backfill's own verdict (head verified, beginning reached,
 * continuity proven) — never "the job succeeded".
 *
 * SUMMARY: counts, request meter and estimated units only — no ids, no
 * addresses, no balances.
 */

import { parseCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import {
  workerConfig, orderCandidates, createRateLimiter, ALCHEMY_PAYG,
  type SolBackfillWorkerConfig,
} from "@/lib/crypto/sol-backfill-worker.core";

export const SOL_BACKFILL_JOB = "sol-history-backfill";

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
  requests: Record<string, number> & { total: number };
  /** Estimated provider units at the modelled price (Alchemy PAYG), for observability only. */
  estimatedUnits: number;
  dailyRequestsUsedBefore: number;
  dailyRequestCap: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "ALL_RUN";
  /** > 0 ⇒ the dispatcher self-continues this job. */
  deferred: number;
}

function startOfUTCDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function solHistoryBackfill(opts: { now?: () => number; config?: SolBackfillWorkerConfig } = {}): Promise<SolBackfillJobSummary> {
  const now = opts.now ?? Date.now;
  const cfg = opts.config ?? workerConfig();
  const meter: Record<string, number> = {};
  const total = () => Object.values(meter).reduce((a, b) => a + b, 0);
  const summary: SolBackfillJobSummary = {
    enabled: cfg.enabled, eligible: 0, walletsRun: 0, walletsSkippedLocked: 0, completed: 0, promoted: 0,
    failures: {}, signaturesProcessed: 0, rowsWritten: 0, requests: { total: 0 }, estimatedUnits: 0,
    dailyRequestsUsedBefore: 0, dailyRequestCap: cfg.dailyRequestCap, stoppedBecause: "DISABLED", deferred: 0,
  };
  if (!cfg.enabled) return summary;

  // fm_system: the sweep spans every customer's wallets (lazy import, as the other jobs).
  const { systemDb } = await import("@/lib/db");
  const { reconstructSolHistoryResumable } = await import("@/lib/crypto/sol-history-backfill.store");
  const { claimWalletSyncLock, releaseWalletSyncLock } = await import("@/lib/refresh/wallet-lock");
  const { resolveHistoricalWorkWindow } = await import("@/lib/snapshots/historical-work-window");
  const { regenerateWealthHistoryForAccounts } = await import("@/lib/snapshots/regenerate-history");

  const start = now();
  // Today's spend so far, from this job's own ledger (durable, no new table).
  const todays = await systemDb.jobRun.findMany({
    where: { jobName: SOL_BACKFILL_JOB, startedAt: { gte: startOfUTCDay(new Date(start)) } },
    select: { summary: true },
  });
  summary.dailyRequestsUsedBefore = todays.reduce((a, r) => a + (Number((r.summary as { requests?: { total?: number } } | null)?.requests?.total) || 0), 0);

  const rows = await systemDb.accountConnection.findMany({
    where: { deletedAt: null, connectionId: { not: null },
      connection: { provider: "WALLET", status: "ACTIVE" },
      financialAccount: { deletedAt: null, walletChain: "SOL", walletAddress: { not: null } } },
    select: { financialAccountId: true, connectionId: true,
      connection: { select: { cursor: true } }, financialAccount: { select: { walletAddress: true } } },
  });
  const candidates = orderCandidates(rows.map((r) => {
    const address = r.financialAccount.walletAddress!;
    return { accountId: r.financialAccountId, connectionId: r.connectionId!, cursor: r.connection?.cursor ?? null, address,
      checkpoint: parseCheckpoint(r.connection?.cursor ?? null, r.financialAccountId, address) };
  }), start);
  summary.eligible = candidates.length;
  if (candidates.length === 0) { summary.stoppedBecause = "NO_WORK"; return summary; }

  const take = createRateLimiter(cfg.maxRequestsPerSecond, now, (ms) => new Promise((r) => setTimeout(r, ms)));
  const jobDeadline = start + cfg.jobBudgetMs;
  summary.stoppedBecause = "ALL_RUN";

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const left = jobDeadline - now();
    if (left < cfg.startReserveMs) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred = candidates.length - i; break; }
    const allowance = cfg.dailyRequestCap - summary.dailyRequestsUsedBefore - total();
    if (allowance <= 0) { summary.stoppedBecause = "DAILY_CAP"; summary.deferred = 0; break; } // tomorrow, not in 15 minutes
    if (!(await claimWalletSyncLock(c.connectionId, systemDb))) { summary.walletsSkippedLocked++; summary.deferred++; continue; }
    try {
      const r = await reconstructSolHistoryResumable({
        accountId: c.accountId, client: systemDb,
        deps: { budgetMs: Math.min(cfg.walletBudgetMs, left - 2_000), concurrency: cfg.concurrency,
          beforeRequest: take, meter, requestBudget: allowance, now },
      });
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
      // History moved ⇒ the wealth history over the impacted window, as a sync does.
      if (r.derivedRowsWritten > 0 && r.impactedFromISO) {
        try {
          const plan = await resolveHistoricalWorkWindow({ financialAccountIds: [c.accountId], changedSince: new Date(start),
            positionHistoryImpactedFromISO: r.impactedFromISO });
          await regenerateWealthHistoryForAccounts([c.accountId], { fromDate: plan.fromDate, toDate: plan.toDate });
        } catch (e) {
          console.warn(`[${SOL_BACKFILL_JOB}] wealth-history regen failed (non-fatal):`, e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      await releaseWalletSyncLock(c.connectionId, systemDb);
    }
  }

  summary.requests = { ...meter, total: total() };
  summary.estimatedUnits = (meter.getTransaction ?? 0) * ALCHEMY_PAYG.unitsPerGetTransaction
    + (meter.getSignaturesForAddress ?? 0) * ALCHEMY_PAYG.unitsPerGetSignatures;
  return summary;
}
