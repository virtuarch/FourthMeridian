/**
 * jobs/sync-crypto.ts
 *
 * BTC wallet balance sync v1 — batch job body.
 *
 * Delegates to lib/crypto/btc-sync.ts#syncAllBtcWallets(): refreshes the
 * confirmed on-chain balance + USD value of every active BTC wallet.
 *
 * NOT registered in lib/jobs/registry.ts. The daily dispatcher fires one shared
 * cron for ALL users, and the registry has deliberately deferred sync-crypto
 * ("v2.6b / deferred — R7"); reversing that here would be broader than this
 * slice's mandate. Per the task's "prefer a manual trigger or run-on-add if
 * cron wiring is too broad", v1 populates balances via:
 *   - run-on-add       — app/api/accounts/wallet/route.ts calls syncBtcWallet()
 *   - manual re-sync   — POST /api/accounts/[id]/sync
 * This body stays callable so a future registry entry (one line, same shape as
 * sync-banks / fetch-fx-rates) is trivial when cron scheduling is in scope.
 */

import { syncAllBtcWallets, type BtcSyncDeps, type SyncAllBtcWalletsResult } from "@/lib/crypto/btc-sync";

export type SyncCryptoResult = SyncAllBtcWalletsResult;

export async function syncCrypto(deps?: BtcSyncDeps): Promise<SyncCryptoResult> {
  return syncAllBtcWallets(deps);
}
