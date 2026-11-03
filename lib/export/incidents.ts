/**
 * lib/export/incidents.ts  (PB-1 Phase 1 — incident data in the subject-access export)
 *
 * A customer's data export (DSAR) carries the sync incidents ABOUT them — the
 * live episodes and the 13-month archive summaries — matched by the SAME rule
 * the account-deletion purge deletes them by (lib/platform/incidents/purge.ts),
 * so what is exported and what is erased cannot drift apart.
 *
 * ALLOWLIST ONLY: ids, kinds, operation, timestamps, counts, registry codes.
 * Never `detail`, never a provider message, never another customer's data.
 *
 * The incident tables are fm_system-only (operator forensics), so this reads
 * through `systemDb` — and only ever with this user's own ids, resolved here
 * from the ownership lens (Items they connected, accounts they own).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { parseIncidentKey } from "@/lib/platform/incidents/identity";
import { archivePurgeWhere, incidentPurgeWhere } from "@/lib/platform/incidents/purge";

/** Bound per section; the export is a beta-scale synchronous build. */
export const EXPORT_INCIDENT_LIMIT = 1000;

export interface ExportIncidents {
  live: Record<string, unknown>[];
  archived: Record<string, unknown>[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function readExportIncidents(userId: string): Promise<ExportIncidents> {
  const [items, accounts] = await Promise.all([
    systemDb.plaidItem.findMany({ where: { userId }, select: { id: true } }),
    systemDb.financialAccount.findMany({ where: { ownerUserId: userId }, select: { id: true } }),
  ]);
  const scope = { userId, plaidItemIds: items.map((i) => i.id), financialAccountIds: accounts.map((a) => a.id) };
  const [live, archived] = await Promise.all([
    systemDb.syncIssue.findMany({
      where: incidentPurgeWhere(scope),
      orderBy: { createdAt: "desc" },
      take: EXPORT_INCIDENT_LIMIT,
      select: {
        id: true, kind: true, provider: true, incidentKey: true, plaidItemId: true, financialAccountId: true,
        firstOccurredAt: true, lastOccurredAt: true, resolved: true, resolvedAt: true, resolutionKind: true,
        resolutionReasonCode: true, causeStatus: true, causeCode: true, createdAt: true,
        _count: { select: { occurrences: true } },
      },
    }),
    systemDb.syncIssueArchive.findMany({
      where: archivePurgeWhere(scope),
      orderBy: { archivedAt: "desc" },
      take: EXPORT_INCIDENT_LIMIT,
      select: {
        incidentId: true, kind: true, provider: true, operation: true, plaidItemId: true, financialAccountId: true,
        firstOccurredAt: true, lastOccurredAt: true, resolvedAt: true, resolutionKind: true,
        resolutionReasonCode: true, causeStatus: true, causeCode: true, occurrenceCount: true, archivedAt: true,
      },
    }),
  ]);
  return {
    live: live.map((r) => ({
      id: r.id, kind: String(r.kind), provider: r.provider, operation: parseIncidentKey(r.incidentKey)?.operation ?? null,
      plaidItemId: r.plaidItemId, financialAccountId: r.financialAccountId,
      firstOccurredAt: iso(r.firstOccurredAt ?? r.createdAt), lastOccurredAt: iso(r.lastOccurredAt ?? r.createdAt),
      resolved: r.resolved, resolvedAt: iso(r.resolvedAt), resolutionKind: r.resolutionKind,
      resolutionReasonCode: r.resolutionReasonCode, causeStatus: r.causeStatus, causeCode: r.causeCode,
      occurrenceCount: r._count.occurrences,
    })),
    archived: archived.map((r) => ({
      id: r.incidentId, kind: r.kind, provider: r.provider, operation: r.operation,
      plaidItemId: r.plaidItemId, financialAccountId: r.financialAccountId,
      firstOccurredAt: iso(r.firstOccurredAt), lastOccurredAt: iso(r.lastOccurredAt), resolvedAt: iso(r.resolvedAt),
      resolutionKind: r.resolutionKind, resolutionReasonCode: r.resolutionReasonCode,
      causeStatus: r.causeStatus, causeCode: r.causeCode, occurrenceCount: r.occurrenceCount, archivedAt: iso(r.archivedAt),
    })),
  };
}
