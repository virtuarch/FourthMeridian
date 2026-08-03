/**
 * jobs/sync-crypto.ts
 *
 * BTC wallet balance sync — the scheduled batch job body (CH-3).
 *
 * Delegates to lib/crypto/btc-sync.ts#syncAllBtcWallets(): refreshes the
 * confirmed on-chain balance + USD value of every active BTC wallet, then
 * regenerates each synced wallet's 30-day wealth HISTORY so the CoinGecko-driven
 * per-day BTC valuation (a05ffbd) runs on the scheduled path too.
 *
 * REGISTERED (CH-3, 2026-07-14): lib/jobs/registry.ts fires this every 6 hours
 * (00/06/12/18 UTC) via the dispatcher, unlocked by the Vercel plan upgrade off
 * the Hobby tier (sub-daily cron now permitted). Idempotent and safe to re-run —
 * syncBtcWallet dedupes transactions and never throws; a failed wallet is
 * counted, not fatal.
 *
 * WEALTH-HISTORY REGEN (the step 965e0bd anticipated for this path): the two
 * wallet ROUTES already run regenerateWealthHistoryForAccounts alongside their
 * flat snapshot regen, but 965e0bd wired it at the route level, NOT inside
 * syncBtcWallet/syncAllBtcWallets — so this cron, which calls syncAllBtcWallets
 * directly, would otherwise get no history regen. We add it here, at the job
 * body (the cron's equivalent of "route level"), keeping the balance-sync layer
 * free of snapshot coupling exactly as that commit decided.
 *
 * ONE DELIBERATE DIVERGENCE FROM THE ROUTES: the routes call regen
 * unconditionally (one account, on user action); this bulk path runs across
 * EVERY space with a synced wallet, four times a day. A 30-day per-space
 * walk-back that writes nothing when WEALTH_REGENERATION_ENABLED is off is pure
 * waste at that fan-out (it still does the BTC price backfill + full day
 * computation before discarding the writes), so we gate the regen on the flag
 * here. When the flag is on, behavior matches the routes.
 */

import { syncAllBtcWallets, type BtcSyncDeps, type SyncAllBtcWalletsResult } from "@/lib/crypto/btc-sync";
import {
  regenerateWealthHistoryForAccounts,
  wealthRegenerationEnabled,
} from "@/lib/snapshots/regenerate-history";
import { resolveHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window";
import { reconcileProviderCapability, type CapabilityWideningPlan } from "@/lib/prices/capability-reconciliation";
import { BTC_PRICE_SOURCE } from "@/lib/crypto/btc-price";

export interface SyncCryptoResult extends SyncAllBtcWalletsResult {
  /** Spaces whose wealth history was regenerated this run (empty when the flag is off). */
  wealthRegenSpaces: number;
}

export async function syncCrypto(deps?: BtcSyncDeps): Promise<SyncCryptoResult> {
  // V26-ORCH-1 — stamped BEFORE the sync so every row the sync writes falls at or
  // after it. This is what makes the refresh genuinely INCREMENTAL rather than a
  // guess: the planner asks which transactions and prices were written from this
  // instant onward and takes their earliest DATE as `impactedFrom`. A quiet
  // sweep measures "nothing changed" and rebuilds only the recent interval; a
  // sweep that discovers a two-year-old movement rebuilds from that movement.
  const runStartedAt = new Date();

  // V26-CAP-1 — reconcile the price provider's DECLARED capability once a day,
  // here, before the sweep. Cheapest reliable place in this repository: already
  // scheduled, already fans out over exactly the accounts a crypto capability
  // change affects, and not a request path. One indexed read plus one insert;
  // it plans work ONLY when the declaration actually widened.
  //
  // It reports a plan and nothing more — no acquisition, no regeneration, no
  // snapshot write. A wider declaration expands what may be ATTEMPTED; support
  // still moves only when a regeneration succeeds.
  let capabilityWidening: CapabilityWideningPlan | null = null;
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

  const result = await syncAllBtcWallets(deps);

  // Regenerate the wealth history of every space touched by a successful sync —
  // mirrors the route-level wiring (965e0bd), gated on the flag for the bulk
  // fan-out (see header). Best-effort/non-fatal: regen failures must never fail
  // the sweep or its JobRun.
  //
  // This used a FIXED 30-DAY window, which capped every wallet's history at one
  // month no matter how much the provider could serve.
  let wealthRegenSpaces = 0;
  if (wealthRegenerationEnabled() && result.syncedAccountIds.length > 0) {
    try {
      // A capability widening supersedes the ordinary incremental window: the
      // newly reachable dates have no stored prices yet, so a measurement-based
      // window would not reach them.
      const plan = capabilityWidening?.window
        ?? await resolveHistoricalWorkWindow({
          financialAccountIds: result.syncedAccountIds,
          changedSince:        runStartedAt,
        });
      console.log(
        `[sync-crypto] historical window ${plan.fromDate}..${plan.toDate} (${plan.mode}) — ${plan.reasons.join("; ")}`,
      );
      const spaces = await regenerateWealthHistoryForAccounts(
        result.syncedAccountIds, { fromDate: plan.fromDate, toDate: plan.toDate },
      );
      wealthRegenSpaces = spaces.length;
    } catch (err) {
      console.warn("[sync-crypto] wealth-history regen failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  return { ...result, wealthRegenSpaces };
}
