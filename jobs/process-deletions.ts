/**
 * jobs/process-deletions.ts  (OPS-2 S7c)
 *
 * Finds every account whose pending-deletion grace window has elapsed
 * (deletionScheduledAt <= now) and runs the irreversible purge pipeline
 * (lib/account-deletion/purge.ts) for each. Run daily via Vercel Cron
 * (app/api/jobs/process-deletions) — mirrors jobs/sync-banks.ts.
 *
 * Idempotent and resumable: a cancelled user has deletionScheduledAt cleared
 * (S7a) so is never selected, and a user whose purge partially failed still has
 * a User row, so the next run picks them up again. One failure never blocks the
 * others.
 */

import { db } from "@/lib/db";
import { purgeUser } from "@/lib/account-deletion/purge";

export interface ProcessDeletionsResult {
  total:     number;
  purged:    number;
  skipped:   number;
  failed:    number;
}

export async function processDeletions(): Promise<ProcessDeletionsResult> {
  const due = await db.user.findMany({
    where:  { deletionScheduledAt: { not: null, lte: new Date() } },
    select: { id: true },
  });

  if (due.length === 0) return { total: 0, purged: 0, skipped: 0, failed: 0 };

  let purged = 0;
  let skipped = 0;
  let failed = 0;

  for (const u of due) {
    try {
      const result = await purgeUser(u.id);
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
