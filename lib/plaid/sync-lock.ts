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
 *
 * ⚠️ THE DEFAULTED CLIENT IS A KNOWN DEBT, DELIBERATELY NOT PAID HERE (RLS-C-S6a).
 * An OPTIONAL authority is an AMBIENT one, and this programme is removing them.
 * It is not removed in this slice because it cannot be removed in isolation:
 * every one of the eight call sites would have to pass `db` today — no Plaid
 * caller holds a tenant or system authority yet, that is the split-authority
 * slice's subject — and lib/plaid/webhook-sync.ts is the one caller with NO
 * `db` import at all, so requiring the parameter would GROW the db-authority
 * ratchet by introducing ambient authority to a module that currently has none.
 * Making it required belongs to the slice that gives these callers an authority
 * worth naming, not to the one that makes the refusal audible.
 */

import { db } from "@/lib/db";
import { resolveConditionalWrite } from "@/lib/db/conditional-write";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import type { Prisma } from "@prisma/client";

/**
 * Stale-lock recovery window. A crashed/killed pipeline that never released its
 * lock is re-claimable after this long. Set well beyond the 60s invocation
 * budget every guarded route/job runs under, so it never pre-empts a genuinely
 * live sync.
 */
// MUST exceed the longest sync budget (maxDuration = 300s on exchange-token,
// webhook and resume-sync). A TTL below that budget would declare a sync that
// is still legitimately running "stale", letting a second pipeline claim the
// lock and race the cursor — the one thing this lock exists to prevent.
export const LOCK_TTL_MS = 360_000; // 6 minutes — one budget (300s) plus headroom

export interface PlaidItemSyncLockClient {
  plaidItem: {
    updateMany(args: {
      where: Prisma.PlaidItemWhereInput;
      data: Prisma.PlaidItemUpdateManyMutationInput;
    }): Promise<{ count: number }>;
    /**
     * RLS-C-S6a — the VISIBILITY PROBE, and the reason it is on this seam at all.
     * A failed claim cannot tell "another sync holds the lock" from "this
     * authority cannot see the item"; one indexed count on the SAME client
     * answers the second question. Required, not optional: an injected fake that
     * omitted it would silently test the pre-S6a behaviour.
     */
    count(args: { where: Prisma.PlaidItemWhereInput }): Promise<number>;
  };
}

/**
 * Attempt to claim the per-item sync lock via an atomic conditional update
 * (succeeds only if unlocked, or the prior lock is stale). Returns true iff
 * claimed. On failure to claim, stamps syncIncompleteAt=now — the lock is
 * already held by a fresh (non-stale) sync, so this records that more work
 * may be pending without racing it; the resume machinery / next trigger
 * revisits the item once the holder is done.
 *
 * ⚠️ RLS-C-S6a — A ZERO-ROW CLAIM IS NOT PROOF OF A COMPETITOR.
 * This is the site the indeterminate-write rule was written for, and the worst
 * of the four. `count === 0` used to mean, unconditionally, "another sync is in
 * flight" — a verdict with a calm, defined, PERMANENT response: skip, stamp
 * syncIncompleteAt, let the holder finish. If the zero came from a policy
 * refusal instead there is no holder, so nothing ever finishes, every
 * subsequent trigger reads the same zero, and the item NEVER REFRESHES AGAIN
 * while every log line says "already syncing". The stamp that records the skip
 * was itself `.catch(() => {})`, so the refusal was swallowed twice over.
 *
 * So the claim's failure is now resolved against VISIBILITY before it is called
 * contention, and an invisible item raises IndeterminateWriteError rather than
 * returning false. The throw propagates: every caller already treats an
 * exception from the sync pipeline as a failed sync that is logged and surfaced,
 * which is precisely the outcome a phantom lock denied them.
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

  // Throws when the item is not visible to `client`; returns false only for a
  // claim that genuinely lost to a live lock holder.
  const claimed = await resolveConditionalWrite(
    claim.count,
    { table: "PlaidItem", rowId: plaidItemId, operation: "update" },
    () => client.plaidItem.count({ where: { id: plaidItemId } }),
  );
  if (claimed) return true;

  // Reached ONLY once visibility is established, so this best-effort stamp can
  // no longer hide a refusal — but it is still best-effort, and a swallowed
  // failure with nothing in the log is how this class of defect survives. Log it.
  await client.plaidItem
    .updateMany({ where: { id: plaidItemId }, data: { syncIncompleteAt: now } })
    .catch((e) => console.error(`[plaid sync-lock] failed to stamp syncIncompleteAt for item ${plaidItemId}:`, redactedErrorForLog(e)));
  return false;
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
    .catch((e) => console.error(`[plaid sync-lock] failed to release lock for item ${plaidItemId}:`, redactedErrorForLog(e)));
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
