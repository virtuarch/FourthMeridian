/**
 * lib/plaid/sync-lock.ts
 *
 * The shared PlaidItem sync-concurrency primitive.
 *
 * Extracted from lib/plaid/webhook-sync.ts (2026-07-14 — connections-weirdness
 * investigation, F1: docs/investigations/FOURTH_MERIDIAN_CONNECTIONS_WEIRDNESS_INVESTIGATION_2026-07-14.md).
 * `e70e9f8` gave the webhook/connect pipeline a per-item lock (PlaidItem.syncLockedAt)
 * so the two could never run concurrently against the same item, but five other
 * live callers of the sync engine — manual "Sync Now", manual "Refresh"
 * (single + bulk), the client auto-resume route, "Enable Investments", and the
 * daily sync-banks cron — still called it lock-free. Any of those can race a
 * webhook/connect pipeline (or each other) against PlaidItem.cursor and collide
 * on prisma.transaction.create() — the "Amex 363 UPSERT_ERROR / stuck-import"
 * signature the original incident hit. This module is the ONE place that owns
 * the lock so every caller shares the same guard.
 *
 * Two layers:
 *   - claimPlaidItemSyncLock / releasePlaidItemSyncLock — the low-level atomic
 *     primitives. Use these directly when the caller's success/failure signal
 *     is a RETURN VALUE rather than a thrown error (e.g. runDeferredHistorySync,
 *     which never throws by design — see webhook-sync.ts).
 *   - withPlaidItemSyncLock — a convenience wrapper for the common case: fn()
 *     throwing means the sync failed (syncIncompleteAt is left exactly as fn's
 *     own error handling set it), fn() resolving means it succeeded (release
 *     also clears syncIncompleteAt, mirroring the b871093 fix). Most callers
 *     (routes with their own try/catch around the engine call) want this.
 *
 * A `client` param on every export defaults to the real `db` and accepts an
 * injected fake in tests (same seam idiom as lib/jobs/run.ts's JobRunWriteClient)
 * — no live database needed to test the claim/skip/release logic.
 */

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Stale-lock recovery window. A crashed/killed pipeline that never released its
 * lock is re-claimable after this long. Set well beyond the 60s invocation
 * budget every guarded route/job runs under, so it never pre-empts a genuinely
 * live sync.
 */
export const LOCK_TTL_MS = 180_000; // 3 minutes

export interface PlaidItemSyncLockClient {
  plaidItem: {
    updateMany(args: {
      where: Prisma.PlaidItemWhereInput;
      data: Prisma.PlaidItemUpdateManyMutationInput;
    }): Promise<{ count: number }>;
  };
}

/**
 * Attempt to claim the per-item sync lock via an atomic conditional update
 * (succeeds only if unlocked, or the prior lock is stale). Returns true iff
 * claimed. On failure to claim, stamps syncIncompleteAt=now — the lock is
 * already held by a fresh (non-stale) sync, so this records that more work
 * may be pending without racing it; the resume machinery / next trigger
 * revisits the item once the holder is done.
 */
export async function claimPlaidItemSyncLock(
  plaidItemId: string,
  client: PlaidItemSyncLockClient = db,
): Promise<boolean> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - LOCK_TTL_MS);

  const claim = await client.plaidItem.updateMany({
    where: { id: plaidItemId, OR: [{ syncLockedAt: null }, { syncLockedAt: { lte: staleCutoff } }] },
    data:  { syncLockedAt: now },
  });

  if (claim.count === 0) {
    await client.plaidItem
      .updateMany({ where: { id: plaidItemId }, data: { syncIncompleteAt: now } })
      .catch(() => {});
    return false;
  }
  return true;
}

/**
 * Release the per-item sync lock. `clearIncomplete` must be true ONLY when the
 * caller's own run genuinely completed the full history — a losing duplicate
 * can stamp syncIncompleteAt via claimPlaidItemSyncLock's skip branch WHILE
 * this run is still finishing (see b871093); only the winning run's
 * SUCCESSFUL completion should clear it. Best-effort: never throws.
 */
export async function releasePlaidItemSyncLock(
  plaidItemId: string,
  clearIncomplete: boolean,
  client: PlaidItemSyncLockClient = db,
): Promise<void> {
  await client.plaidItem
    .updateMany({
      where: { id: plaidItemId },
      data:  clearIncomplete ? { syncLockedAt: null, syncIncompleteAt: null } : { syncLockedAt: null },
    })
    .catch((e) => console.error(`[plaid sync-lock] failed to release lock for item ${plaidItemId}:`, e));
}

export type SyncLockResult<T> = { ok: true; result: T } | { ok: false; reason: "in-flight" };

/**
 * Convenience wrapper for the common case: fn() throwing means the sync
 * failed (leave syncIncompleteAt as fn's own error handling set it — this
 * wrapper does not catch, the exception propagates to the caller after the
 * lock is released); fn() resolving means it succeeded (clear syncIncompleteAt
 * at release). If another sync already holds the lock, fn is NEVER called and
 * the caller gets { ok: false, reason: "in-flight" } instead of silently
 * racing it — every caller must handle this explicitly.
 *
 * Callers whose success/failure is a RETURN VALUE rather than a thrown error
 * should use claimPlaidItemSyncLock/releasePlaidItemSyncLock directly instead
 * (see syncPlaidItemFromWebhook in webhook-sync.ts).
 */
export async function withPlaidItemSyncLock<T>(
  plaidItemId: string,
  fn: () => Promise<T>,
  client: PlaidItemSyncLockClient = db,
): Promise<SyncLockResult<T>> {
  if (!(await claimPlaidItemSyncLock(plaidItemId, client))) {
    return { ok: false, reason: "in-flight" };
  }
  let succeeded = false;
  try {
    const result = await fn();
    succeeded = true;
    return { ok: true, result };
  } finally {
    await releasePlaidItemSyncLock(plaidItemId, succeeded, client);
  }
}
