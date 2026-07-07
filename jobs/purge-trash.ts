/**
 * jobs/purge-trash.ts
 *
 * Permanently deletes SpaceGoal rows that have been in the trash
 * (deletedAt IS NOT NULL) for more than 7 days.
 *
 * NOT YET SCHEDULED: the in-process scheduler that once registered this job
 * was retired dormant in OPS-4 S2 — this body has never run in production.
 * It registers with the dispatcher (lib/jobs/registry.ts) in OPS-4 S3, not
 * before. Safe to run multiple times — idempotent.
 */

import { db } from "@/lib/db";

const TRASH_RETENTION_DAYS = 7;

export async function purgeTrash(): Promise<void> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (db as any).spaceGoal.deleteMany({
    where: {
      deletedAt: { not: null, lte: cutoff },
    },
  });

  if (result.count > 0) {
    console.log(`[purge-trash] Permanently deleted ${result.count} goal(s) older than ${TRASH_RETENTION_DAYS} days.`);
  }
}
