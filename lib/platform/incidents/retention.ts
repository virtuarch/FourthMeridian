/**
 * lib/platform/incidents/retention.ts  (PB-1 Phase 1 — archive-on-prune)
 *
 * The 90-day SyncIssue prune (jobs/data-retention.ts) no longer deletes a
 * resolved episode outright: each batch is ONE transaction that
 *
 *   1. reads the batch through an explicit allowlist (never `detail`),
 *   2. copies a summary into SyncIssueArchive — `createMany skipDuplicates` on
 *      unique(incidentId), so a re-run after a crash never duplicates one,
 *   3. folds the episode's SyncIssueEvent rows into the archive's capped,
 *      code-only `eventTimeline`, then deletes those events,
 *   4. deletes the SyncIssue rows (occurrences cascade).
 *
 * Any failure rolls the whole batch back: a summary is never lost (no delete
 * without its archive) and never duplicated. The archive itself is retained
 * 13 months (the `syncIssueArchive` rule), SyncIssueRelation rows the same 13
 * months from creation (soft refs — they may name archived incidents).
 *
 * This module and purge.ts are the ONLY code that may delete SyncIssueEvent
 * rows (incident-boundary.test.ts).
 */

import "server-only";
import type { Prisma } from "@prisma/client";
import { buildArchiveRow, type ArchivableEvent, type ArchivableIncident } from "./archive-core";

/** The transaction-side accessors the prune uses (structural, so a test can fake them). */
export interface ArchivePruneTx {
  syncIssue: {
    findMany(args: Record<string, unknown>): Promise<Array<Omit<ArchivableIncident, "occurrenceCount" | "kind"> & { kind: unknown; _count: { occurrences: number } }>>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  syncIssueEvent: {
    findMany(args: Record<string, unknown>): Promise<Array<ArchivableEvent & { incidentId: string }>>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  syncIssueArchive: {
    createMany(args: { data: Prisma.SyncIssueArchiveCreateManyInput[]; skipDuplicates: true }): Promise<{ count: number }>;
  };
}

export interface ArchivePruneClient {
  $transaction<T>(fn: (tx: ArchivePruneTx) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/** The allowlisted read — `detail`, provider text and every free-text column are absent. */
export const ARCHIVE_SELECT = {
  id: true, incidentKey: true, provider: true, kind: true, plaidItemId: true, financialAccountId: true,
  subjectUserId: true, previousIncidentId: true, firstOccurredAt: true, lastOccurredAt: true, resolvedAt: true,
  resolutionKind: true, resolutionReasonCode: true, causeStatus: true, causeCode: true, resolutionEvidence: true,
  _count: { select: { occurrences: true } },
} as const;

/**
 * Archive then delete one batch, atomically. `where` is the retention
 * predicate, re-applied so a row that stopped qualifying is never touched.
 * Returns the number of SyncIssue rows deleted. Throws on failure (the job
 * records the rule as failed and the batch stays).
 */
export async function archiveAndPruneSyncIssues(
  client: ArchivePruneClient,
  ids: readonly string[],
  where: Record<string, unknown>,
): Promise<number> {
  if (ids.length === 0) return 0;
  return client.$transaction(async (tx) => {
    const rows = await tx.syncIssue.findMany({ where: { AND: [{ id: { in: [...ids] } }, where] }, select: ARCHIVE_SELECT });
    if (rows.length === 0) return 0;
    const rowIds = rows.map((r) => r.id);
    const events = await tx.syncIssueEvent.findMany({
      where: { incidentId: { in: rowIds } },
      orderBy: { at: "asc" },
      select: { incidentId: true, type: true, at: true, fromState: true, toState: true, causeCode: true, actionCode: true, outcomeCode: true },
    });
    const byIncident = new Map<string, ArchivableEvent[]>();
    for (const e of events) {
      const list = byIncident.get(e.incidentId) ?? [];
      list.push(e);
      byIncident.set(e.incidentId, list);
    }
    const data = rows.map((r) => {
      const a = buildArchiveRow({ ...r, kind: String(r.kind), occurrenceCount: r._count.occurrences }, byIncident.get(r.id) ?? []);
      return {
        ...a,
        resolutionEvidence: (a.resolutionEvidence ?? undefined) as Prisma.InputJsonValue | undefined,
        eventTimeline: (a.eventTimeline ?? undefined) as Prisma.InputJsonValue | undefined,
      };
    });
    await tx.syncIssueArchive.createMany({ data, skipDuplicates: true });
    await tx.syncIssueEvent.deleteMany({ where: { incidentId: { in: rowIds } } });
    const del = await tx.syncIssue.deleteMany({ where: { AND: [{ id: { in: rowIds } }, where] } });
    return del.count;
  }, { timeout: 60_000 });
}
