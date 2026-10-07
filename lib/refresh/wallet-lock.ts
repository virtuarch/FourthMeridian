/**
 * lib/refresh/wallet-lock.ts  (P1 REFRESH ALL — the wallet sync claim)
 *
 * THE GUARD THE WALLET PATH LACKED. Plaid Items have had a per-item sync claim
 * (PlaidItem.syncLockedAt, lib/plaid/sync-lock.ts) since F1; a manual wallet
 * sync had none, so two concurrent syncs of one wallet raced the success clock
 * and the position spine, and a user could start them back to back. This is the
 * same primitive on Connection.syncLockedAt: an atomic conditional update that
 * succeeds only when unlocked or when the prior claim is stale.
 *
 * NO DATABASE CLIENT IS IMPORTED. The caller passes the authority it holds — a
 * tenant transaction for the customer's own connections (fm_app holds UPDATE on
 * Connection under "userId" = me), fm_system for an operator. A zero-row claim
 * is read as "another sync holds it"; under the tenant role an INVISIBLE
 * connection also yields zero, which is why the route resolves ownership first
 * (its 404 gate) before any claim is attempted.
 */

import type { Prisma } from "@prisma/client";

/** Must exceed the longest wallet sync budget (an ETH history rebuild measured 157 s). */
export const WALLET_LOCK_TTL_MS = 360_000;

export interface WalletSyncLockClient {
  connection: {
    updateMany(args: { where: Prisma.ConnectionWhereInput; data: Prisma.ConnectionUpdateManyMutationInput }): Promise<{ count: number }>;
  };
}

/** Claim the per-connection sync lock. True iff claimed. */
export async function claimWalletSyncLock(connectionId: string, client: WalletSyncLockClient, now: Date = new Date()): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - WALLET_LOCK_TTL_MS);
  const claim = await client.connection.updateMany({
    where: { id: connectionId, OR: [{ syncLockedAt: null }, { syncLockedAt: { lte: staleCutoff } }] },
    data:  { syncLockedAt: now },
  });
  return claim.count === 1;
}

/** Release the lock. Best-effort: never throws. */
export async function releaseWalletSyncLock(connectionId: string, client: WalletSyncLockClient): Promise<void> {
  try {
    await client.connection.updateMany({ where: { id: connectionId }, data: { syncLockedAt: null } });
  } catch (e) {
    console.error(`[wallet-lock] failed to release lock for connection ${connectionId}:`, e instanceof Error ? e.message : String(e));
  }
}

/** Stamp the manual-refresh clock the customer's cooldown entitlement is judged against. Every attempt counts. */
export async function markWalletManualRefreshed(connectionId: string, client: WalletSyncLockClient, now: Date = new Date()): Promise<void> {
  await client.connection.updateMany({ where: { id: connectionId }, data: { lastManualRefreshAt: now } });
}
