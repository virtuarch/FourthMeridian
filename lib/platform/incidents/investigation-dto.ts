/**
 * lib/platform/incidents/investigation-dto.ts  (PB-1 Phase 2B — the wire shapes, PURE + client-safe)
 *
 * What the incident investigation routes put on the wire, by TIER, through an
 * explicit ALLOWLIST of verdict fields. A route never serialises a verdict as
 * it came from the accessor: it projects it here. So the Platform Ops output is
 * identity-free STRUCTURALLY — even if a CUSTOMER_SUCCESS verdict reached an
 * Ops route (a System Admin's break-glass mints a CS token), `subjectUserId`
 * is not a field this projection copies for the "ops" tier.
 *
 * RECOVERY ACTIONS are only the EXISTING, audited operator routes:
 *   ops  resync          POST /api/platform/platform-ops/connections/[id]/resync          (PLATFORM_OPS WRITE, fresh)
 *        request-reauth  POST /api/platform/platform-ops/connections/[id]/request-reauth  (PLATFORM_OPS WRITE, fresh)
 *   cs   refresh-customer POST /api/platform/customer-success/customers/[userId]/refresh  (CUSTOMER_SUCCESS WRITE, fresh)
 * each recording through recordOperatorAction. Acknowledge / resolve / reopen
 * (the verdict's `availableActions`) have NO route yet (PB-1 S6), so they are
 * never offered. The offer is descriptive; the route's guard decides.
 */

import type {
  CsIncidentVerdict,
  IncidentAffected,
  IncidentArchiveState,
  IncidentInvestigation,
  IncidentLinkKind,
  IncidentSearchResult,
  IncidentTimeline,
  IncidentVerdict,
  ResolutionEvidenceDigest,
} from "./intelligence/types";

export type IncidentTier = "ops" | "cs";

/** One incident row on the wire. `subjectUserId` exists ONLY on the cs tier. */
export interface IncidentRowDTO {
  id: string;
  state: IncidentVerdict["state"];
  freshness: IncidentVerdict["freshness"];
  closure: IncidentVerdict["closure"];
  closureDerived: boolean;
  kind: string;
  provider: string;
  domain: string;
  severity: IncidentVerdict["severity"];
  effectiveSeverity: IncidentVerdict["effectiveSeverity"];
  operation: string | null;
  label: string;
  operationLabel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
  correlatedOccurrenceCount: number;
  duplicateOf: string | null;
  subjectState: IncidentVerdict["subjectState"];
  brokenNow: boolean;
  alertable: boolean;
  spread: IncidentVerdict["spread"];
  generation: number;
  recovery: IncidentVerdict["recovery"];
  causeStatus: IncidentVerdict["causeStatus"];
  causeCode: string | null;
  subjectUserId?: string | null;
}

export type RecoveryActionDTO =
  | { kind: "resync" | "request-reauth"; connectionId: string }
  | { kind: "refresh-customer"; userId: string };

export interface IncidentListDTO extends Omit<IncidentSearchResult, "items"> {
  tier: IncidentTier;
  items: IncidentRowDTO[];
  checkedAt: string;
  /** The requested `from` was older than the archive retention and was clamped. */
  fromClamped: boolean;
}

export interface IncidentDetailDTO {
  tier: IncidentTier;
  incident: IncidentRowDTO;
  evidence: ResolutionEvidenceDigest | null;
  resolutionReasonCode: string | null;
  timeline: IncidentTimeline;
  affected: IncidentAffected;
  related: { id: string; kind: IncidentLinkKind; incident: IncidentRowDTO | null }[];
  recurrences: IncidentRowDTO[];
  recurrencesTruncated: boolean;
  archive: IncidentArchiveState;
  recovery: RecoveryActionDTO[];
  checkedAt: string;
}

/** THE allowlist projection. Copies named fields only; identity only for the cs tier. */
export function incidentRowDTO(v: IncidentVerdict | CsIncidentVerdict, tier: IncidentTier): IncidentRowDTO {
  const row: IncidentRowDTO = {
    id: v.id, state: v.state, freshness: v.freshness, closure: v.closure, closureDerived: v.closureDerived,
    kind: v.kind, provider: v.provider, domain: v.domain, severity: v.severity, effectiveSeverity: v.effectiveSeverity,
    operation: v.operation, label: v.label, operationLabel: v.operationLabel,
    firstSeenAt: v.firstSeenAt, lastSeenAt: v.lastSeenAt, resolvedAt: v.resolvedAt,
    occurrenceCount: v.occurrenceCount, correlatedOccurrenceCount: v.correlatedOccurrenceCount,
    duplicateOf: v.duplicateOf, subjectState: v.subjectState, brokenNow: v.brokenNow, alertable: v.alertable,
    spread: { groupKey: v.spread.groupKey, spread: v.spread.spread, affectedSubjects: v.spread.affectedSubjects },
    generation: v.recurrence.generation,
    recovery: { ...v.recovery },
    causeStatus: v.causeStatus, causeCode: v.causeCode,
  };
  if (tier === "cs") row.subjectUserId = "subjectUserId" in v ? v.subjectUserId : null;
  return row;
}

const OPEN_STATES: ReadonlySet<IncidentVerdict["state"]> = new Set(["active", "acknowledged", "recovering", "stale-unverified"]);

/**
 * The EXISTING recovery routes that apply to this incident, for this tier.
 * Ops: a live PLAID item subject of an open incident — resync unless the
 * credential is dead (the route refuses NEEDS_REAUTH / REVOKED with 409), and
 * request-reauth only when the item is already in a credential-problem state
 * (NEEDS_REAUTH / ERROR — never on a healthy connection from an incident page).
 * CS: an open incident attributed to a customer — that customer's Refresh all.
 * Closed, archived or unattributed ⇒ none.
 */
export function recoveryActionsFor(
  inv: Pick<IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "verdict" | "affected">,
  tier: IncidentTier,
): RecoveryActionDTO[] {
  const v = inv.verdict;
  if (v.rowClass !== "incident" || !OPEN_STATES.has(v.state)) return [];
  if (tier === "cs") {
    const userId = "subjectUserId" in v ? v.subjectUserId : null;
    return userId ? [{ kind: "refresh-customer", userId }] : [];
  }
  if (v.provider !== "PLAID" || !v.plaidItemId || v.subjectState !== "LIVE") return [];
  const status = inv.affected.itemStatus;
  const out: RecoveryActionDTO[] = [];
  if (status === "ACTIVE" || status === "ERROR") out.push({ kind: "resync", connectionId: v.plaidItemId });
  if (status === "NEEDS_REAUTH" || status === "ERROR") out.push({ kind: "request-reauth", connectionId: v.plaidItemId });
  return out;
}

export function incidentListDTO(r: IncidentSearchResult<IncidentVerdict | CsIncidentVerdict>, tier: IncidentTier, now: Date, fromClamped: boolean): IncidentListDTO {
  return {
    tier, items: r.items.map((v) => incidentRowDTO(v, tier)), total: r.total, page: r.page, pageSize: r.pageSize,
    truncated: r.truncated, scanned: r.scanned, facets: r.facets, checkedAt: now.toISOString(), fromClamped,
  };
}

export function incidentDetailDTO(inv: IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, tier: IncidentTier, now: Date): IncidentDetailDTO {
  return {
    tier,
    incident: incidentRowDTO(inv.verdict, tier),
    evidence: inv.evidence ? { ...inv.evidence } : null,
    resolutionReasonCode: inv.resolutionReasonCode,
    timeline: { source: inv.timeline.source, truncated: inv.timeline.truncated, events: inv.timeline.events.map((e) => ({ ...e })) },
    affected: { ...inv.affected },
    related: inv.related.map((l) => ({ id: l.id, kind: l.kind, incident: l.incident ? incidentRowDTO(l.incident, tier) : null })),
    recurrences: inv.recurrences.map((v) => incidentRowDTO(v, tier)),
    recurrencesTruncated: inv.recurrencesTruncated,
    archive: { ...inv.archive },
    recovery: recoveryActionsFor(inv, tier),
    checkedAt: now.toISOString(),
  };
}
