/**
 * lib/crypto/wallet-refresh.ts
 *
 * THE SCHEDULED WALLET REFRESH — every syncable wallet, one pipeline.
 *
 * Before this module the 6-hourly crypto job refreshed Bitcoin only, through
 * `syncAllBtcWallets` → `syncBtcWallet` directly. Ethereum and Solana had no
 * scheduled refresh at all, and even Bitcoin's scheduled path skipped two things
 * the manual path did: recording a refusal on `Connection.errorCode`, and the W6f
 * post-sync history refresh. Scheduled and manual were two semantics.
 *
 * Now:
 *
 *   select   every live wallet whose chain the sync registry can read
 *            (SYNCABLE_CHAINS — a chain that gains an adapter is scheduled by
 *            that fact alone; nothing here names a chain)
 *   order    oldest successful refresh first, never-synced first of all — except
 *            that a wallet whose last attempt FAILED recently goes after every
 *            wallet that did not (fairness: a persistently failing wallet never
 *            advances its success clock, so by age alone it would lead every run
 *            forever). It is not suppressed and nothing about its freshness moves.
 *   due      skip a wallet refreshed recently enough under the WALLET refresh
 *            policy (so a :30 continuation slot does not repeat the :00 slot,
 *            and a 12h policy is honoured by attempting every other slot)
 *   admit    provider ingestion admission, once per sweep — an operator's pause
 *            stops the sweep, exactly as it stops sync-banks
 *   sync     `syncWalletByChain` — THE SAME call the manual route makes. Chain
 *            adapters stay specialised; clocks, failure recording and history
 *            refresh are the dispatcher's, once
 *   budget   no new wallet starts after the work budget; the rest are reported
 *            as deferred and picked up by the continuation slot
 *
 * ⚠️ SEQUENTIAL ON PURPOSE. Every wallet sync leaves the one server IP for a
 * public explorer or RPC endpoint (the manual route's per-user limit exists for
 * the same shared-IP ban risk). The sweep is not a user and does not consume the
 * user-facing rate limit; it bounds itself by running one wallet at a time.
 *
 * ⚠️ SUCCESS CLOCKS ARE THE ADAPTERS'. A successful adapter writes
 * `FinancialAccount.lastUpdated` and, via alignWalletProviderSpine,
 * `Connection.lastSyncedAt`; a failed one writes neither and records its
 * refusal. This module writes no clock and no financial row of its own.
 */

import { SYNCABLE_CHAINS, syncWalletByChain, type WalletSyncOutcome } from './wallet-sync-dispatch';
import { isDueForScheduledRefresh, type RefreshPolicy } from '@/lib/platform/refresh-policy.core';

/**
 * Work budget per sweep: no wallet STARTS after this. Sized against measurement,
 * not hope: a real Ethereum wallet took 157 s (almost all of it the post-sync
 * history reconstruction, which re-runs over the wallet's whole evidence range);
 * Bitcoin and Solana took ~10 s. The dispatch route allows 300 s, and the 06:00
 * slot runs sync-banks first — so a wallet started at 89 s must still finish:
 * 90 s + ~160 s leaves headroom. Whatever is not started is deferred to the :30
 * continuation slot.
 */
export const WALLET_SWEEP_BUDGET_MS = 90_000;

export interface ScheduledWalletCandidate {
  accountId: string;
  chain: string;
  /** The older of account lastUpdated and Connection.lastSyncedAt; null when never fully synced. */
  lastSuccessAt: Date | null;
  /** The latest WALLET_SYNC_FAILED occurrence for this account (SyncIssue.lastOccurredAt), if any. */
  lastFailureAt?: Date | null;
}

const HOUR_MS = 3_600_000;

/**
 * How long a failure deprioritises a wallet: half the expected cadence, at most
 * three hours. At the 6h default a wallet that failed at :00 yields the :30
 * continuation to untouched wallets and is back at full priority by the next
 * 6-hourly run.
 */
export function recentFailureWindowMs(policy: Pick<RefreshPolicy, "expectedEveryHours">): number {
  return Math.min(3 * HOUR_MS, (policy.expectedEveryHours * HOUR_MS) / 2);
}

/** A failure newer than the last success, inside the window. */
export function failedRecently(w: ScheduledWalletCandidate, policy: Pick<RefreshPolicy, "expectedEveryHours">, now: Date): boolean {
  if (!w.lastFailureAt) return false;
  if (w.lastSuccessAt && w.lastFailureAt <= w.lastSuccessAt) return false;
  return now.getTime() - w.lastFailureAt.getTime() < recentFailureWindowMs(policy);
}

/**
 * Deterministic sweep order: wallets not recently failed first (never-synced,
 * then oldest success — a budget-deferred wallet keeps its urgency), then the
 * recently failed (oldest failure first). Ties break on account id.
 */
export function sweepOrder(
  wallets: readonly ScheduledWalletCandidate[], policy: Pick<RefreshPolicy, "expectedEveryHours">, now: Date,
): ScheduledWalletCandidate[] {
  const t = (d: Date | null | undefined) => d?.getTime() ?? -Infinity;
  return [...wallets].sort((a, b) => {
    const fa = failedRecently(a, policy, now), fb = failedRecently(b, policy, now);
    if (fa !== fb) return fa ? 1 : -1;
    const primary = fa ? t(a.lastFailureAt) - t(b.lastFailureAt) : t(a.lastSuccessAt) - t(b.lastSuccessAt);
    return primary !== 0 && !Number.isNaN(primary) ? primary : a.accountId.localeCompare(b.accountId);
  });
}

export interface WalletRefreshDeps {
  listWallets(): Promise<ScheduledWalletCandidate[]>;
  sync(accountId: string, chain: string): Promise<WalletSyncOutcome>;
  policy(): Promise<RefreshPolicy>;
  admit(): Promise<{ decision: 'ADMIT' | 'DENY'; reason?: string | null }>;
  clock(): number;
}

export interface ChainTally { attempted: number; succeeded: number; failed: number; durationMs: number }

export interface WalletRefreshResult {
  /** Every syncable wallet found. */
  total: number;
  /** Refreshed recently enough under the policy; not attempted this sweep. */
  notDue: number;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Due, but left for the continuation slot because the budget ran out. */
  deferred: number;
  byChain: Record<string, ChainTally>;
  /** Failure stages, counted — never ids or provider text. */
  failureStages: Record<string, number>;
  syncedAccountIds: string[];
  /** Due wallets placed after the rest because their last attempt failed recently. */
  deprioritizedRecentFailures: number;
  /** The earliest reconstructed-history date any synced wallet changed (measured by ETH), for regeneration. */
  historyImpactedFromISO: string | null;
  slowestWalletMs: number;
  elapsedMs: number;
  policy: { cadence: string; overdueAfterHours: number; version: string };
  /** The admission reason when the sweep was not admitted. */
  notAdmitted?: string;
}

async function defaultDeps(): Promise<WalletRefreshDeps> {
  const { db } = await import('@/lib/db');
  const { loadRefreshPolicies } = await import('@/lib/platform/refresh-policy');
  const { admitOperationalWork } = await import('@/lib/platform/admission/facts');
  return {
    listWallets: async () => {
      const rows = await db.financialAccount.findMany({
        where: {
          walletChain: { in: [...SYNCABLE_CHAINS] },
          deletedAt: null,
          // A deactivated user's wallets stop accruing provider calls, as their banks do.
          OR: [{ ownerUserId: null }, { ownerUser: { deactivatedAt: null } }],
        },
        select: {
          id: true, walletChain: true, lastUpdated: true,
          connections: {
            where:  { deletedAt: null, connectionId: { not: null } },
            select: { connection: { select: { lastSyncedAt: true } } },
          },
        },
      });
      // The recent-failure authority that already exists: the wallet sync incident's last occurrence.
      const failures = rows.length === 0 ? [] : await db.syncIssue.groupBy({
        by: ['financialAccountId'],
        where: { kind: 'WALLET_SYNC_FAILED', financialAccountId: { in: rows.map((r) => r.id) } },
        _max: { lastOccurredAt: true, createdAt: true },
      });
      const failedAt = new Map(failures.map((f) => [f.financialAccountId, f._max.lastOccurredAt ?? f._max.createdAt ?? null]));
      return rows.map((r) => {
        const synced = r.connections.map((c) => c.connection?.lastSyncedAt).find((d): d is Date => d instanceof Date) ?? null;
        return {
          accountId: r.id,
          chain: r.walletChain!,
          // Never fully synced ⇒ no success clock, however recent the row's creation.
          lastSuccessAt: synced ? new Date(Math.min(synced.getTime(), r.lastUpdated.getTime())) : null,
          lastFailureAt: failedAt.get(r.id) ?? null,
        };
      });
    },
    sync: (accountId, chain) => syncWalletByChain(accountId, chain),
    policy: async () => (await loadRefreshPolicies(db)).WALLET,
    admit: () => admitOperationalWork({ work: 'REFRESH_EXECUTION' }),
    clock: () => Date.now(),
  };
}

export async function refreshScheduledWallets(options: {
  now?: Date;
  budgetMs?: number;
  deps?: Partial<WalletRefreshDeps>;
} = {}): Promise<WalletRefreshResult> {
  const needed: (keyof WalletRefreshDeps)[] = ['listWallets', 'sync', 'policy', 'admit', 'clock'];
  const deps = { ...(needed.every((k) => options.deps?.[k]) ? {} : await defaultDeps()), ...options.deps } as WalletRefreshDeps;
  const budgetMs = options.budgetMs ?? WALLET_SWEEP_BUDGET_MS;
  const start = deps.clock();
  const now = options.now ?? new Date(start);

  const [wallets, policy] = await Promise.all([deps.listWallets(), deps.policy()]);
  const due = sweepOrder(wallets.filter((w) => isDueForScheduledRefresh(w.lastSuccessAt, policy, now)), policy, now);

  const result: WalletRefreshResult = {
    total: wallets.length, notDue: wallets.length - due.length,
    attempted: 0, succeeded: 0, failed: 0, deferred: 0,
    byChain: {}, failureStages: {}, syncedAccountIds: [], slowestWalletMs: 0, elapsedMs: 0,
    deprioritizedRecentFailures: due.filter((w) => failedRecently(w, policy, now)).length,
    historyImpactedFromISO: null,
    policy: { cadence: policy.cadence, overdueAfterHours: policy.overdueAfterHours, version: policy.version },
  };
  const finish = () => { result.elapsedMs = deps.clock() - start; return result; };
  if (due.length === 0) return finish();

  const admission = await deps.admit();
  if (admission.decision === 'DENY') {
    console.log(`[wallet-refresh] ${due.length} wallet(s) due but NOT ADMITTED — ${admission.reason}; no provider call.`);
    result.notAdmitted = admission.reason ?? 'DENIED';
    result.deferred = due.length;
    return finish();
  }

  for (let i = 0; i < due.length; i++) {
    if (deps.clock() - start >= budgetMs) {
      result.deferred = due.length - i;
      console.log(`[wallet-refresh] budget of ${budgetMs} ms spent; ${result.deferred} wallet(s) deferred to the continuation slot.`);
      break;
    }
    const w = due[i];
    const t0 = deps.clock();
    let outcome: WalletSyncOutcome;
    try {
      outcome = await deps.sync(w.accountId, w.chain);
    } catch (err) {
      // syncWalletByChain never throws; an injected or future sync might.
      outcome = { accountId: w.accountId, chain: w.chain, support: 'UNSUPPORTED', ok: false, stage: 'adapter-error',
        reason: err instanceof Error ? err.message : String(err), netWorthParticipation: 'NONE' };
    }
    const ms = deps.clock() - t0;
    const tally = (result.byChain[w.chain] ??= { attempted: 0, succeeded: 0, failed: 0, durationMs: 0 });
    tally.attempted++; tally.durationMs += ms;
    result.attempted++;
    result.slowestWalletMs = Math.max(result.slowestWalletMs, ms);
    if (outcome.ok) {
      tally.succeeded++; result.succeeded++;
      result.syncedAccountIds.push(w.accountId);
      const impacted = outcome.historyRefresh?.impactedFromISO ?? null;
      if (impacted && (!result.historyImpactedFromISO || impacted < result.historyImpactedFromISO)) result.historyImpactedFromISO = impacted;
    } else {
      tally.failed++; result.failed++;
      const stage = outcome.errorCode ?? outcome.stage ?? 'unknown';
      result.failureStages[stage] = (result.failureStages[stage] ?? 0) + 1;
    }
    console.log(`[wallet-refresh] ${w.chain} ${outcome.ok ? 'synced' : `failed (${outcome.errorCode ?? outcome.stage})`} in ${ms} ms`);
  }
  return finish();
}
