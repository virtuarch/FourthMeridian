/**
 * POST /api/plaid/resume-sync
 *
 * D2.x resume — automatic continuation of an INCOMPLETE first-run history
 * import. Distinct from the manual "Sync Now" endpoint (app/api/plaid/sync):
 *   - "Sync Now" is a user action gated by a 60-MINUTE per-item cooldown,
 *     which is far too long for an automatic "keep importing until done" loop.
 *   - This endpoint is the machine-driven resume the ConnectionsList poller
 *     calls while an item is still importing. It has its own SHORT age gate
 *     instead: it only acts on an item whose syncIncompleteAt marker is older
 *     than RESUME_MIN_AGE_MS, which (a) never collides with the in-flight
 *     post-connect background sync (that runs within the 60s connect budget)
 *     and (b) spaces successive resume attempts ~one budget apart.
 *
 * Resuming is safe and cheap: syncTransactionsForItem resumes from the
 * per-page-persisted cursor (never restarts the full pull) and clears
 * syncIncompleteAt once the loop completes.
 *
 * Body: { plaidItemId: string } — must be an ACTIVE item owned by the caller.
 * Returns { resumed: boolean, complete?: boolean, reason?: string }.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { withApiHandler } from "@/lib/api";
import { PlaidItemStatus } from "@prisma/client";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { regenerateWealthHistoryForItem } from "@/lib/plaid/backgroundHistorySync";
import { classifyPlaidErrorForHealth, plaidErrorSummary } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { limitByUser } from "@/lib/rate-limit";

// Resuming a large remaining history can take a while — same budget as the
// connect flow and the daily cron. Raised 60→300 (Vercel Pro ceiling) after
// 2026-07-22, when both this route and the webhook died on "Task timed out
// after 60 seconds" mid-import: each attempt burned a full budget, advanced a
// few pages, and left the customer staring at a stalled "importing" card.
// COUPLED: sync-lock LOCK_TTL_MS and RESUME_MIN_AGE_MS below must both stay
// ABOVE this budget, or a still-running sync is judged stale and raced.
export const maxDuration = 300;

// Minimum age of the syncIncompleteAt marker before a resume is allowed. Set
// slightly above the connect/background budget (maxDuration above) so a resume
// can never run concurrently with the in-flight post-connect sync, and so
// repeated attempts on a genuinely stalled item stay ~one budget apart.
// Tracks maxDuration: 60s budget → 75s, 300s budget → 315s.
export const RESUME_MIN_AGE_MS = 315_000;

interface ResumeBody {
  plaidItemId?: string;
}

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  // Coarse per-user backstop against a misbehaving client. Generous: a real
  // resume loop fires a handful of times per connect before completing.
  const limited = await limitByUser(user.id, "plaid-resume-sync", { limit: 60, windowSec: 3600 });
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as ResumeBody;
  if (!body.plaidItemId) {
    return NextResponse.json({ error: "plaidItemId is required" }, { status: 400 });
  }

  const item = await db.plaidItem.findFirst({
    where:  { id: body.plaidItemId, userId: user.id, status: PlaidItemStatus.ACTIVE },
    select: { id: true, syncIncompleteAt: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
  }

  // Not incomplete → nothing to resume (a full sync already cleared the marker).
  if (item.syncIncompleteAt === null) {
    return NextResponse.json({ resumed: false, reason: "already-complete" });
  }

  // Too soon → the in-flight background sync is likely still running; refuse so
  // we never double-sync the same item. The client will retry on its interval.
  const ageMs = Date.now() - item.syncIncompleteAt.getTime();
  if (ageMs < RESUME_MIN_AGE_MS) {
    return NextResponse.json({ resumed: false, reason: "too-soon" });
  }

  // Reset the marker to now() BEFORE syncing: this re-arms the age gate so a
  // second concurrent resume request is refused as "too-soon", and (if this
  // attempt is itself interrupted) spaces the next attempt one budget out.
  await db.plaidItem.update({
    where: { id: item.id },
    data:  { syncIncompleteAt: new Date() },
  });

  // F1 (2026-07-14) — go through the SAME syncLockedAt guard the webhook/connect
  // pipeline uses. Without this, a resume can run concurrently with a webhook
  // that fires mid-import (the age gate above only protects against the
  // in-flight post-connect run; it predates the webhook receiver and knows
  // nothing about it) — the highest-probability repro of the original
  // Amex stuck-import incident. See sync-lock.ts + the connections-weirdness
  // investigation §4.1(a).
  try {
    const lockResult = await withPlaidItemSyncLock(item.id, () => syncTransactionsForItem(item.id));
    if (!lockResult.ok) {
      // Another sync already holds the lock — don't race it. That run's own
      // completion resolves this item's state; the next resume attempt (or
      // that run's success) picks it up.
      return NextResponse.json({ resumed: false, reason: "in-flight" });
    }
    // syncTransactionsForItem cleared syncIncompleteAt on a full completion.

    // A9 — the import just finished, so NOW recompute the wealth-history window.
    // This route drives syncTransactionsForItem directly (for the lock semantics
    // documented above) and therefore never ran the deferred pipeline's
    // regeneration. That left the window frozen at whatever connect-time
    // computed — and at connect Plaid has delivered nothing yet, so it is always
    // the 30-day fallback. This is the point where MIN(transaction.date) finally
    // reflects the history that actually arrived. Best-effort by contract: it
    // swallows its own failures and can never turn a successful resume into a
    // failed one.
    await regenerateWealthHistoryForItem(item.id);

    return NextResponse.json({ resumed: true, complete: true });
  } catch (e) {
    console.error(`[plaid][resume-sync] resume failed for item ${item.id}: ${plaidErrorSummary(e)}`, e);
    const health = classifyPlaidErrorForHealth(e);
    if (health) {
      // CH-2 chokepoint (previously a direct db.plaidItem.update here — §5.1
      // of the connections-weirdness investigation: this failure path bypassed
      // the durable transition-history record).
      await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
      await notifyItemSyncFailed(item.id);
    }
    // syncIncompleteAt stays set (re-armed above) so the item still reads as
    // importing and a later attempt / the daily cron can finish the job.
    return NextResponse.json({ resumed: true, complete: false });
  }
}, "POST /api/plaid/resume-sync");
