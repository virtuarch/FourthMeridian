/**
 * lib/platform/incidents/parity/module-adapter.ts  (PB-1 §13 — world → Phase-2 facts, TEST-ONLY)
 *
 * Feeds the shared fixture world to the Phase-2 module's PURE core
 * (deriveIncidentVerdicts) as the facts its loader would gather, so the gate
 * compares the module with every legacy reader on the same rows. No I/O.
 *
 * Mapping (loader parity, intelligence/index.ts):
 *   - rows are legacy-shaped (Phase-1 columns NULL, no stored evidence), so
 *     attribution goes through D4 (item owner, else account owner ?? createdBy);
 *   - a deleted item / hard-deleted account is ABSENT (missing ⇒ removed);
 *     a soft-deleted account carries deletedAt; a REVOKED item its status;
 *   - attempt evidence exists only where the row says "known-empty";
 *     everywhere else it is absent ⇒ UNKNOWN, as when the loader cannot read it.
 */

import { deriveIncidentVerdicts } from "@/lib/platform/incidents/intelligence/core";
import type {
  AttemptEvidence, IncidentAudience, IncidentFacts, IncidentRowFacts, IncidentVerdict,
} from "@/lib/platform/incidents/intelligence/types";
import type { World } from "./world";

export function worldToFacts(w: World): IncidentFacts {
  const rows: IncidentRowFacts[] = w.rows.map((r) => ({
    id: r.id, kind: r.kind, provider: r.provider,
    plaidItemId: r.plaidItemId, financialAccountId: r.financialAccountId, plaidTransactionId: r.plaidTransactionId,
    detail: r.detail, resolved: r.resolved, incidentKey: r.incidentKey, previousIncidentId: null,
    createdAt: r.createdAt, firstOccurredAt: r.firstOccurredAt, lastOccurredAt: r.lastOccurredAt,
    resolvedAt: r.resolved ? (r.lastOccurredAt ?? r.createdAt) : null, resolutionKind: null, resolutionReasonCode: null,
    lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null,
    subjectUserId: null, causeStatus: null, causeCode: null, evidence: null,
    occurrenceCount: 1, correlatedOccurrenceCount: 0,
  }));
  const items = new Map(w.items.filter((i) => !i.deleted).map((i) => [i.id, { status: i.status ?? "ACTIVE", userId: i.userId }] as const));
  const accounts = new Map(w.accounts.filter((a) => !a.hardDeleted).map((a) => [a.id, {
    deletedAt: a.softDeleted ? new Date(w.now.getTime() - 86_400_000) : null,
    ownerUserId: a.ownerUserId, createdByUserId: a.createdByUserId,
  }] as const));
  const attempts = new Map<string, AttemptEvidence>(
    w.rows.filter((r) => r.attempts === "known-empty").map((r) => [r.id, { known: true, lastAttemptAt: null, lastSkipAt: null }]),
  );
  return { rows, subjects: { items, accounts }, attempts, relations: [], scanTruncated: false };
}

/** The module's verdicts over the world, for one audience. */
export function moduleVerdicts(w: World, audience: IncidentAudience = "PLATFORM_OPS"): IncidentVerdict[] {
  return deriveIncidentVerdicts(worldToFacts(w), { now: w.now, audience }).all;
}
