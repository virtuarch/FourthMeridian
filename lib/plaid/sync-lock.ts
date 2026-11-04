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
  client?: PlaidItemSyncLockClient,
): Promise<boolean> {
  return (await claimPlaidItemSyncLockAt(plaidItemId, client)) !== null;
}

/**
 * IDEMP-005 — the claim, returning the FENCING TOKEN: the exact `syncLockedAt`
 * this holder wrote, or null when the claim lost to a live holder. Passing it
 * back to releasePlaidItemSyncLock makes the release conditional on still
 * owning the lease, so a slow run (> LOCK_TTL_MS) whose lease was taken over
 * can no longer clear the NEW holder's lock and let a third caller in.
 */
export async function claimPlaidItemSyncLockAt(
  plaidItemId: string,
  client: PlaidItemSyncLockClient = db,
): Promise<Date | null> {
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
  if (claimed) return now;

  // Reached ONLY once visibility is established, so this best-effort stamp can
  // no longer hide a refusal — but it is still best-effort, and a swallowed
  // failure with nothing in the log is how this class of defect survives. Log it.
  await client.plaidItem
    .updateMany({ where: { id: plaidItemId }, data: { syncIncompleteAt: now } })
    .catch((e) => console.error(`[plaid sync-lock] failed to stamp syncIncompleteAt for item ${plaidItemId}:`, redactedErrorForLog(e)));
  return null;
}

/**
 * What a release found. `pendingSignal` is true iff this holder's run SUCCEEDED
 * and a skip landed WHILE it held the lease (a losing claim stamped
 * syncIncompleteAt after `claimedAt`) — so the marker was deliberately left in
 * place and more work is pending. Always false on a failed run (the marker
 * stands anyway), on an un-fenced release, and on a release that lost its lease.
 */
export interface SyncLockReleaseResult { pendingSignal: boolean }

/**
 * Release the per-item sync lock. `clearIncomplete` must be true ONLY when the
 * caller's own run genuinely completed the full history — a losing duplicate
 * can stamp syncIncompleteAt via claimPlaidItemSyncLock's skip branch WHILE
 * this run is still finishing (see b871093); only the winning run's
 * SUCCESSFUL completion should clear it. Best-effort: never throws.
 *
 * P2 (2026-11-02, Production 2026-11-01) — A SKIP THAT LANDED MID-RUN IS NOT
 * STALE. b871093 cleared syncIncompleteAt unconditionally on success, on the
 * reasoning that the loser's stamp was a stale duplicate of work this run had
 * already done. That holds for a duplicate delivery of the SAME signal; it is
 * false for a NEW signal. A card's HISTORICAL_UPDATE ("history is ready")
 * arrived 9 s into a 15 s RECONNECT run, lost the claim, stamped the marker —
 * and the holder's success erased it, so nothing pulled the history until the
 * user pressed Refresh (otherwise ~8 h, the next scheduled sync).
 *
 * So with a fencing token the success-clear is now CONDITIONAL on the marker
 * being OLDER than this holder's own claim: a marker from before the claim
 * (the connect stamp, a prior failed run) is this run's to discharge and is
 * cleared exactly as before; a marker stamped at or after it is a signal this
 * run may not have seen (a tie errs toward the follow-up, which is merely an
 * extra incremental pull), and it survives for the holder's one follow-up
 * (webhook-sync) or the resume-stale-imports backstop. The lock itself is
 * released either way. A loser can only stamp while the lease is held, and the
 * lease is held until the second statement below, so no stamp falls between
 * the two writes.
 *
 * ── CLOCK DOMAINS — ACCEPTED SKEW (P3, 2026-11-02) ──────────────────────────
 * `claimedAt` and a loser's syncIncompleteAt stamp are both `new Date()` on an
 * APP server, possibly two different serverless instances. They are compared
 * as if one clock wrote both. Deliberately NOT moved to the database clock:
 * the claim would have to return a DB-stamped token (raw `UPDATE … RETURNING`
 * through PlaidItemSyncLockClient, re-deriving RLS-C-S6a's visibility
 * resolution and every fake), and the OTHER marker writers (exchangeToken's
 * connect stamp, runDeferredHistorySync's failure marker) would still stamp
 * app time — so the comparison would stay mixed-domain for every pre-claim
 * marker anyway. The skew is bounded by instance NTP (milliseconds) and both
 * directions are safe:
 *   · loser's clock BEHIND the holder's by δ — a skip landing within δ after
 *     the claim reads as pre-claim and is cleared: today's pre-P2 behaviour,
 *     and only for a skip that lands before the holder has issued any
 *     provider call (the claim precedes the first /transactions/sync by far
 *     more than δ), so the holder's own pull still sees what it announced;
 *   · loser's clock AHEAD — a pre-claim marker can read as post-claim and is
 *     kept: one harmless extra pull (the follow-up / a resume pass).
 * Pinned by lib/plaid/webhook-skip-signal.test.ts §6.
 */
export async function releasePlaidItemSyncLock(
  plaidItemId: string,
  clearIncomplete: boolean,
  client: PlaidItemSyncLockClient = db,
  claimedAt?: Date,
): Promise<SyncLockReleaseResult> {
  const fail = (e: unknown) => {
    console.error(`[plaid sync-lock] failed to release lock for item ${plaidItemId}:`, redactedErrorForLog(e));
    return null;
  };
  const leaseLost = () =>
    console.warn(`[plaid sync-lock] lease for item ${plaidItemId} was taken over before release (run outlived ${LOCK_TTL_MS} ms) — left the new holder's lock intact.`);

  // Legacy un-fenced release (no caller in tree passes none today): unconditional, as before.
  if (!claimedAt) {
    await client.plaidItem
      .updateMany({
        where: { id: plaidItemId },
        data:  clearIncomplete ? { syncLockedAt: null, syncIncompleteAt: null } : { syncLockedAt: null },
      })
      .catch(fail);
    return { pendingSignal: false };
  }

  // IDEMP-005 — with a fencing token the release only matches while THIS
  // holder still owns the lease.
  const fence = { id: plaidItemId, syncLockedAt: claimedAt };
  if (clearIncomplete) {
    const cleared = await client.plaidItem
      .updateMany({
        where: { ...fence, OR: [{ syncIncompleteAt: null }, { syncIncompleteAt: { lt: claimedAt } }] },
        data:  { syncLockedAt: null, syncIncompleteAt: null },
      })
      .catch(fail);
    if (!cleared) return { pendingSignal: false };
    if (cleared.count > 0) return { pendingSignal: false };
    // Zero rows: either the marker is newer than our claim (a skip landed mid-run)
    // or the lease was taken over. The lock-only release below tells them apart.
  }
  const released = await client.plaidItem
    .updateMany({ where: fence, data: { syncLockedAt: null } })
    .catch(fail);
  if (released && released.count === 0) { leaseLost(); return { pendingSignal: false }; }
  if (released && clearIncomplete) {
    console.log(`[plaid sync-lock] item ${plaidItemId}: a sync was skipped while this run held the lock — its pending marker was kept, not cleared.`);
    return { pendingSignal: true };
  }
  return { pendingSignal: false };
}

/**
 * P2 follow-up — how the TRANSACTIONS ENGINE settles syncIncompleteAt at the end
 * of a completed sync (syncTransactionsForItem's final write), fenced the same
 * way as the release above.
 *
 * Before: the engine wrote `syncIncompleteAt = settled` (null, or the value it
 * read at start for a first-run hold) inside its final health update. A skip
 * stamped between the engine's start read and that write — e.g. a webhook that
 * lands while the last /transactions/sync page is in flight — was overwritten,
 * and the holder's (fenced) release then saw no pending signal.
 *
 * Now, when the engine runs under a held lock (`anchor` = the syncLockedAt it
 * read at start — the holder's fencing token), it never overwrites a marker
 * at/after the anchor:
 *   · "keep"           — first-run hold: the marker the engine read stays (or a
 *                        newer skip stamp does); the column is not written.
 *   · "clear-if-older" — the run is settled: clear ONLY a marker older than the
 *                        anchor, in a separate conditional write.
 *   · "inline"         — no lock held (unguarded callers: a script, the
 *                        exchangeToken inline sync): exactly the prior write.
 */
export type IncompleteMarkerSettle =
  | { mode: "inline"; value: Date | null }
  | { mode: "keep" }
  | { mode: "clear-if-older"; anchor: Date };

export function settleIncompleteMarker(
  item: { syncIncompleteAt: Date | null; syncLockedAt?: Date | null },
  nextCompletedSyncCount: number,
): IncompleteMarkerSettle {
  const stillFirstRun = item.syncIncompleteAt !== null && nextCompletedSyncCount < 2;
  const anchor = item.syncLockedAt ?? null;
  if (!anchor) return { mode: "inline", value: stillFirstRun ? item.syncIncompleteAt : null };
  return stillFirstRun ? { mode: "keep" } : { mode: "clear-if-older", anchor };
}

export type SyncLockResult<T> = { ok: true; result: T } | { ok: false; reason: "in-flight" };

/**
 * Convenience wrapper for the common case: fn() throwing means the sync
 * failed (leave syncIncompleteAt as fn's own error handling set it — this
 * wrapper does not catch, the exception propagates to the caller after the
 * lock is released); fn() resolving means it succeeded (clear syncIncompleteAt
 * at release — unless a skip landed during fn, whose marker survives for the
 * resume-stale-imports backstop; see releasePlaidItemSyncLock). If another sync already holds the lock, fn is NEVER called and
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
  const claimedAt = await claimPlaidItemSyncLockAt(plaidItemId, client);
  if (!claimedAt) {
    return { ok: false, reason: "in-flight" };
  }
  let succeeded = false;
  try {
    const result = await fn();
    succeeded = true;
    return { ok: true, result };
  } finally {
    await releasePlaidItemSyncLock(plaidItemId, succeeded, client, claimedAt);
  }
}
