/**
 * lib/activity/member-incidents.ts  (PB-1 Phase 3 — the MEMBER activity feed's incident verdicts)
 *
 * The Space activity route reads SyncIssue AS THE MEMBER (fm_app under
 * withTenantDb, RLS) and fm_app can read only six columns of it (migration
 * 20261002000500): id, kind, resolved, createdAt, financialAccountId,
 * plaidTransactionId. The intelligence module's loaders run as fm_system and
 * bypass RLS, so this route must never call them. Instead (S2-approved design,
 * option a) it hands what it COULD read to the module's PURE core:
 *
 *   tenant rows ─▶ memberIncidentFacts ─▶ deriveIncidentVerdicts(audience "MEMBER")
 *               ─▶ memberIncidentEventsOf ─▶ { id, kind, at }  (identity-free, pinned)
 *
 * WHAT THE READABLE COLUMNS CAN AND CANNOT HONOUR (stated, not hidden):
 *   D1   honoured — nature comes from `kind` (a tombstone / BALANCE_TX_MISMATCH with no
 *        detail reads as evidence / superseded: closed).
 *   D2   honoured by SCOPE — the route reads only rows on the Space's ACTIVE links to
 *        non-deleted accounts; the core is told nothing about subjects (`unscoped`).
 *   D2b  NOT honoured (S2 ruling) — `plaidItemId` is always null: SyncIssue.plaidItemId
 *        is not granted, and fm_app sees only the viewer's own PlaidItems, so passing an
 *        item the core cannot see would read MISSING ⇒ removed ⇒ a FALSE closure.
 *   D3   honoured — plaidTransactionId is granted and classified.
 *   D7   degraded — firstOccurredAt is not granted, so `at` is createdAt (as before).
 *   D8   not honoured — incidentKey is not granted; each row is its own event.
 *   D10  not honoured — lastOccurredAt and the attempt ledger are not readable; no attempt
 *        evidence is supplied, so the module's own rule applies: UNKNOWN never hides a row.
 *   Lifecycle (acknowledged / recovering) columns are fm_system-only; both are broken now.
 *
 * PROVIDER. `provider` is not granted. Every row reaching here has a non-null
 * plaidTransactionId (the route's WHERE), and only the Plaid bank-transaction
 * producers set that column (both pinned), so the provider is PLAID — which is
 * also the classifier's own default.
 *
 * PURE: no DB, no clock read.
 */

import { deriveIncidentVerdicts } from "@/lib/platform/incidents/intelligence/core";
import type { IncidentFacts, IncidentRowFacts, IncidentVerdict } from "@/lib/platform/incidents/intelligence/types";

/** Exactly what the route selects (the RLS-16 grant, minus financialAccountId which is only in its WHERE). */
export interface MemberSyncIssueRow {
  id: string;
  kind: string;
  resolved: boolean;
  createdAt: Date;
  plaidTransactionId: string | null;
}

/** The member-facing incident event — identity-free, nothing else (pinned). */
export interface MemberIncidentEvent {
  id: string;
  kind: string;
  /** ISO instant the member sees (createdAt — D7 degraded, firstOccurredAt is not readable). */
  at: string;
}
export const MEMBER_INCIDENT_EVENT_KEYS = ["id", "kind", "at"] as const;

/** Tenant rows → the module's facts. Every unreadable column is EXPLICITLY null. */
export function memberIncidentFacts(rows: readonly MemberSyncIssueRow[]): IncidentFacts {
  const facts: IncidentRowFacts[] = rows.map((r) => ({
    id: r.id, kind: r.kind,
    // Implied by plaidTransactionId != null (route WHERE + producer census, both pinned).
    provider: "PLAID",
    // D2b stays out (S2): never name an item the member's RLS cannot see.
    plaidItemId: null,
    // D2 is the route's scope (active links, non-deleted accounts); the core is told nothing.
    financialAccountId: null,
    plaidTransactionId: r.plaidTransactionId,
    detail: null, resolved: r.resolved, incidentKey: null, previousIncidentId: null,
    createdAt: r.createdAt, firstOccurredAt: null, lastOccurredAt: null,
    resolvedAt: null, resolutionKind: null, resolutionReasonCode: null,
    lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null,
    subjectUserId: null, causeStatus: null, causeCode: null, evidence: null,
    occurrenceCount: 0, correlatedOccurrenceCount: 0,
  }));
  // No attempts map: attempt evidence is UNKNOWN, which never hides a row (D10 not applied).
  return { rows: facts, subjects: { items: new Map(), accounts: new Map() }, scanTruncated: false };
}

/** Verdicts → member events: a real incident, broken now, and member-actionable. Field by field. */
export function memberIncidentEventsOf(verdicts: readonly IncidentVerdict[]): MemberIncidentEvent[] {
  return verdicts
    .filter((v) => v.rowClass === "incident" && v.brokenNow && v.customerActionable)
    .map((v) => ({ id: v.id, kind: v.kind, at: v.firstSeenAt }));
}

/** The whole pure path the route calls. */
export function memberIncidentEvents(rows: readonly MemberSyncIssueRow[], now: Date): MemberIncidentEvent[] {
  return memberIncidentEventsOf(deriveIncidentVerdicts(memberIncidentFacts(rows), { now, audience: "MEMBER" }).all);
}
