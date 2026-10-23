/**
 * lib/alerts/sync-incidents.ts  (OBS-004)
 *
 * The PURE fold from the incident projection's IncidentView rows to the
 * engine's minimal slice (AlertSyncIncident). Keeps opaque ids, the kind, the
 * derived domain/severity and counts; drops everything else — in particular
 * nothing from `detail` ever existed on the view, and no label reaches the
 * alert payload. The projection already filtered to state "active"; this
 * keeps only those in case a caller hands a wider page.
 */

import type { IncidentView } from "@/lib/platform/incidents/projections";
import type { AlertSyncIncident, SyncIncidentHealth } from "@/lib/alerts/authorities";

export function foldSyncIncidents(
  incidents: readonly Pick<IncidentView, "id" | "kind" | "plaidItemId" | "state" | "classification" | "lastOccurredAt" | "occurrenceCount">[],
  scanTruncated: boolean,
  now: Date,
): SyncIncidentHealth {
  const active: AlertSyncIncident[] = [];
  for (const i of incidents) {
    if (i.state !== "active") continue;
    active.push({
      id: i.id,
      plaidItemId: i.plaidItemId ?? null,
      kind: i.kind,
      domain: i.classification.domain,
      severity: i.classification.severity,
      lastOccurredAt: i.lastOccurredAt,
      occurrenceCount: i.occurrenceCount,
    });
  }
  return { checkedAt: now.toISOString(), active, scanTruncated };
}
