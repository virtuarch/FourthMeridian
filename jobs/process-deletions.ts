/**
 * jobs/process-deletions.ts  (OPS-2 S7c · IDEMP-002)
 *
 * Finds every account whose pending-deletion grace window has elapsed
 * (deletionScheduledAt <= now) and runs the irreversible purge pipeline
 * (lib/account-deletion/purge.ts) for each. Run daily via the dispatcher
 * (lib/jobs/registry.ts) with app/api/jobs/process-deletions as the fallback.
 *
 * Idempotent and resumable: a cancelled user has deletionScheduledAt cleared
 * (S7a) so is never selected, and a user whose purge partially failed still has
 * a User row, so the next run picks them up again. One failure never blocks the
 * others.
 *
 * IDEMP-002 (2026-10-22): the purge CLAIMS the user first (User.purgeStartedAt,
 * one conditional UPDATE), so two overlapping wakes — the runtime audit's
 * reproduction, which executed the destructive tail twice — now resolve to
 * exactly one worker per user. The selection here skips users another worker
 * holds a LIVE claim on; a claim older than PURGE_CLAIM_STALE_MS is a crashed
 * worker's and the user is re-selected (the crash-safe retry). The claim
 * itself is still asserted inside purgeUser, so this selection is a courtesy
 * filter, never the guard.
 */

import { db } from "@/lib/db";
import { purgeUser, PURGE_CLAIM_STALE_MS, type PurgeDeps } from "@/lib/account-deletion/purge";

export interface ProcessDeletionsResult {
  total:     number;
  purged:    number;
  skipped:   number;
  failed:    number;
}

export interface ProcessDeletionsDeps {
  /** Test injection seam — production callers never pass these. */
  loadDue?: (now: Date) => Promise<{ id: string }[]>;
  purge?: (userId: string, deps?: PurgeDeps) => Promise<{ purged: boolean }>;
  now?: () => Date;
}

export async function processDeletions(deps: ProcessDeletionsDeps = {}): Promise<ProcessDeletionsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const staleBefore = new Date(now.getTime() - PURGE_CLAIM_STALE_MS);
  const due = await (deps.loadDue ?? ((at: Date) => db.user.findMany({
    where:  {
      deletionScheduledAt: { not: null, lte: at },
      OR: [{ purgeStartedAt: null }, { purgeStartedAt: { lte: staleBefore } }],
    },
    select: { id: true },
  })))(now);

  if (due.length === 0) return { total: 0, purged: 0, skipped: 0, failed: 0 };

  let purged = 0;
  let skipped = 0;
  let failed = 0;

  const purge = deps.purge ?? purgeUser;
  for (const u of due) {
    try {
      const result = await purge(u.id);
      if (result.purged) purged++;
      else skipped++;
    } catch (e) {
      failed++;
      console.error(`[process-deletions] purge failed for user ${u.id} (will retry next run):`, e);
    }
  }

  console.log(`[process-deletions] complete — ${purged} purged, ${skipped} skipped, ${failed} failed, ${due.length} due`);

  return { total: due.length, purged, skipped, failed };
}
