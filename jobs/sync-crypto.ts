/**
 * jobs/sync-crypto.ts
 *
 * The scheduled wallet refresh — EVERY syncable wallet, not Bitcoin only.
 *
 * REGISTERED in lib/jobs/registry.ts at 00/06/12/18 UTC (`sync-crypto`), with a
 * `sync-crypto-continuation` run at :30 of the same hours for any wallet the
 * first run's work budget deferred. The expected WALLET cadence is policy
 * (lib/platform/refresh-policy.core.ts, default 6h); the sweep skips wallets not
 * yet due under it, so a slower policy is honoured and a continuation run with
 * nothing deferred is one query.
 *
 * THE SYNC ITSELF is lib/crypto/wallet-refresh.ts → `syncWalletByChain`, the same
 * call POST /api/accounts/[id]/sync makes. Balances, positions, success clocks,
 * refusal recording and the W6f history refresh are therefore identical for a
 * scheduled and a manual refresh of the same wallet.
 *
 * AFTER THE SWEEP, mirroring the manual route for the wallets that synced:
 *   · the flat snapshot is regenerated (Overview / Wealth read it);
 *   · wealth HISTORY is regenerated for HISTORY_SUPPORTED chains only, through
 *     the canonical planner. Gated on WEALTH_REGENERATION_ENABLED here because
 *     this is a fleet fan-out (the manual route is one account).
 * Both best-effort: a regeneration failure never fails the sweep or its JobRun.
 *
 * PRICE GAPS (2026-10-28) run just AFTER that history regeneration: where the
 * shared RAW_CLOSE archive does not reach back as far as a synced wallet's
 * licensed balance history and the provider can serve the older dates, one
 * bounded acquisition per INSTRUMENT (lib/prices/price-gap.ts); then only the
 * holders whose evidence changed are revalued over their Spaces' existing rows
 * too, bounded per run and by the wake (revalueHoldersAfterPriceGaps).
 * Deferred holders stay owed on disk.
 *
 * CAPABILITY RECONCILIATION (V26-CAP-1) runs on the main slot only, before the
 * sweep: a declared widening of the price provider's reach is noticed where the
 * affected accounts are already being fanned out over.
 *
 * CLOSE-ARCHIVE MAINTENANCE (CRYPTO-LATCH-1) also runs on the main slot, also
 * before the sweep, and for a stronger reason than convenience: the RAW_CLOSE
 * archive is a PREREQUISITE of crypto valuation, and making it a consequence of
 * valuation instead is what latched Bitcoin unpriced for four days in the
 * 2026-10-01 incident. Maintained for HELD assets only, bounded to the
 * valuation's own walk-back window, idempotent, and never fatal.
 *
 * Idempotent and safe to re-run: each adapter dedupes and never throws, and a
 * failed wallet is counted, not fatal.
 */

import { refreshScheduledWallets, type WalletRefreshDeps, type WalletRefreshResult } from "@/lib/crypto/wallet-refresh";
import { chainSupportsHistory } from "@/lib/crypto/wallet-sync-dispatch";
import { activeWalletAccountIdsForChains } from "@/lib/crypto/wallet-snapshot-scope";
import {
  regenerateWealthHistoryForAccounts,
  wealthRegenerationEnabled,
} from "@/lib/snapshots/regenerate-history";
import { regenerateSnapshotsForAccounts } from "@/lib/snapshots/regenerate";
import {
  maintainHeldCryptoCloseCoverage, coverageCanValue, type CryptoCloseCoverage,
} from "@/lib/crypto/crypto-close-coverage";
import { todayUTCISO } from "@/lib/time/clock";
import { resolveHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window";
import { reconcileProviderCapability, type CapabilityWideningPlan } from "@/lib/prices/capability-reconciliation";
import { BTC_PRICE_SOURCE } from "@/lib/crypto/btc-price";
import type { RevaluationRun } from "@/lib/prices/price-gap";
import { WAKE_SAFE_MS, revaluationAbandonedReason } from "@/jobs/sol-history-backfill";
import { readGlobalCostFreeze, type GlobalCostFreezeReader } from "@/lib/platform/cost-freeze";
import { billableSkipCode, type BillableSkipCode } from "@/lib/entitlements/billable-gate-core";

export interface SyncCryptoResult extends WalletRefreshResult {
  continuation: boolean;
  /** Spaces whose flat snapshot was regenerated this run. */
  snapshotSpaces: number;
  /** Spaces whose wealth history was regenerated this run (0 when the flag is off). */
  wealthRegenSpaces: number;
  /**
   * CRYPTO-LATCH-1 — per-asset RAW_CLOSE archive maintenance performed BEFORE
   * the sweep. Empty on a continuation run (the main slot owns it).
   */
  closeCoverage: CryptoCloseCoverage[];
  /** Price-gap fill + bounded revaluation after the history regeneration (counts only; null when it did not run). */
  revaluation: {
    gapInstruments: number; gapRowsInserted: number; owed: number; revalued: number; chunksRebuilt: number;
    deferred: number; alreadyRevalued: number; abandonedBlocks: number; rowsStampedUnavailable: number; failures: number; skippedForTime: boolean;
  } | null;
  /**
   * BETA LIFECYCLE L2 — set when the GLOBAL cost freeze (or an unreadable flag)
   * stopped the platform-wide vendor steps: the CoinGecko capability probe and
   * the held-asset close-archive maintenance. Recorded as SKIPPED with the
   * billable skip code; no archive row, cursor or capability state moves.
   * (Per-wallet work is refused by the billable gate inside the sweep.)
   */
  platformSkipped?: { reason: BillableSkipCode; steps: string[] };
  /**
   * The job's own outcome (the worker's convention: JobRun.summary.outcome /
   * partialReasons). "SKIPPED" under the global cost freeze (BETA LIFECYCLE L2;
   * job health: `skipped`, not a success) — it wins; otherwise PARTIAL when
   * revaluation blocks were abandoned at the attempt cap (REVALUATION_ABANDONED,
   * their rows stamped unavailable), else COMPLETE.
   */
  outcome: "COMPLETE" | "PARTIAL" | "SKIPPED";
  partialReasons: string[];
  skipReason?: BillableSkipCode;
}

function revaluationSummary(r: RevaluationRun | null): SyncCryptoResult["revaluation"] {
  return r ? { gapInstruments: r.priceGaps?.acquired ?? 0, gapRowsInserted: r.priceGaps?.inserted ?? 0, owed: r.owed,
    revalued: r.revalued, chunksRebuilt: r.chunksRebuilt, deferred: r.deferred, alreadyRevalued: r.alreadyRevalued,
    abandonedBlocks: r.abandonedBlocks, rowsStampedUnavailable: r.rowsStampedUnavailable, failures: r.failures, skippedForTime: r.skippedForTime } : null;
}

/** PARTIAL when a revaluation abandoned blocks (never silent: the rows say unavailable, the run says why). */
export function syncCryptoOutcome(r: RevaluationRun | null): { outcome: "COMPLETE" | "PARTIAL"; partialReasons: string[] } {
  const reasons = r && r.abandonedBlocks > 0 ? [revaluationAbandonedReason(r.abandonedBlocks, r.rowsStampedUnavailable)] : [];
  return { outcome: reasons.length > 0 ? "PARTIAL" : "COMPLETE", partialReasons: reasons };
}

export async function syncCrypto(options: {
  continuation?: boolean;
  /** Test seam for the sweep; production passes nothing. */
  refresh?: Partial<WalletRefreshDeps>;
  /** Test seam: the global cost-freeze read (production: the uncached PlatformSetting read). */
  costFreeze?: GlobalCostFreezeReader;
} = {}): Promise<SyncCryptoResult> {
  const continuation = options.continuation === true;
  // V26-ORCH-1 — stamped BEFORE the sweep so every row it writes falls at or
  // after it: the planner measures what changed from this instant onward.
  const runStartedAt = new Date();

  // ── BETA LIFECYCLE L2 — THE GLOBAL COST FREEZE, BEFORE ANY PLATFORM VENDOR CALL ──
  // The capability probe and the close-archive maintenance bill no single
  // customer (CoinGecko, per instrument). Under a global freeze — or a flag
  // that cannot be read — they do not start. Cached archive rows stay readable.
  const freeze = continuation ? null : await (options.costFreeze ?? readGlobalCostFreeze)();
  const platformFrozen = freeze?.frozen === true;
  let platformSkipped: SyncCryptoResult["platformSkipped"];
  if (platformFrozen) {
    platformSkipped = { reason: billableSkipCode(freeze!.reason!), steps: ["capability-reconciliation", "close-archive-maintenance"] };
    console.log(`[sync-crypto] global cost freeze (${freeze!.state}) — platform price steps SKIPPED (${platformSkipped.reason}); nothing advanced`);
  }

  let capabilityWidening: CapabilityWideningPlan | null = null;
  if (!continuation && !platformFrozen) {
    try {
      const plan = await reconcileProviderCapability(BTC_PRICE_SOURCE, {
        secret: process.env.COINGECKO_API_KEY,
      });
      if (plan.observation.rejectedReason) {
        console.warn(`[sync-crypto] capability observation refused: ${plan.observation.rejectedReason}`);
      } else {
        console.log(`[sync-crypto] capability ${plan.observation.provider}: ${plan.observation.comparison}`);
      }
      if (plan.window) {
        capabilityWidening = plan;
        console.log(
          `[sync-crypto] capability WIDENED — newly available ` +
          `${plan.observation.newlyAvailable?.fromISO}..${plan.observation.newlyAvailable?.toISO}; ` +
          `planned ${plan.window.fromDate}..${plan.window.toDate} over ${plan.affectedAccountIds.length} account(s)`,
        );
      }
    } catch (err) {
      // Non-fatal by construction: a capability check must never fail the sweep.
      console.warn("[sync-crypto] capability reconciliation failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // ── CRYPTO-LATCH-1 — PRICE ARCHIVE MAINTENANCE, BEFORE THE SWEEP ──────────
  //
  // The RAW_CLOSE archive is a PREREQUISITE of crypto valuation, so it is
  // maintained here, on its own, ahead of any wallet read — not downstream of
  // one having succeeded.
  //
  // THE INCIDENT THIS CLOSES (2026-10-01): the only code that refreshed this
  // archive was `backfillHeldInstrumentPrices`, reached from the wealth-history
  // regeneration below, which is gated on `result.syncedAccountIds` — populated
  // only for runs `outcomeRevalued` accepts, which EXCLUDES an unpriced BTC run.
  // So a stale archive made BTC unpriced, and unpriced BTC skipped the only step
  // that could have refilled the archive. The sweep could not break its own
  // latch; on 2026-10-01 only a Solana wallet's success did, and a BTC-only
  // holder would have stayed unpriced indefinitely.
  //
  // Main slot only, like the capability check: the continuation exists to finish
  // deferred WALLET work, and re-walking the archive on it would double the
  // vendor cost for an archive the main slot has already mended this cycle.
  // Non-fatal by construction.
  let closeCoverage: CryptoCloseCoverage[] = [];
  if (!continuation && !platformFrozen) {
    try {
      closeCoverage = await maintainHeldCryptoCloseCoverage(todayUTCISO(runStartedAt));
      for (const c of closeCoverage) {
        const line =
          `[sync-crypto] close archive ${c.assetKey} ${c.status} ` +
          `(${c.fromISO}..${c.toISO}, newest ${c.closeDateISO ?? "none"}` +
          `${c.inserted > 0 ? `, +${c.inserted} row(s)` : ""})`;
        if (coverageCanValue(c)) console.log(line);
        else console.warn(`${line} — ${c.reason ?? "no reason given"}`);
      }
    } catch (err) {
      console.warn("[sync-crypto] close-archive maintenance failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  const result = await refreshScheduledWallets({ deps: options.refresh });
  console.log(
    `[sync-crypto]${continuation ? " (continuation)" : ""} ${result.attempted} attempted, ${result.succeeded} synced, ` +
    `${result.failed} failed, ${result.deferred} deferred, ${result.notDue} not due — ${result.elapsedMs} ms ` +
    `(policy ${result.policy.cadence}) ${JSON.stringify(result.byChain)}`,
  );

  let snapshotSpaces = 0;
  let revaluation: RevaluationRun | null = null;
  let wealthRegenSpaces = 0;
  // TODAY's snapshots follow new valuation evidence AND every changed quote: a
  // quote is shared, so every holder of a re-quoted asset is regenerated, not
  // only the wallets this sweep happened to sync.
  const quoteHolders = result.requotedChains.length > 0 ? await activeWalletAccountIdsForChains(result.requotedChains) : [];
  const snapshotAccountIds = [...new Set([...result.syncedAccountIds, ...quoteHolders])];
  if (snapshotAccountIds.length > 0) {
    try {
      snapshotSpaces = (await regenerateSnapshotsForAccounts(snapshotAccountIds)).length;
    } catch (err) {
      console.warn("[sync-crypto] snapshot regen failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
  if (result.syncedAccountIds.length > 0) {

    if (wealthRegenerationEnabled()) {
      // The manual route's gate: history exists to regenerate only where it has been proven.
      const { db } = await import("@/lib/db");
      const chains = await db.financialAccount.findMany({
        where:  { id: { in: result.syncedAccountIds } },
        select: { id: true, walletChain: true },
      });
      // BETA LIFECYCLE L2 — the rebuild reaches the price vendors (Tiingo /
      // CoinGecko history): re-asked per triggering account's billed owner, so
      // a freeze that landed during the sweep is honoured before the price step.
      const historyCandidates = chains.filter((a) => chainSupportsHistory(a.walletChain)).map((a) => a.id);
      // Owed holders' rows off `supported`/`none` first — refused/frozen owners
      // included (a DB status write; values preserved; the rebuild below is gated).
      if (historyCandidates.length > 0) {
        const { stampOwedHolders, prismaRevaluationDeps } = await import("@/lib/prices/price-gap");
        await stampOwedHolders(prismaRevaluationDeps(db), historyCandidates).catch(() => 0);
      }
      const { billableAccountIds } = await import("@/lib/platform/policies/billable-subjects");
      const historyAccountIds = historyCandidates.length > 0 ? (await billableAccountIds(historyCandidates, "price_history")).allowed : [];
      if (historyAccountIds.length > 0) {
        try {
          // A capability widening supersedes the ordinary incremental window: the
          // newly reachable dates have no stored prices yet, so a measured window
          // would not reach them.
          const plan = capabilityWidening?.window
            ?? await resolveHistoricalWorkWindow({
              financialAccountIds: historyAccountIds, changedSince: runStartedAt,
              // Reconstructed position history the sweep changed (ETH measures it).
              positionHistoryImpactedFromISO: result.historyImpactedFromISO,
            });
          console.log(`[sync-crypto] historical window ${plan.fromDate}..${plan.toDate} (${plan.mode}) — ${plan.reasons.join("; ")}`);
          wealthRegenSpaces = (await regenerateWealthHistoryForAccounts(
            historyAccountIds, { fromDate: plan.fromDate, toDate: plan.toDate },
          )).length;
        } catch (err) {
          console.warn("[sync-crypto] wealth-history regen failed (non-fatal):", err instanceof Error ? err.message : err);
        }
        // PRICE GAPS, AFTER the ordinary regeneration — so a gap fill (dated a
        // year back, created during this run) can never widen the measured
        // window above for every account in the sweep. Then ONLY the accounts
        // whose evidence state (licences, price floors, Space links) is not yet
        // revalued are rebuilt — over EVERY existing row of their Spaces, not
        // only the days before the earliest one (P1 2026-10-31) — in chunks, at
        // most DEFAULT_REVALUATION_MAX_ACCOUNTS and only while the wake has
        // time; the rest stay owed on disk and are taken by the next sweep.
        try {
          const { revalueHoldersAfterPriceGaps, prismaRevaluationDeps } = await import("@/lib/prices/price-gap");
          const log = (l: string) => console.log(`[sync-crypto] ${l}`);
          const wake = await db.jobRun.findFirst({ where: { startedAt: { gte: new Date(runStartedAt.getTime() - 300_000) } }, orderBy: { startedAt: "asc" }, select: { startedAt: true } });
          // BETA LIFECYCLE L2 — the revaluation itself is DB recompute (no vendor);
          // its price-gap fetch is a platform-wide CoinGecko call, so under the
          // GLOBAL cost freeze it is skipped (an empty gap run, nothing recorded)
          // while the recompute of already-held evidence still runs.
          const revalDeps = prismaRevaluationDeps(db, { log });
          if (platformFrozen) revalDeps.acquireGaps = async () => ({ decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null });
          revaluation = await revalueHoldersAfterPriceGaps({
            accountIds: historyAccountIds, deps: revalDeps, log,
            deadlineMs: (wake ? wake.startedAt.getTime() : runStartedAt.getTime()) + WAKE_SAFE_MS,
          });
          const g = revaluation.priceGaps;
          console.log(`[sync-crypto] price gaps: ${g?.acquired ?? 0} instrument(s), +${g?.inserted ?? 0} row(s); revaluation owed ${revaluation.owed}, ` +
            `revalued ${revaluation.revalued}, deferred ${revaluation.deferred}${revaluation.skippedForTime ? " (skipped: wake time)" : ""}`);
        } catch (err) {
          console.warn("[sync-crypto] price-gap revaluation failed (non-fatal):", err instanceof Error ? err.message : err);
        }
      }
    }
  }

  const outcome = syncCryptoOutcome(revaluation);
  if (outcome.outcome === "PARTIAL") console.warn(`[sync-crypto] PARTIAL — ${outcome.partialReasons.join(" | ")}`);
  return { ...result, continuation, snapshotSpaces, wealthRegenSpaces, closeCoverage, revaluation: revaluationSummary(revaluation), ...outcome,
    ...(platformSkipped ? { platformSkipped, outcome: "SKIPPED" as const, skipReason: platformSkipped.reason } : {}) };
}
