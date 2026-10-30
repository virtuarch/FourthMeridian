/**
 * lib/crypto/erc20-history-pass.ts
 *
 * The ERC-20 history worker pass: one bounded step (erc20-history.ts) per
 * Ethereum wallet that owes token-history work, inside the history worker job
 * (jobs/sol-history-backfill.ts calls `runErc20HistoryPass` after its Ethereum
 * native pass — one isolated call; nothing else in the job changes).
 *
 *   order      wallets owing a snapshot regeneration first, then never-scanned
 *              wallets, then least recently progressed
 *   lock       the wallet's sync lock (the job's claim / release), as every pass
 *   budget     the SHARED Alchemy cap: the ledger re-read now (every network, so
 *              the passes before this one are in it), never less than the token
 *              sections' own recorded calls; each step gets the lower of its own
 *              bound and what is left. An unreadable ledger spends nothing.
 *   prices     verified priced tokens' historical closes (CoinGecko, its own
 *              guarded budget) through the injected acquisition, bounded per run
 *   snapshots  rows changed ⇒ regenerate from the earliest changed day through
 *              the job's regenerateUnderLock (the existing machinery — no new
 *              snapshot writer); deferred ⇒ the section's snapshotPendingFromISO
 *              marker keeps it owed, and the next run regenerates it first.
 *
 * No Prisma, no DB: every effect is a dependency (production wiring in
 * erc20-history.store.ts).
 */

import type { LedgerCalls } from "@/lib/usage/provider-budget.core";
import { meterTotal } from "@/lib/usage/provider-budget.core";
import {
  readErc20Section, erc20WorkOwed, sectionUsageOn,
  type Erc20HistoryConfig, type Erc20HistorySection,
} from "./erc20-history.core";
import type { Erc20HistoryOutcome, Erc20HistoryStepDeps } from "./erc20-history";

/** An ETH wallet account on its history link; `cursor` is `Connection.historyCheckpoint`. */
export interface Erc20HistoryWallet { accountId: string; connectionId: string; cursor: string | null }

export interface Erc20HistoryPassDeps {
  wallets(): Promise<Erc20HistoryWallet[]>;
  step(args: { accountId: string; todayISO: string; deps: Erc20HistoryStepDeps }): Promise<Erc20HistoryOutcome>;
  /** CAS the section's regeneration marker. False ⇒ not written (re-derived next run). */
  setPending(accountId: string, mutate: (s: Erc20HistorySection) => Erc20HistorySection): Promise<boolean>;
  /** Record `meter` beyond `flushed` on the ledger under ALCHEMY/ethereum; advances `flushed`. */
  recordUsage?(meter: Readonly<Record<string, number>>, flushed: Record<string, number>): Promise<void>;
  /**
   * Historical closes for this wallet's verified token instruments, through the
   * one token price path (erc20-history-prices.ts → lib/prices/token-history-prices.ts).
   * Returns the earliest day a close was inserted.
   */
  acquirePrices?(args: { accountId: string; instrumentIds: string[]; maxTokens: number }): Promise<{ calls: number; inserted: number; tokensFetched: number; earliestInsertedISO: string | null }>;
}

/** What the job lends the pass (its clock, locks, ledger and regeneration). */
export interface Erc20HistoryPassContext {
  jobDeadline: number;
  day: string;
  dailyRequestCap: number;
  now: () => number;
  claimLock(connectionId: string, stampMs: number): Promise<boolean>;
  releaseLock(connectionId: string, stampMs: number): Promise<void>;
  providerUsageToday?(dayISO: string): Promise<LedgerCalls | null>;
  regenerateUnderLock(w: { accountId: string; connectionId: string }, fromISO: string, lockStamp: number, withPriceGaps?: boolean): Promise<{ outcome: "DONE" | "DEFERRED"; stamp: number }>;
}

export interface Erc20HistoryPassSummary {
  enabled: boolean;
  eligible: number;
  walletsRun: number;
  walletsSkippedLocked: number;
  tokensVerified: number;
  tokensUnsupported: Record<string, number>;
  failures: Record<string, number>;
  regenerated: number;
  regenerationsDeferred: number;
  prices: { tokensFetched: number; inserted: number; calls: number };
  requests: { total: number };
  dailyRequestsUsedBefore: number;
  dailyRequestCap: number;
  stoppedBecause: "DISABLED" | "NO_WORK" | "JOB_BUDGET" | "DAILY_CAP" | "BUDGET_UNKNOWN" | "ALL_RUN";
  deferred: number;
}

type Parsed = Erc20HistoryWallet & { section: Erc20HistorySection | null };
export interface Erc20HistoryPlan { work: Array<{ w: Parsed; kind: "PENDING" | "STEP" }>; parsed: Parsed[]; summary: Erc20HistoryPassSummary }

function emptySummary(enabled: boolean): Erc20HistoryPassSummary {
  return {
    enabled, eligible: 0, walletsRun: 0, walletsSkippedLocked: 0, tokensVerified: 0, tokensUnsupported: {}, failures: {},
    regenerated: 0, regenerationsDeferred: 0, prices: { tokensFetched: 0, inserted: 0, calls: 0 }, requests: { total: 0 },
    dailyRequestsUsedBefore: 0, dailyRequestCap: 0, stoppedBecause: enabled ? "ALL_RUN" : "DISABLED", deferred: 0,
  };
}

/** Who has work, in order. A listing failure is "no work this run" — it never takes the job down. */
export async function planErc20History(deps: Erc20HistoryPassDeps, cfg: Pick<Erc20HistoryConfig, "enabled">, todayISO: string): Promise<Erc20HistoryPlan> {
  if (!cfg.enabled) return { work: [], parsed: [], summary: emptySummary(false) };
  let listed: Erc20HistoryWallet[] = [];
  try { listed = await deps.wallets(); }
  catch (e) { console.warn("[erc20-history] wallet listing failed (non-fatal — token history skipped this run):", e instanceof Error ? e.message : String(e)); }
  const parsed: Parsed[] = [];
  for (const w of listed) {
    const r = readErc20Section(w.cursor, w.accountId);
    if (r.host === "FOREIGN") continue; // never ours to write
    parsed.push({ ...w, section: r.section });
  }
  const pending = parsed.filter((w) => w.section?.snapshotPendingFromISO);
  const steps = parsed
    .filter((w) => erc20WorkOwed(w.section, todayISO))
    .sort((a, b) => (a.section ? 1 : 0) - (b.section ? 1 : 0)
      || (a.section?.lastProgressAtISO ?? "").localeCompare(b.section?.lastProgressAtISO ?? "") || a.accountId.localeCompare(b.accountId));
  const work = [
    ...pending.map((w) => ({ w, kind: "PENDING" as const })),
    ...steps.filter((s) => !pending.some((p) => p.accountId === s.accountId)).map((w) => ({ w, kind: "STEP" as const })),
  ];
  const summary = emptySummary(true);
  summary.eligible = steps.length;
  if (work.length === 0) summary.stoppedBecause = "NO_WORK";
  return { work, parsed, summary };
}

const minISO = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);

export async function runErc20HistoryPass(
  plan: Erc20HistoryPlan, deps: Erc20HistoryPassDeps, cfg: Erc20HistoryConfig, ctx: Erc20HistoryPassContext,
): Promise<Erc20HistoryPassSummary> {
  const summary: Erc20HistoryPassSummary = { ...plan.summary, dailyRequestCap: ctx.dailyRequestCap };
  if (!cfg.enabled || plan.work.length === 0) return summary;
  const meter: Record<string, number> = {};
  const flushed: Record<string, number> = {};
  const flushUsage = async () => { if (deps.recordUsage) { try { await deps.recordUsage(meter, flushed); } catch { /* metering never fails a run */ } } };

  // The shared cap, read NOW. Unreadable is not "plenty": only regenerations run.
  const ledger = ctx.providerUsageToday ? await ctx.providerUsageToday(ctx.day).catch(() => null) : null;
  const sectionCalls = plan.parsed.reduce((a, w) => a + sectionUsageOn(w.section, ctx.day), 0);
  const budgetKnown = ledger !== null;
  summary.dailyRequestsUsedBefore = ledger ? ledger.solana + ledger.other + Math.max(0, sectionCalls - ledger.other) : sectionCalls;
  let priceTokensLeft = cfg.maxPriceTokensPerRun;

  for (let i = 0; i < plan.work.length; i++) {
    const { w, kind } = plan.work[i];
    const left = ctx.jobDeadline - ctx.now();
    if (left < Math.max(cfg.startReserveMs, 2_000)) { summary.stoppedBecause = "JOB_BUDGET"; summary.deferred += plan.work.length - i; break; }
    const allowance = budgetKnown ? ctx.dailyRequestCap - summary.dailyRequestsUsedBefore - meterTotal(meter) : 0;
    const requestBudget = Math.min(cfg.stepRequestBudget, allowance);
    if (kind === "STEP" && requestBudget <= 0) { summary.stoppedBecause = budgetKnown ? "DAILY_CAP" : "BUDGET_UNKNOWN"; break; } // resumes on cadence
    let stamp = ctx.now();
    if (!(await ctx.claimLock(w.connectionId, stamp))) { summary.walletsSkippedLocked++; summary.deferred++; continue; }
    try {
      let fromISO = w.section?.snapshotPendingFromISO ?? null;
      // A PENDING wallet with budget still steps (its regeneration is first; its step is cheap when nothing is owed).
      if (requestBudget > 0 && erc20WorkOwed(w.section, ctx.day)) {
        const o = await deps.step({ accountId: w.accountId, todayISO: ctx.day, deps: {
          config: cfg, requestBudget, now: ctx.now, eth: { meter },
          deadlineMs: ctx.now() + Math.max(1_000, left - 30_000),
        } });
        summary.walletsRun++;
        await flushUsage();
        summary.tokensVerified += o.verified.length;
        for (const u of o.unsupported) summary.tokensUnsupported[u.reason] = (summary.tokensUnsupported[u.reason] ?? 0) + 1;
        if (o.failure) summary.failures[o.failure.code] = (summary.failures[o.failure.code] ?? 0) + 1;
        if (o.stoppedBecause === "BUDGET" || o.stoppedBecause === "CONFLICT" || (o.pending > 0 && !o.failure)) summary.deferred++;
        fromISO = minISO(fromISO, o.impactedFromISO);
        // Historical prices for this wallet's verified tokens (their own CoinGecko budget).
        if (deps.acquirePrices && priceTokensLeft > 0 && o.verifiedInstrumentIds.length > 0) {
          try {
            const p = await deps.acquirePrices({ accountId: w.accountId, instrumentIds: o.verifiedInstrumentIds, maxTokens: priceTokensLeft });
            priceTokensLeft -= p.tokensFetched;
            summary.prices.tokensFetched += p.tokensFetched; summary.prices.inserted += p.inserted; summary.prices.calls += p.calls;
            fromISO = minISO(fromISO, p.earliestInsertedISO);
          } catch (e) {
            console.warn("[erc20-history] historical token prices failed (non-fatal):", e instanceof Error ? e.message : String(e));
          }
        }
      }
      if (fromISO) {
        const regen = await ctx.regenerateUnderLock(w, fromISO, stamp, false); // no SOL price-gap pass for an ETH wallet
        stamp = regen.stamp; // release below checks ownership against the stamp in force
        if (regen.outcome === "DONE") {
          summary.regenerated++;
          await deps.setPending(w.accountId, (s) => ({ ...s, snapshotPendingFromISO: null })).catch(() => false);
        } else {
          summary.regenerationsDeferred++;
          summary.deferred++;
          await deps.setPending(w.accountId, (s) => ({ ...s, snapshotPendingFromISO: minISO(s.snapshotPendingFromISO, fromISO) })).catch(() => false);
        }
      }
    } finally {
      await ctx.releaseLock(w.connectionId, stamp);
    }
  }
  await flushUsage();
  summary.requests = { total: meterTotal(meter) };
  return summary;
}
