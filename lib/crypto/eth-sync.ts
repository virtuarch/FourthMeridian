/**
 * lib/crypto/eth-sync.ts
 *
 * W-M1b — native Ethereum wallet sync: orchestration + persistence.
 *
 * Reads a self-custodied ETH FinancialAccount (walletChain="ETH"), fetches its
 * native balance in wei, normalises to whole ETH, and records it as ONE
 * canonical OBSERVED `PositionObservation` through the SAME writer Bitcoin uses
 * (`captureWalletPosition`). There is no Ethereum-shaped observation, no
 * Ethereum-shaped valuation, and no Ethereum branch anywhere above this file:
 * the chain disappears at `captureWalletPosition({ asset: ETH_ASSET, … })`.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT WRITE ────────────────────────────────────
 * `FinancialAccount.balance` and `FinancialAccount.nativeBalance` are NOT
 * written, and that is the single most important line in this file.
 *
 * Bitcoin writes both, for historical reasons W6 exists to unwind: `balance` is
 * quantity × an undated sync-time spot quote, and it is what `SpaceSnapshot`
 * composes net worth from. Reproducing that for Ethereum would create a SECOND
 * asset whose value authority is a scalar column rather than the dated position
 * spine — building, in a new place, exactly the thing the next slice is meant to
 * remove. So Ether is valued the way every brokerage position is valued: the
 * canonical quantity observation times the dated archive close, through
 * `getCurrentPositions`.
 *
 * ── THE BOUNDARY THIS CREATES, STATED RATHER THAN SMUGGLED ───────────────────
 * The consequence is real and must not be discovered later. Until the wallet
 * net-worth convergence lands:
 *
 *   · HOLDINGS, EXPORT and the AI context see an Ethereum wallet's position
 *     correctly, valued at the dated close, because they read the spine;
 *   · NET WORTH does not. `SpaceSnapshot` composes its digital-asset component
 *     from `FinancialAccount.balance`, which for these wallets stays 0.
 *
 * Net worth therefore reads 0 for a wallet that demonstrably holds Ether, and
 * the schema gives nowhere to say "withheld" instead: `SpaceSnapshot.crypto` is
 * NOT NULL DEFAULT 0, so the column cannot express unknown (the same limitation
 * `cryptoValuationStatus` was created to work around for historical rows). This
 * slice does NOT fabricate a way around that. It refuses to smuggle an undated
 * spot value through `balance` to make a number appear, because a number that
 * appears by that route is the defect, not the fix.
 *
 * The alternative — writing `balance` — would make net worth "right" today and
 * make the convergence harder tomorrow, on a value with no dated provenance. The
 * boundary is documented here, in the sync result (`netWorthParticipation`), and
 * in the tests, so it is visible from every direction until W6 closes it.
 *
 * ── LEDGER: NOT APPLICABLE, NOT RECONCILED ───────────────────────────────────
 * This adapter imports no transactions, so there is no movement ledger to
 * reconcile the balance against. It reports `ledgerNotApplicable()`, NOT a
 * reconciliation, and NOT `NO_MOVEMENTS` (which would file a balance-only chain
 * as a broken Bitcoin wallet). A successful balance acquisition still reaches
 * "synced", because for a balance-only chain a complete sync genuinely is a
 * balance — the lifecycle and the historical carry licence read the same state
 * and correctly reach different conclusions from it.
 *
 * ── Failure policy (inherited from btc-sync, for the same reasons) ───────────
 *   - NEVER hide, soft-delete, or flip the account to "error". A failed sync
 *     leaves the row as it was, so a new wallet stays visible and "pending".
 *   - Record an honest, staged SyncIssue (WALLET_SYNC_FAILED, provider WALLET).
 *   - `syncEthWallet` never throws; it returns a result object.
 *   - A provider failure NEVER writes a position. An unreachable RPC and an
 *     empty wallet are opposite facts and must never produce the same row.
 *
 * Out of scope (W-M1b): ERC-20 tokens, transaction import, internal transfers,
 * ENS, contract detection, staking, L2s, any EVM chain other than mainnet.
 */

import { ETH_NATIVE } from "@/lib/crypto/native-asset";
import { syncEvmWallet, type EvmSyncDeps, type EvmWalletSyncResult } from "@/lib/crypto/evm-native";
import { ETH_NETWORK } from "@/lib/crypto/evm-networks";

/** The chain token this adapter serves — the shared descriptor's, not a literal. */
export const ETH_CHAIN = ETH_NATIVE.chain;

/** Ethereum's sync deps are the generic EVM ones. */
export type EthSyncDeps = EvmSyncDeps;
export type EthWalletSyncResult = EvmWalletSyncResult;

/**
 * Sync one native Ethereum wallet.
 *
 * W-M3 — the orchestration moved to lib/crypto/evm-native.ts, unchanged in
 * substance. Ethereum, BNB Smart Chain, Polygon and Avalanche expose the native
 * balance through the same protocol, so keeping four copies would have been four
 * places for one bug. What remains here is Ethereum's NAME and its network
 * config; every invariant this adapter carried is now carried once, for all of
 * them, and is source-scanned there.
 */
export async function syncEthWallet(
  accountId: string,
  deps: EthSyncDeps = {},
): Promise<EthWalletSyncResult> {
  return syncEvmWallet(accountId, ETH_NETWORK, deps);
}

export interface SyncAllEthWalletsResult {
  total: number;
  succeeded: number;
  failed: number;
  syncedAccountIds: string[];
}

/**
 * Sync every active native ETH wallet. One wallet's failure never blocks the
 * rest — each is wrapped by `syncEvmWallet`'s own never-throw contract.
 *
 * Deliberately NOT wired to a cron: activation is the routes' business.
 */
export async function syncAllEthWallets(deps: EthSyncDeps = {}): Promise<SyncAllEthWalletsResult> {
  const { db } = await import("@/lib/db");
  const wallets = await db.financialAccount.findMany({
    where:  { walletChain: ETH_CHAIN, deletedAt: null },
    select: { id: true },
  });
  let succeeded = 0, failed = 0;
  const syncedAccountIds: string[] = [];
  for (const w of wallets) {
    const r = await syncEthWallet(w.id, deps);
    if (r.ok) { succeeded++; syncedAccountIds.push(w.id); }
    else failed++;
  }
  return { total: wallets.length, succeeded, failed, syncedAccountIds };
}
