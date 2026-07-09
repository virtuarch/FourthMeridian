/**
 * lib/crypto/btc-sync.ts
 *
 * BTC wallet balance sync v1 — orchestration + persistence.
 *
 * Reads a self-custodied BTC FinancialAccount (walletChain="BTC"), fetches its
 * confirmed on-chain balance and a BTC→USD spot price (lib/crypto/btc-explorer.ts),
 * and writes:
 *   - nativeBalance : balance in BTC
 *   - balance       : USD value at the spot price
 *   - currency      : "USD"
 *   - syncStatus    : "pending" → "synced"
 *   - lastUpdated   : now
 *
 * Failure policy (per the wallet-connector visibility investigation, 2026-07-09):
 *   - NEVER hide or soft-delete the account, NEVER touch its SpaceAccountLink,
 *     NEVER flip it to "error". A failed sync leaves the row exactly as it was
 *     (a new wallet stays visible and "pending"), so visibility is preserved.
 *   - Record an honest, staged SyncIssue (reusing the existing model + the
 *     generic UPSERT_ERROR kind; provider="WALLET") — best-effort, never throws.
 *   - syncBtcWallet() itself never throws; it returns a result object.
 *
 * Out of scope (v1): xpub, transaction import, wallet history, other chains,
 * dashboard filtering, SpaceAccountLink behavior, schema changes.
 */

import { db } from "@/lib/db";
import { SyncIssueKind, type Prisma } from "@prisma/client";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";
import {
  fetchConfirmedSats,
  fetchBtcUsdPrice,
  satsToBtc,
  computeUsdBalance,
  BtcSyncError,
  type FetchFn,
} from "@/lib/crypto/btc-explorer";

/** The only chain this v1 sync supports. */
export const BTC_CHAIN = "BTC";

export interface BtcWalletSyncResult {
  accountId: string;
  ok: boolean;
  /** Set only on success — the row's new persisted state. */
  syncStatus?: "synced";
  nativeBalance?: number;
  balanceUsd?: number;
  priceUsd?: number;
  /** On failure: which step failed and why (also recorded as a SyncIssue). */
  stage?: "load" | "balance" | "price";
  reason?: string;
}

export interface BtcSyncDeps {
  /** Injected fetch (offline tests / alternate transport). */
  fetchImpl?: FetchFn;
  /** Override the balance fetch — returns confirmed satoshis for an address. */
  balanceFetcher?: (address: string) => Promise<number>;
  /** Override the price fetch — returns BTC→USD. */
  priceFetcher?: () => Promise<number>;
}

/** Best-effort SyncIssue writer — never throws (mirrors lib/plaid/syncIssues.ts). */
async function recordWalletSyncIssue(
  financialAccountId: string,
  stage: "balance" | "price",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.syncIssue.create({
      data: {
        provider: "WALLET",
        financialAccountId,
        kind: SyncIssueKind.UPSERT_ERROR,
        detail: { chain: BTC_CHAIN, stage, message, ...(extra ?? {}) } as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    console.error(`[btc-sync] failed to record SyncIssue for ${financialAccountId} (non-fatal):`, e);
  }
}

/**
 * Sync one BTC wallet account. Never throws. On any external failure the
 * account row is left untouched (visible, still "pending") and a SyncIssue is
 * recorded.
 */
export async function syncBtcWallet(
  accountId: string,
  deps: BtcSyncDeps = {},
): Promise<BtcWalletSyncResult> {
  const account = await db.financialAccount.findUnique({
    where: { id: accountId },
    select: { id: true, ownerUserId: true, walletChain: true, walletAddress: true, deletedAt: true },
  });

  // Guard: only an active, addressed BTC wallet is syncable here.
  if (!account || account.deletedAt || account.walletChain !== BTC_CHAIN || !account.walletAddress) {
    return { accountId, ok: false, stage: "load", reason: "not a syncable BTC wallet" };
  }

  const address = account.walletAddress;
  const balanceFetcher = deps.balanceFetcher ?? ((a: string) => fetchConfirmedSats(a, deps.fetchImpl));
  const priceFetcher = deps.priceFetcher ?? (() => fetchBtcUsdPrice(deps.fetchImpl));

  // 1) Confirmed on-chain balance.
  let sats: number;
  try {
    sats = await balanceFetcher(address);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordWalletSyncIssue(accountId, "balance", reason, { address });
    return { accountId, ok: false, stage: "balance", reason };
  }

  // 2) BTC→USD spot price.
  let priceUsd: number;
  try {
    priceUsd = await priceFetcher();
  } catch (err) {
    const stage = err instanceof BtcSyncError ? err.stage : "price";
    const reason = err instanceof Error ? err.message : String(err);
    await recordWalletSyncIssue(accountId, "price", reason);
    return { accountId, ok: false, stage, reason };
  }

  // 3) Persist. Only balance/native/currency/sync fields — no link, no
  //    deletedAt, no transaction, no holding, nothing that changes visibility.
  const nativeBalance = satsToBtc(sats);
  const balanceUsd = computeUsdBalance(nativeBalance, priceUsd);
  await db.financialAccount.update({
    where: { id: accountId },
    data: {
      nativeBalance,
      balance: balanceUsd,
      currency: "USD",
      syncStatus: "synced",
      lastUpdated: new Date(),
    },
  });

  // Wallet Provider v1.5 — record this sync on the wallet's Connection spine
  // (ensures/links Connection → identity → AccountConnection, and stamps
  // lastSyncedAt). Best-effort/non-fatal and also serves as the lazy backfill
  // for wallets created before v1.5. Does not alter the balance write above.
  if (account.ownerUserId) {
    await alignWalletProviderSpine({
      userId:             account.ownerUserId,
      financialAccountId: accountId,
      address,
      chain:              BTC_CHAIN,
      markSynced:         true,
    });
  }

  return { accountId, ok: true, syncStatus: "synced", nativeBalance, balanceUsd, priceUsd };
}

export interface SyncAllBtcWalletsResult {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Sync every active BTC wallet. The BTC→USD price is fetched once and shared
 * across accounts (they all value at the same spot). One wallet's failure never
 * blocks the rest — each is wrapped by syncBtcWallet's own never-throw contract.
 */
export async function syncAllBtcWallets(deps: BtcSyncDeps = {}): Promise<SyncAllBtcWalletsResult> {
  const wallets = await db.financialAccount.findMany({
    where: { walletChain: BTC_CHAIN, deletedAt: null },
    select: { id: true },
  });

  // Memoize the price fetch for the batch (unless the caller injected one).
  let priceOnce: Promise<number> | null = null;
  const sharedPriceFetcher =
    deps.priceFetcher ??
    (() => (priceOnce ??= fetchBtcUsdPrice(deps.fetchImpl)));

  let succeeded = 0;
  let failed = 0;
  for (const w of wallets) {
    const r = await syncBtcWallet(w.id, { ...deps, priceFetcher: sharedPriceFetcher });
    if (r.ok) succeeded++;
    else failed++;
  }

  return { total: wallets.length, succeeded, failed };
}
