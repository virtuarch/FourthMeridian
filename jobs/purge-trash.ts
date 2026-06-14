/**
 * jobs/purge-trash.ts
 *
 * Permanently deletes WorkspaceGoal rows that have been in the trash
 * (deletedAt IS NOT NULL) for more than 7 days.
 *
 * Run daily via the scheduler. Safe to run multiple times — idempotent.
 */

import { db } from "@/lib/db";

const TRASH_RETENTION_DAYS = 7;

export async function purgeTrash(): Promise<void> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (db as any).workspaceGoal.deleteMany({
    where: {
      deletedAt: { not: null, lte: cutoff },
    },
  });

  if (result.count > 0) {
    console.log(`[purge-trash] Permanently deleted ${result.count} goal(s) older than ${TRASH_RETENTION_DAYS} days.`);
  }
}
