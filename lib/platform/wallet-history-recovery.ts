/**
 * lib/platform/wallet-history-recovery.ts  (OPS — audited per-wallet history recovery)
 *
 * The I/O half of Platform Ops' "Resume history" for ONE wallet connection
 * (decisions: ./wallet-history-recovery.core.ts). Two entry points:
 *
 *   previewWalletHistoryResume   what the operator reviews before confirming:
 *                                the current state, failure code, proven range,
 *                                progress, the budget left today, whether a
 *                                sync holds the lock, and whether resume is
 *                                allowed (and if not, why). Reads only.
 *   resumeWalletHistory          ONE bounded pass with the chain's existing
 *                                operator `resume` option:
 *                                  eligibility → admission → budget → lock →
 *                                  eligibility again (under the lock) → pass →
 *                                  meter flush → regeneration marker →
 *                                  release → re-read → audit.
 *
 * Every step after the reason parses is audited through recordOperatorAction
 * (WALLET_HISTORY_RESUMED): REFUSED for every refusal (not found, wrong state,
 * worker disabled, not admitted, budget exhausted, already running), SUCCESS or
 * FAILURE for a pass that ran. A refusal changes nothing on the wallet.
 *
 * THE LOCK is the worker's own: Connection.syncLockedAt claimed with a stamp
 * (free or stale past WALLET_LOCK_TTL_MS) and released only while still ours,
 * so a wallet sync or the worker is never raced or unlocked.
 *
 * REGENERATION is not run inline. When the pass changed stored days, the
 * checkpoint's regeneration-pending marker is set (the worker's own helper) and
 * the worker regenerates wealth history first thing on its next run — exactly
 * what it does for a regeneration it had to defer. This is one reason the
 * chain's worker flag must be ON (core header).
 *
 * AUTHORITY: the caller's client (fm_system from the route) — an operator acts
 * across tenants, but only on the ONE connection named, re-read here; nothing
 * about any other customer is read or returned.
 */

import type { PrismaClient } from "@prisma/client";
import type { OperatorActionInput, OperatorReason } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import type { LedgerCalls } from "@/lib/usage/provider-budget.core";
import { historyWorkerEnabledFor } from "@/lib/crypto/history-checkpoint-status";
import { workerConfig, createRateLimiter } from "@/lib/crypto/sol-backfill-worker.core";
import { btcWorkerConfig } from "@/lib/crypto/btc-backfill-worker.core";
import { ethWorkerConfig, probeBudgetFor } from "@/lib/crypto/eth-history-backfill.core";
import {
  decideEligibility, passBudget, summarizePass, stateView, chainCheckpointStatus, isResumableChain, recoveryCodeOf, REFUSAL_HTTP_STATUS, normalizeChain,
  type WalletHistoryTarget, type ResumableChain, type PassLimits, type PassBudget, type PassResult,
  type RecoveryRefusal, type RecoveryRefusalCode, type HistoryStateView,
} from "./wallet-history-recovery.core";

/** Must equal lib/refresh/wallet-lock.ts WALLET_LOCK_TTL_MS (pinned by the test). */
export const RECOVERY_LOCK_TTL_MS = 360_000;
/** The wall-clock bound of one operator pass (the route's maxDuration leaves headroom). */
export const RECOVERY_PASS_BUDGET_MS = 75_000;

export interface WalletHistoryRecoveryDeps {
  now(): number;
  workerEnabled(chain: ResumableChain): boolean;
  loadTarget(connectionId: string): Promise<WalletHistoryTarget | null>;
  /** The canonical admission evaluator (maintenance / ingestion paused). */
  admit(): Promise<{ admitted: true } | { admitted: false; reason: string; label: string }>;
  limits(chain: ResumableChain): PassLimits;
  probeBudgetFor(allowanceCalls: number, configured: number): number;
  /** Today's ledger calls for the chain's provider (ALCHEMY for SOL/ETH, ESPLORA for BTC); null = unreadable. */
  providerUsageToday(chain: ResumableChain, dayISO: string): Promise<LedgerCalls | null>;
  claimLock(connectionId: string, stampMs: number): Promise<boolean>;
  releaseLock(connectionId: string, stampMs: number): Promise<void>;
  /**
   * ONE bounded pass with `resume: true` on the chain's runner, bound to THIS
   * connection. "UNBOUND" when the chain's store would bind another connection
   * (checked again under the lock). Every provider request lands in `meter`.
   */
  runPass(args: { chain: ResumableChain; accountId: string; connectionId: string; budget: PassBudget; meter: Record<string, number>; deadlineMs: number }): Promise<PassResult | "UNBOUND">;
  /** Flush `meter` to the shared provider ledger. Never throws. */
  recordUsage(chain: ResumableChain, meter: Readonly<Record<string, number>>): Promise<void>;
  /** Set the checkpoint's regeneration-pending marker from `fromISO`. False ⇒ not written. */
  markRegenerationPending(chain: ResumableChain, accountId: string, fromISO: string): Promise<boolean>;
  audit(input: OperatorActionInput): Promise<void>;
}

export interface RecoveryActor {
  actor: OperatorActionInput["actor"];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface WalletHistoryPreview {
  connectionId: string;
  chain: string | null;
  history: HistoryStateView | null;
  requestsToday: number;
  lastProgressAtISO: string | null;
  workerEnabled: boolean;
  budget: { dailyRequestCap: number; usedToday: number; remaining: number } | null;
  /** A sync or the worker holds this wallet's lock right now. */
  running: boolean;
  /** Resume would be accepted now (eligibility, admission, budget, lock). */
  allowed: boolean;
  refusal: RecoveryRefusal | null;
}

export type ResumeOutcome =
  | {
      ok: true;
      connectionId: string; chain: ResumableChain;
      before: HistoryStateView; after: HistoryStateView | null;
      result: "SUCCESS" | "FAILURE";
      stoppedBecause: string; failureCode: string | null;
      requests: number; rowsWritten: number;
      moreWorkRemains: boolean; continuesAutomatically: boolean; regenerationPending: boolean;
      /** The pass ran but its audit row could not be written (logged); the outcome is still the real one. */
      auditFailed: boolean;
    }
  | { ok: false; status: number; refusal: RecoveryRefusal; connectionId: string; chain: string | null; before: HistoryStateView | null };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const meterSum = (m: Readonly<Record<string, number>>) => Object.values(m).reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);

export async function previewWalletHistoryResume(connectionId: string, deps: WalletHistoryRecoveryDeps): Promise<WalletHistoryPreview> {
  const nowMs = deps.now();
  const today = dayOf(nowMs);
  const target = await deps.loadTarget(connectionId);
  const el = decideEligibility(target, { todayISO: today, workerEnabled: deps.workerEnabled });
  const chain = el.chain;
  const status = el.status;
  const running = !!target?.lockedAt && nowMs - target.lockedAt.getTime() < RECOVERY_LOCK_TTL_MS;
  const base = {
    connectionId, chain, history: viewWithRecovery(target, chain, status),
    requestsToday: status?.requestsToday ?? 0, lastProgressAtISO: status?.lastProgressAtISO ?? null,
    workerEnabled: isResumableChain(chain) ? deps.workerEnabled(chain) : false,
  };
  if (!el.ok) return { ...base, budget: null, running, allowed: false, refusal: el.refusal };
  const budget = await budgetFor(el.chain, status?.requestsToday ?? 0, today, deps);
  const view = { dailyRequestCap: budget.dailyRequestCap, usedToday: budget.usedToday, remaining: budget.remaining };
  const admission = await deps.admit();
  const refusal: RecoveryRefusal | null = !admission.admitted ? { code: "NOT_ADMITTED", message: admission.label }
    : budget.exhausted ? budgetRefusal(el.chain)
    : running ? { code: "ALREADY_RUNNING", message: "A sync or the history worker is running on this wallet now; try again when it finishes." }
    : null;
  return { ...base, budget: view, running, allowed: refusal === null, refusal };
}

/** The status view plus the code that put it there (RECOVERY_REQUIRED's own code). */
function viewWithRecovery(target: WalletHistoryTarget | null, chain: string | null, status: Parameters<typeof stateView>[0]): HistoryStateView | null {
  const v = stateView(status);
  if (!v || !target || !status || !isResumableChain(chain)) return v;
  return { ...v, recoveryCode: recoveryCodeOf(target, chain, status) };
}

function budgetRefusal(chain: ResumableChain): RecoveryRefusal {
  const provider = chain === "BTC" ? "Esplora" : "Alchemy";
  return { code: "BUDGET_EXHAUSTED", message: `Today's shared ${provider} history budget is spent; resume after 00:00 UTC (nothing was changed).` };
}

async function budgetFor(chain: ResumableChain, checkpointCalls: number, dayISO: string, deps: WalletHistoryRecoveryDeps): Promise<PassBudget> {
  const ledger = await deps.providerUsageToday(chain, dayISO).catch(() => null);
  return passBudget(chain, deps.limits(chain), ledger, checkpointCalls, deps.probeBudgetFor);
}

/**
 * Resume ONE wallet's history: one bounded pass, audited whatever happens.
 * `reason` was parsed by the caller (structured code + required note).
 */
export async function resumeWalletHistory(
  input: { connectionId: string; reason: OperatorReason } & RecoveryActor,
  deps: WalletHistoryRecoveryDeps,
): Promise<ResumeOutcome> {
  const { connectionId } = input;
  const startMs = deps.now();
  const today = dayOf(startMs);
  const target = await deps.loadTarget(connectionId);
  const el = decideEligibility(target, { todayISO: today, workerEnabled: deps.workerEnabled });
  const before = viewWithRecovery(target, el.chain, el.status);

  const envelope = (result: OperatorActionInput["result"], chain: string | null, after: HistoryStateView | null, detail: Record<string, unknown>): OperatorActionInput => ({
    actor: input.actor,
    action: AuditAction.WALLET_HISTORY_RESUMED,
    target: { kind: "CONNECTION", id: connectionId },
    reason: input.reason,
    change: { before: before ? { state: before.state, lastFailureCode: before.lastFailureCode, verifiedFromISO: before.verifiedFromISO } : null,
      after: after ? { state: after.state, lastFailureCode: after.lastFailureCode, verifiedFromISO: after.verifiedFromISO } : null },
    result,
    detail: { connectionId, provider: "WALLET", chain, ...detail },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  const refuse = async (refusal: RecoveryRefusal, chain: string | null, extra: Record<string, unknown> = {}): Promise<ResumeOutcome> => {
    // A path id that names no connection gets no audit row (it would let any
    // caller write arbitrary ids into the log); it is logged instead.
    if (refusal.code === "NOT_FOUND" && target === null) console.warn("[wallet-history-recovery] resume refused: connection not found");
    else await deps.audit(envelope("REFUSED", chain, before, { outcome: "refused", refusal: refusal.code, requests: 0, ...extra }));
    return { ok: false, status: REFUSAL_HTTP_STATUS[refusal.code], refusal, connectionId, chain, before };
  };

  if (!el.ok) return refuse(el.refusal, el.chain);
  const { chain, accountId } = el;

  const admission = await deps.admit();
  if (!admission.admitted) return refuse({ code: "NOT_ADMITTED", message: admission.label }, chain, { admissionReason: admission.reason });

  const budget = await budgetFor(chain, el.status.requestsToday, today, deps);
  if (budget.exhausted) {
    return refuse(budgetRefusal(chain), chain, { dailyRequestCap: budget.dailyRequestCap, usedToday: budget.usedToday });
  }

  const stamp = deps.now();
  if (!(await deps.claimLock(connectionId, stamp))) {
    return refuse({ code: "ALREADY_RUNNING", message: "A sync or the history worker is running on this wallet now; nothing was changed." }, chain);
  }

  // Re-decide UNDER the lock: a sync or the worker may have moved the
  // checkpoint between the first read and the claim.
  const locked = decideEligibility(await deps.loadTarget(connectionId).catch(() => null), { todayISO: today, workerEnabled: deps.workerEnabled });
  if (!locked.ok || locked.chain !== chain || locked.accountId !== accountId) {
    await deps.releaseLock(connectionId, stamp);
    return refuse(locked.ok ? { code: "NOT_HISTORY_LINK", message: "This connection's wallet changed; review it again." } : locked.refusal, chain, { recheckedUnderLock: true });
  }

  const meter: Record<string, number> = {};
  let pass: PassResult | "UNBOUND";
  let regenerationPending = false;
  try {
    try {
      pass = await deps.runPass({ chain, accountId, connectionId, budget, meter, deadlineMs: stamp + RECOVERY_PASS_BUDGET_MS });
    } catch (e) {
      // The runners do not throw for provider failures (they record a coded
      // failure on the checkpoint); anything that escapes is recorded as such.
      console.error("[wallet-history-recovery] pass threw:", e instanceof Error ? e.message : String(e));
      pass = { stoppedBecause: "ERROR", rowsWritten: 0, impactedFromISO: null, failureCode: "PASS_ERROR" };
    }
    if (pass !== "UNBOUND" && pass.impactedFromISO) {
      regenerationPending = await deps.markRegenerationPending(chain, accountId, pass.impactedFromISO).catch(() => false);
    }
  } finally {
    await deps.recordUsage(chain, meter).catch(() => undefined);
    await deps.releaseLock(connectionId, stamp);
  }
  const requests = meterSum(meter);
  if (pass === "UNBOUND") {
    return refuse({ code: "NOT_HISTORY_LINK", message: "This wallet's history is kept on another of its connections; resume that one." }, chain, { requests });
  }

  const reread = await deps.loadTarget(connectionId).catch(() => null);
  const afterStatus = reread ? chainCheckpointStatus(reread, chain, dayOf(deps.now())) : null;
  const summary = summarizePass(afterStatus, pass, { workerEnabled: deps.workerEnabled(chain), regenerationPending });

  // The pass already happened: a failed audit write must not turn its real
  // outcome into a 500. Logged loudly and flagged on the result instead.
  let auditFailed = false;
  try {
    await deps.audit(envelope(summary.result, chain, summary.after, {
      outcome: summary.result === "SUCCESS" ? "resumed" : "failed",
      stoppedBecause: pass.stoppedBecause, failureCode: pass.failureCode,
      requests, rowsWritten: pass.rowsWritten,
      moreWorkRemains: summary.moreWorkRemains, continuesAutomatically: summary.continuesAutomatically,
      regenerationPending,
    }));
  } catch (e) {
    auditFailed = true;
    console.error(`[wallet-history-recovery] AUDIT WRITE FAILED after a pass on connection ${connectionId} (${chain}, ${summary.result}, ${requests} requests):`,
      e instanceof Error ? e.message : String(e));
  }

  return {
    ok: true, connectionId, chain, before: before!, after: summary.after, result: summary.result,
    stoppedBecause: pass.stoppedBecause, failureCode: pass.failureCode, requests, rowsWritten: pass.rowsWritten,
    moreWorkRemains: summary.moreWorkRemains, continuesAutomatically: summary.continuesAutomatically, regenerationPending, auditFailed,
  };
}

export type { RecoveryRefusalCode };

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * Production deps over the caller's client (fm_system from the route). Chain
 * modules are imported lazily so the decisions above stay testable offline.
 */
export function productionWalletHistoryRecoveryDeps(client: PrismaClient, env: Record<string, string | undefined> = process.env): WalletHistoryRecoveryDeps {
  return {
    now: Date.now,
    workerEnabled: (chain) => historyWorkerEnabledFor(chain, env),
    async loadTarget(connectionId) {
      const c = await client.connection.findUnique({
        where: { id: connectionId },
        select: {
          id: true, provider: true, status: true, cursor: true, syncLockedAt: true,
          accountConnections: { where: { deletedAt: null }, select: { financialAccountId: true,
            financialAccount: { select: { walletChain: true, walletAddress: true, deletedAt: true } } } },
        },
      });
      if (!c) return null;
      const live = c.accountConnections.filter((l) => !l.financialAccount.deletedAt && l.financialAccount.walletAddress);
      const accountIds = [...new Set(live.map((l) => l.financialAccountId))];
      const chain = accountIds.length === 1 ? normalizeChain(live[0].financialAccount.walletChain) : null;
      const { readHistoryCheckpoint, btcHistoryLink } = await import("@/lib/crypto/btc-history-checkpoint");
      const historyCheckpoint = c.provider === "WALLET" ? await readHistoryCheckpoint(client, c.id) : null;
      let historyLinkConnectionId: string | null = null;
      if (accountIds.length === 1 && chain === "SOL") {
        // The link prismaSolBackfillStore binds: canonical first, then oldest.
        const l = await client.accountConnection.findFirst({
          where: { financialAccountId: accountIds[0], connectionId: { not: null }, deletedAt: null },
          orderBy: [{ isCanonical: "desc" }, { createdAt: "asc" }], select: { connectionId: true },
        });
        historyLinkConnectionId = l?.connectionId ?? null;
      } else if (accountIds.length === 1 && (chain === "BTC" || chain === "ETH")) {
        historyLinkConnectionId = (await btcHistoryLink(client, accountIds[0]))?.connectionId ?? null;
      }
      return {
        connectionId: c.id, provider: c.provider, status: c.status, accountIds, chain, historyLinkConnectionId,
        cursor: c.cursor, historyCheckpoint, lockedAt: c.syncLockedAt,
      };
    },
    async admit() {
      const { admitOperationalWork } = await import("@/lib/platform/admission/facts");
      const v = await admitOperationalWork({ work: "REFRESH_EXECUTION" });
      return v.decision === "DENY"
        ? { admitted: false as const, reason: String(v.reason), label: v.label ?? "Platform work is paused; history recovery cannot begin now." }
        : { admitted: true as const };
    },
    limits: (chain) => limitsFor(chain, env),
    probeBudgetFor,
    async providerUsageToday(chain, dayISO) {
      const { providerCallsOn, ALCHEMY_USAGE_PROVIDER } = await import("@/lib/usage/provider-budget");
      const { ESPLORA_USAGE_PROVIDER } = await import("@/lib/crypto/btc-backfill-worker.core");
      return providerCallsOn(client, chain === "BTC" ? ESPLORA_USAGE_PROVIDER : ALCHEMY_USAGE_PROVIDER, dayISO);
    },
    async claimLock(connectionId, stampMs) {
      const stale = new Date(stampMs - RECOVERY_LOCK_TTL_MS);
      const r = await client.connection.updateMany({
        where: { id: connectionId, OR: [{ syncLockedAt: null }, { syncLockedAt: { lte: stale } }] },
        data: { syncLockedAt: new Date(stampMs) },
      });
      return r.count === 1;
    },
    async releaseLock(connectionId, stampMs) {
      // Only while still ours — a sync that took over a stale claim is never unlocked.
      try { await client.connection.updateMany({ where: { id: connectionId, syncLockedAt: new Date(stampMs) }, data: { syncLockedAt: null } }); }
      catch (e) { console.error("[wallet-history-recovery] lock release failed:", e instanceof Error ? e.message : String(e)); }
    },
    runPass: (args) => runChainPass(client, env, args),
    async recordUsage(chain, meter) {
      const { recordProviderMeter, ALCHEMY_USAGE_PROVIDER, ALCHEMY_USAGE_NETWORK } = await import("@/lib/usage/provider-budget");
      const { ESPLORA_USAGE_PROVIDER, ESPLORA_USAGE_NETWORK } = await import("@/lib/crypto/btc-backfill-worker.core");
      try {
        if (chain === "BTC") await recordProviderMeter(ESPLORA_USAGE_PROVIDER, ESPLORA_USAGE_NETWORK, meter);
        else await recordProviderMeter(ALCHEMY_USAGE_PROVIDER, chain === "SOL" ? ALCHEMY_USAGE_NETWORK.SOLANA : ALCHEMY_USAGE_NETWORK.ETHEREUM, meter);
      } catch { /* metering never fails a pass */ }
    },
    async markRegenerationPending(chain, accountId, fromISO) {
      const job = await import("@/jobs/sol-history-backfill");
      const earlier = (cur: string | null | undefined) => (cur && cur < fromISO ? cur : fromISO);
      if (chain === "SOL") {
        const { prismaSolBackfillStore } = await import("@/lib/crypto/sol-history-backfill.store");
        const b = await prismaSolBackfillStore(accountId, client);
        return b ? job.setPending(b.store, accountId, b.address, (cp) => ({ ...cp, snapshotPendingFromISO: earlier(cp.snapshotPendingFromISO) })) : false;
      }
      if (chain === "BTC") {
        const { prismaBtcBackfillStore } = await import("@/lib/crypto/btc-history-backfill.store");
        const b = await prismaBtcBackfillStore(accountId, client);
        return b ? job.setBtcPending(b.store, accountId, (cp) => ({ ...cp, snapshotPendingFromISO: earlier(cp.snapshotPendingFromISO) })) : false;
      }
      const { prismaEthBackfillStore } = await import("@/lib/crypto/eth-history-backfill.store");
      const b = await prismaEthBackfillStore(accountId, client);
      return b ? job.setEthPending(b.store, accountId, (cp) => ({ ...cp, snapshotPendingFromISO: earlier(cp.snapshotPendingFromISO) })) : false;
    },
    async audit(entry) {
      const { recordOperatorAction } = await import("@/lib/audit");
      await recordOperatorAction(client, entry);
    },
  };
}

/** The worker's own limits for the chain: the shared daily cap (and ETH's step probe budget). */
export function limitsFor(chain: ResumableChain, env: Record<string, string | undefined> = process.env): PassLimits {
  // Per pass: the worker's own per-wallet share of a run — its wallet budget at its request rate.
  const share = (walletBudgetMs: number, rps: number) => Math.ceil((walletBudgetMs / 1000) * rps);
  if (chain === "BTC") {
    const btc = btcWorkerConfig(env);
    return { dailyRequestCap: btc.dailyRequestCap, perPassRequestCap: share(btc.walletBudgetMs, btc.maxRequestsPerSecond) };
  }
  // ETH spends the SAME Alchemy key as Solana, so the SAME cap (jobs/sol-history-backfill.ts).
  const sol = workerConfig(env);
  const base = { dailyRequestCap: sol.dailyRequestCap, perPassRequestCap: share(sol.walletBudgetMs, sol.maxRequestsPerSecond) };
  return chain === "ETH" ? { ...base, probeBudget: ethWorkerConfig(env).probeBudget } : base;
}

/** One bounded pass on the chain's runner with `resume: true`, bound to THIS connection. */
async function runChainPass(
  client: PrismaClient, env: Record<string, string | undefined>,
  args: { chain: ResumableChain; accountId: string; connectionId: string; budget: PassBudget; meter: Record<string, number>; deadlineMs: number },
): Promise<PassResult | "UNBOUND"> {
  const { chain, accountId, connectionId, budget, meter } = args;
  const now = Date.now;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const budgetMs = Math.max(1_000, args.deadlineMs - now());
  if (chain === "SOL") {
    const { prismaSolBackfillStore } = await import("@/lib/crypto/sol-history-backfill.store");
    const { runSolHistoryBackfill } = await import("@/lib/crypto/sol-history-backfill");
    const bound = await prismaSolBackfillStore(accountId, client);
    if (!bound || bound.connectionId !== connectionId) return "UNBOUND";
    const cfg = workerConfig(env);
    const o = await runSolHistoryBackfill({ accountId, address: bound.address, store: bound.store, resume: true }, {
      budgetMs: Math.min(budgetMs, cfg.walletBudgetMs), concurrency: cfg.concurrency, now, sleep,
      beforeRequest: createRateLimiter(cfg.maxRequestsPerSecond, now, sleep), meter, requestBudget: budget.requestBudget,
    });
    return { stoppedBecause: o.stoppedBecause, rowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO, failureCode: o.failure?.code ?? null };
  }
  if (chain === "BTC") {
    const { prismaBtcBackfillStore } = await import("@/lib/crypto/btc-history-backfill.store");
    const { runBtcHistoryBackfill } = await import("@/lib/crypto/btc-history-backfill");
    const bound = await prismaBtcBackfillStore(accountId, client);
    if (!bound || bound.connectionId !== connectionId) return "UNBOUND";
    const cfg = btcWorkerConfig(env);
    const o = await runBtcHistoryBackfill({ accountId, store: bound.store, resume: true }, {
      budgetMs: Math.min(budgetMs, cfg.walletBudgetMs), now, sleep,
      beforeRequest: createRateLimiter(cfg.maxRequestsPerSecond, now, sleep), meter, requestBudget: budget.requestBudget,
    });
    return { stoppedBecause: o.stoppedBecause, rowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO, failureCode: o.failure?.code ?? null };
  }
  const { prismaEthBackfillStore } = await import("@/lib/crypto/eth-history-backfill.store");
  const { runEthHistoryBackfill } = await import("@/lib/crypto/eth-history-backfill");
  const bound = await prismaEthBackfillStore(accountId, client);
  if (!bound || bound.connectionId !== connectionId) return "UNBOUND";
  const o = await runEthHistoryBackfill({ accountId, store: bound.store, todayISO: new Date(now()).toISOString().slice(0, 10), resume: true }, {
    probeBudget: budget.probeBudget, now, deadlineMs: args.deadlineMs, eth: { meter },
  });
  return { stoppedBecause: o.stoppedBecause, rowsWritten: o.rowsWritten, impactedFromISO: o.impactedFromISO, failureCode: o.failure?.code ?? null };
}
