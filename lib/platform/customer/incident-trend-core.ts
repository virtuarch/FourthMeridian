/**
 * lib/platform/customer/incident-trend-core.ts  (PB-1 Phase 3 — the CS daily trend over module verdicts)
 *
 * The opened / resolved instants the Customer Success trend counts, from the
 * incident-intelligence module's verdicts ONLY — no SyncIssue row, no row → state
 * call, no referent rule here (they were episodes-core.ts + projections.ts).
 *
 * An EPISODE is a real incident (`rowClass === "incident"`; D1 — evidence and
 * superseded rows are never opened or resolved) that is not a folded legacy
 * duplicate of a newer open row (D8 — one episode, counted once), and whose
 * subject was not removed (`closure !== "connection-removed"`; D2 / D2b — the
 * trend never counted an orphaned row, and a removal is not a recovery).
 *   opened   = the module's firstSeenAt (D7: firstOccurredAt, else createdAt)
 *   resolved = the module's resolvedAt, for a resolved verdict (recovered,
 *              operator-resolved or legacy-resolved)
 * A stale-unverified incident (D10) is still an incident: it opened; it has not resolved.
 *
 * PURE: no I/O, no clock. Instants only — no id, account, item, label or customer leaves it.
 */

import type { IncidentVerdict } from "@/lib/platform/incidents/intelligence/types";

export interface TrendInstant {
  openedAt: Date;
  /** Set only for a resolved episode. */
  resolvedAt: Date | null;
}

export type TrendVerdict = Pick<IncidentVerdict, "rowClass" | "duplicateOf" | "state" | "closure" | "firstSeenAt" | "resolvedAt">;

export function incidentTrendInstants(verdicts: readonly TrendVerdict[]): TrendInstant[] {
  const out: TrendInstant[] = [];
  for (const v of verdicts) {
    if (v.rowClass !== "incident" || v.duplicateOf !== null || v.closure === "connection-removed") continue;
    const resolved = v.state === "resolved" && v.resolvedAt ? new Date(v.resolvedAt) : null;
    out.push({ openedAt: new Date(v.firstSeenAt), resolvedAt: resolved });
  }
  return out;
}
