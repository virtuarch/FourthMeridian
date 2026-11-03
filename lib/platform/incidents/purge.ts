/**
 * lib/platform/incidents/purge.ts  (PB-1 Phase 1 — incident data on account deletion)
 *
 * When a customer's account is purged (lib/account-deletion/purge.ts), every
 * incident row ABOUT them goes with it: the live episodes and their
 * occurrences, their events, every relation edge touching them (either end),
 * and the archive summaries — plus the archived episodes' events/relations.
 *
 * ── BLOCKER 1 — LEGACY ROWS HAVE NO subjectUserId ────────────────────────────
 * Rows written before Phase 1 carry `subjectUserId = NULL` (there is no
 * backfill), so the set is matched on ANY of:
 *   - SyncIssue.subjectUserId = the user
 *   - SyncIssue.plaidItemId ∈ the user's Items (any status)
 *   - SyncIssue.financialAccountId ∈ the user's accounts
 *   - an occurrence's subjectAccountId ∈ the user's accounts
 * Refs held only in an occurrence's `detail` belong to an item-scoped episode,
 * which the row's own plaidItemId already matches. The archive is matched the
 * same way on its own columns.
 *
 * The set is RESOLVED before the purge deletes the user's Item and account
 * rows (it needs them), and DELETED inside the purge's destructive-tail
 * transaction, so a cancelled or crashed purge deletes nothing and a committed
 * one leaves nothing. Provider-wide history with no customer subject is
 * untouched.
 *
 * This module and jobs-side retention (retention.ts) are the ONLY code that
 * may delete SyncIssueEvent rows (incident-boundary.test.ts).
 */

import "server-only";

type IdRows = Promise<{ id: string }[]>;

/** Reads the set needs (run on the purge client, before the destructive tail). */
export interface IncidentPurgeReader {
  syncIssue: { findMany(args: { where: Record<string, unknown>; select: { id: true } }): IdRows };
  syncIssueArchive: { findMany(args: { where: Record<string, unknown>; select: { id: true; incidentId: true } }): Promise<{ id: string; incidentId: string }[]> };
}

/** Deletes, run on the destructive tail's transaction client. */
export interface IncidentPurgeTx {
  syncIssueEvent: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  syncIssueRelation: {
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    updateMany(args: { where: Record<string, unknown>; data: { createdById: null } }): Promise<{ count: number }>;
  };
  syncIssue: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
  syncIssueArchive: { deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> };
}

export interface IncidentPurgeScope {
  userId: string;
  plaidItemIds: readonly string[];
  financialAccountIds: readonly string[];
}

export interface IncidentPurgeSet {
  userId: string;
  /** Live SyncIssue ids (occurrences cascade). */
  incidentIds: string[];
  /** SyncIssueArchive row ids. */
  archiveIds: string[];
  /** The incident ids those archive rows summarise (for their events / relations). */
  archivedIncidentIds: string[];
}

export interface IncidentPurgeCounts {
  incidents: number;
  archives: number;
  events: number;
  relations: number;
}

/** THE match — exported so the census and the lifecycle test pin one definition. */
export function incidentPurgeWhere(scope: IncidentPurgeScope): Record<string, unknown> {
  const items = [...new Set(scope.plaidItemIds)];
  const accounts = [...new Set(scope.financialAccountIds)];
  return {
    OR: [
      { subjectUserId: scope.userId },
      ...(items.length ? [{ plaidItemId: { in: items } }] : []),
      ...(accounts.length ? [{ financialAccountId: { in: accounts } }] : []),
      ...(accounts.length ? [{ occurrences: { some: { subjectAccountId: { in: accounts } } } }] : []),
    ],
  };
}

export function archivePurgeWhere(scope: IncidentPurgeScope): Record<string, unknown> {
  const items = [...new Set(scope.plaidItemIds)];
  const accounts = [...new Set(scope.financialAccountIds)];
  return {
    OR: [
      { subjectUserId: scope.userId },
      ...(items.length ? [{ plaidItemId: { in: items } }] : []),
      ...(accounts.length ? [{ financialAccountId: { in: accounts } }] : []),
    ],
  };
}

/** Resolve the set — BEFORE the user's Item / account rows are deleted. */
export async function resolveIncidentPurgeSet(client: IncidentPurgeReader, scope: IncidentPurgeScope): Promise<IncidentPurgeSet> {
  const [live, archived] = await Promise.all([
    client.syncIssue.findMany({ where: incidentPurgeWhere(scope), select: { id: true } }),
    client.syncIssueArchive.findMany({ where: archivePurgeWhere(scope), select: { id: true, incidentId: true } }),
  ]);
  return {
    userId: scope.userId,
    incidentIds: live.map((r) => r.id),
    archiveIds: archived.map((r) => r.id),
    archivedIncidentIds: archived.map((r) => r.incidentId),
  };
}

/** Delete the set — inside the purge's destructive-tail transaction. Throws on any failure (the tail rolls back). */
export async function purgeIncidentSet(tx: IncidentPurgeTx, set: IncidentPurgeSet): Promise<IncidentPurgeCounts> {
  const all = [...new Set([...set.incidentIds, ...set.archivedIncidentIds])];
  const counts: IncidentPurgeCounts = { incidents: 0, archives: 0, events: 0, relations: 0 };
  if (all.length) {
    counts.events = (await tx.syncIssueEvent.deleteMany({ where: { incidentId: { in: all } } })).count;
    counts.relations = (await tx.syncIssueRelation.deleteMany({
      where: { OR: [{ fromIncidentId: { in: all } }, { toIncidentId: { in: all } }] },
    })).count;
  }
  if (set.incidentIds.length) counts.incidents = (await tx.syncIssue.deleteMany({ where: { id: { in: set.incidentIds } } })).count;
  if (set.archiveIds.length) counts.archives = (await tx.syncIssueArchive.deleteMany({ where: { id: { in: set.archiveIds } } })).count;
  // The user as an OPERATOR who linked two other customers' incidents: actor
  // identity on someone else's record — scrubbed, the link kept.
  await tx.syncIssueRelation.updateMany({ where: { createdById: set.userId }, data: { createdById: null } });
  return counts;
}
