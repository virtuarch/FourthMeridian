/**
 * lib/alerts/sync-incidents.ts  (OBS-004 · PB-1 Phase 2 R5)
 *
 * The PURE fold from the incident-intelligence module's verdicts to the
 * engine's minimal slice (AlertSyncIncident). The feed (lib/alerts/run.ts) is
 * `incidentAccessors.alertable(systemIncidentAudience(), …)`; this fold reads
 * the module's OWN `alertable` verdict (broken now, inside its window, not
 * recovering — PB-1 §13, D1/D2/D2b/D10 decided there) and never re-derives
 * open/closed: no `state`, no `resolved`, no referent rule, no SyncIssue row.
 * A non-alertable verdict handed in by a wider page is dropped.
 *
 * Keeps opaque ids, the kind, the module's domain/severity and counts; drops
 * everything else. The verdict's `label` (operator wording) and every customer
 * field never reach the slice, so nothing names an institution or a customer.
 */

import type { IncidentVerdict } from "@/lib/platform/incidents/intelligence/types";
import type { AlertSyncIncident, SyncIncidentHealth } from "@/lib/alerts/authorities";

/** The verdict fields the fold reads — nothing else from the module crosses into alerting. */
export type AlertFoldVerdict = Pick<
  IncidentVerdict,
  "id" | "kind" | "plaidItemId" | "domain" | "severity" | "alertable" | "lastSeenAt" | "occurrenceCount"
>;

export function foldSyncIncidents(
  verdicts: readonly AlertFoldVerdict[],
  scanTruncated: boolean,
  now: Date,
): SyncIncidentHealth {
  const active: AlertSyncIncident[] = [];
  for (const v of verdicts) {
    if (!v.alertable) continue;
    active.push({
      id: v.id,
      plaidItemId: v.plaidItemId ?? null,
      kind: v.kind,
      domain: v.domain,
      severity: v.severity,
      lastOccurredAt: v.lastSeenAt,
      occurrenceCount: v.occurrenceCount,
    });
  }
  return { checkedAt: now.toISOString(), active, scanTruncated };
}
