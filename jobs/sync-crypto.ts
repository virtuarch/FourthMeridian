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
  recentWealthWindow,
  wealthRegenerationEnabled,
} from "@/lib/snapshots/regenerate-history";

export interface SyncCryptoResult extends SyncAllBtcWalletsResult {
  /** Spaces whose wealth history was regenerated this run (empty when the flag is off). */
  wealthRegenSpaces: number;
}

export async function syncCrypto(deps?: BtcSyncDeps): Promise<SyncCryptoResult> {
  const result = await syncAllBtcWallets(deps);

  // Regenerate the 30-day wealth history of every space touched by a successful
  // sync — mirrors the route-level wiring (965e0bd), gated on the flag for the
  // bulk fan-out (see header). Best-effort/non-fatal: regen failures must never
  // fail the sweep or its JobRun.
  let wealthRegenSpaces = 0;
  if (wealthRegenerationEnabled() && result.syncedAccountIds.length > 0) {
    try {
      const spaces = await regenerateWealthHistoryForAccounts(result.syncedAccountIds, recentWealthWindow());
      wealthRegenSpaces = spaces.length;
    } catch (err) {
      console.warn("[sync-crypto] wealth-history regen failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  return { ...result, wealthRegenSpaces };
}
