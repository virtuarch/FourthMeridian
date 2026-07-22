/**
 * jobs/purge-trash.ts
 *
 * Permanently deletes SpaceGoal rows that have been in the trash
 * (deletedAt IS NOT NULL) for more than 7 days.
 *
 * SCHEDULED (OPS-4 S3): registered in lib/jobs/registry.ts (07:30 UTC slot)
 * and executed through the dispatcher + runJob() — the first time this body
 * runs in production, making the 7-day goal-trash retention promise true
 * (dormant since the in-process scheduler was retired in S2, and never
 * invoked before that either). Safe to run multiple times — idempotent
 * (WHERE-guarded deleteMany against an absolute cutoff).
 */

import { db } from "@/lib/db";

const TRASH_RETENTION_DAYS = 7;

export interface PurgeTrashResult {
  /** Trashed goals permanently deleted this run (count only — S1 doctrine). */
  purgedGoals: number;
}

export async function purgeTrash(): Promise<PurgeTrashResult> {
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

  // Purge behavior unchanged (OPS-4 S3 rule); the count it already computed
  // is returned so the JobRun ledger records a meaningful summary.
  return { purgedGoals: result.count };
}
