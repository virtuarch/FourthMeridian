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
}

export async function syncCrypto(options: {
  continuation?: boolean;
  /** Test seam for the sweep; production passes nothing. */
  refresh?: Partial<WalletRefreshDeps>;
} = {}): Promise<SyncCryptoResult> {
  const continuation = options.continuation === true;
  // V26-ORCH-1 — stamped BEFORE the sweep so every row it writes falls at or
  // after it: the planner measures what changed from this instant onward.
  const runStartedAt = new Date();

  let capabilityWidening: CapabilityWideningPlan | null = null;
  if (!continuation) {
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
  if (!continuation) {
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
      const historyAccountIds = chains.filter((a) => chainSupportsHistory(a.walletChain)).map((a) => a.id);
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
      }
    }
  }

  return { ...result, continuation, snapshotSpaces, wealthRegenSpaces, closeCoverage };
}
