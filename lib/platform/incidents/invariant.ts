/**
 * lib/platform/incidents/invariant.ts  (OPS-2D-5A-1)
 *
 * The lifecycle invariant, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "`resolved` is written in lockstep with `resolvedAt`" reads like a universal
 * rule, and it is not. It holds for CONDITIONS and is deliberately violated for
 * EVENTS — which are stored `resolved = true` with `resolvedAt = null`. Stated
 * loosely, that looks like a bug; stated precisely, it is the whole point:
 *
 *   `resolved = true` on a CONDITION means "this recovered, here is when".
 *   `resolved = true` on an EVENT means "this is terminal, nothing will change it".
 *
 * Two different meanings on one column, which is exactly the kind of thing that
 * gets "fixed" by someone stamping `resolvedAt = now` on events to make the data
 * uniform — and thereby turning forensic evidence into a recovery that never
 * happened. So the contract is written down and enforced at the write boundary
 * rather than left as a convention.
 *
 * THE CONTRACT
 * ------------
 *   CONDITION, active     resolved=false · resolvedAt=null · kind=null · exec=null
 *   CONDITION, resolved   resolved=true  · resolvedAt SET  · kind ∈ RESOLUTION_KINDS
 *                         OPERATOR_RESOLVED ⇒ resolvedById + resolutionAuditId (PB-1 S2)
 *                         SUBJECT_REMOVED   ⇒ resolutionEvidence.subject, no execution
 *   EVENT                 resolved=true  · resolvedAt=null · kind=null · exec=null
 *                         incidentKey=null (events never converge)
 *
 * NATURE STAYS DERIVED. This module takes nature as an argument; it never
 * classifies. `lib/platform/sync-issue-semantics.ts` remains the sole authority,
 * and `syncIssueState()` already reads nature BEFORE `resolved`, so an event
 * projects as `evidence` and can never project as `recovered`. This invariant
 * protects the WRITE side of that same distinction.
 */

import type { SyncIssueNature } from "@/lib/platform/sync-issue-semantics";

/**
 * PB-1 S2 — every resolution kind a CONDITION may be closed with. Declared here
 * (the pure contract) and re-exported by lifecycle.ts, which is the only writer.
 *
 *   AUTOMATIC_RECOVERY  evidence that the same operation succeeded for the same subject
 *   OPERATOR_RESOLVED   an operator closed it, with a reason (writer: S6)
 *   SUBJECT_REMOVED     the account / item it observed was removed — NEVER a recovery
 */
export const RESOLUTION_KINDS = ["AUTOMATIC_RECOVERY", "OPERATOR_RESOLVED", "SUBJECT_REMOVED"] as const;
export type ResolutionKindValue = (typeof RESOLUTION_KINDS)[number];

/** §12 P3 — the five PERSISTED lifecycle states (REOPENED is display-only). Mirrors the migration CHECK. */
export const LIFECYCLE_STATES = ["ACTIVE", "ACKNOWLEDGED", "RECOVERING", "STALE", "RESOLVED"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** §5 — how a removed subject was observed. */
export const REMOVED_SUBJECT_STATES = ["DELETED", "REVOKED", "MISSING"] as const;
export type RemovedSubjectState = (typeof REMOVED_SUBJECT_STATES)[number];

/** The lifecycle-bearing fields of one episode row. PB-1 S2 fields are optional (absent ≡ null). */
export interface LifecycleFields {
  resolved: boolean;
  resolvedAt: Date | null;
  resolutionKind: string | null;
  resolvingExecutionId: string | null;
  incidentKey: string | null;
  lifecycleState?: string | null;
  resolutionReasonCode?: string | null;
  resolvedById?: string | null;
  resolutionAuditId?: string | null;
  resolutionEvidence?: unknown;
}

/** True when `evidence.subject` is a well-formed §5 removed-subject record. */
export function isRemovedSubjectEvidence(evidence: unknown): boolean {
  if (typeof evidence !== "object" || evidence === null) return false;
  const subject = (evidence as { subject?: unknown }).subject;
  if (typeof subject !== "object" || subject === null) return false;
  const s = subject as Record<string, unknown>;
  return (s.kind === "PLAID_ITEM" || s.kind === "FINANCIAL_ACCOUNT")
    && typeof s.id === "string" && s.id !== ""
    && (REMOVED_SUBJECT_STATES as readonly unknown[]).includes(s.state)
    && typeof s.observedAt === "string" && Number.isFinite(Date.parse(s.observedAt));
}

/**
 * Why a proposed write is invalid, or null when it is sound.
 *
 * Returns a REASON rather than throwing: the detection service's contract is
 * "never throws", and a telemetry write must not become a second failure. The
 * caller logs and refuses the write.
 */
export function lifecycleViolation(
  nature: SyncIssueNature,
  f: LifecycleFields,
): string | null {
  if (nature === "event") {
    // Terminal evidence. Any resolution field on an event asserts a recovery
    // that cannot exist — a later clean run does not unmake an observation.
    if (f.resolvedAt !== null)           return "EVENT must not carry resolvedAt";
    if (f.resolutionKind !== null)       return "EVENT must not carry a resolutionKind";
    if (f.resolvingExecutionId !== null) return "EVENT must not carry a resolvingExecutionId";
    if (f.incidentKey !== null)          return "EVENT must not carry an incidentKey (events never converge)";
    if (f.resolved !== true)             return "EVENT must be stored terminal (resolved=true)";
    if ((f.lifecycleState ?? null) !== null) return "EVENT must not carry a lifecycleState (events are not episodes)";
    if ((f.resolvedById ?? null) !== null || (f.resolutionAuditId ?? null) !== null) return "EVENT must not carry an operator resolution";
    if ((f.resolutionEvidence ?? null) !== null) return "EVENT must not carry resolutionEvidence";
    return null;
  }

  const state = f.lifecycleState ?? null;
  if (state !== null && !(LIFECYCLE_STATES as readonly string[]).includes(state)) return `unknown lifecycleState "${state}"`;
  if (state !== null && (state === "RESOLVED") !== f.resolved) return "lifecycleState RESOLVED must move with resolved";
  // Mirrors SyncIssue_resolved_state_reason_check: a RESOLVED state names its reason.
  if (state === "RESOLVED" && !(f.resolutionReasonCode ?? null)) return "lifecycleState RESOLVED must carry a resolutionReasonCode";

  // CONDITION — here `resolved` and `resolvedAt` genuinely do move together.
  if (f.resolved && f.resolvedAt === null)  return "recovered CONDITION must carry resolvedAt";
  if (!f.resolved && f.resolvedAt !== null) return "active CONDITION must not carry resolvedAt";
  if (!f.resolved && f.resolutionKind !== null) return "active CONDITION must not carry a resolutionKind";
  if (!f.resolved && f.resolvingExecutionId !== null) return "active CONDITION must not carry a resolvingExecutionId";
  if (f.resolved && f.resolutionKind === null)  return "recovered CONDITION must name its resolution kind";
  if (!f.resolved && ((f.resolvedById ?? null) !== null || (f.resolutionAuditId ?? null) !== null)) {
    return "active CONDITION must not carry an operator resolution";
  }
  if (f.resolved && !(RESOLUTION_KINDS as readonly string[]).includes(f.resolutionKind!)) {
    return `unknown resolution kind "${f.resolutionKind}"`;
  }
  if (f.resolutionKind === "OPERATOR_RESOLVED") {
    if (!f.resolvedById)      return "OPERATOR_RESOLVED must carry resolvedById";
    if (!f.resolutionAuditId) return "OPERATOR_RESOLVED must carry resolutionAuditId";
  }
  if (f.resolutionKind === "SUBJECT_REMOVED") {
    // A removal is not evidence that anything recovered, so it names no run.
    if (f.resolvingExecutionId !== null)                return "SUBJECT_REMOVED must not carry a resolvingExecutionId";
    if (!isRemovedSubjectEvidence(f.resolutionEvidence)) return "SUBJECT_REMOVED must carry resolutionEvidence.subject {kind,id,state,observedAt}";
  }
  return null;
}

/**
 * COMPATIBILITY, not enforcement.
 *
 * The rules above bind rows WRITTEN by this lifecycle. Legacy rows predate it
 * and must not be judged by it: a legacy `resolved = true` carries no
 * `resolvedAt`, because before this slice there was no such column. Reading that
 * as an invariant violation would flag most of the existing table; reading it as
 * "this must be an event" would be worse still — nature is derived from the row,
 * and plenty of legacy CONDITIONS are resolved with no recorded time.
 *
 * So a legacy recovered condition is exactly that: recovered, at an unknown
 * time. The projection renders the null honestly instead of inventing a
 * timestamp, and no row is rewritten to satisfy a rule that did not exist when
 * it was written.
 */
export function isLegacyRow(f: Pick<LifecycleFields, "incidentKey">, occurrenceCount: number): boolean {
  return f.incidentKey === null && occurrenceCount === 0;
}
