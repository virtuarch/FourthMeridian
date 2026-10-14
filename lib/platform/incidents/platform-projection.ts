/**
 * lib/platform/incidents/platform-projection.ts  (UX-P1 · owner decision D5)
 *
 * THE PLATFORM_OPS VIEW OF AN ACTIVE INCIDENT — identity-minimized.
 *
 * Sync incidents are a Customer Success read (the preview route is CS READ) and
 * their canonical projection names the customer's institution and account. The
 * Overview's Attention Required table is PLATFORM_OPS READ, which must never
 * carry a customer, an email or a userId. Owner decision D5 approves ONE narrow
 * projection for it: the SUBJECT as an institution · account label (the same
 * two strings an operator sees on a connection-health row), the semantics
 * authority's severity and state, the lifecycle timestamps, the occurrence
 * depth and — when a real RefreshExecution is correlated — that execution's id
 * as evidence. Nothing else.
 *
 * PURE and built FIELD BY FIELD. The input is the preview item the CS path
 * already shaped (`toPreviewItem`), which itself carries no customer identity;
 * this never spreads it, so a field added upstream cannot ride along into a
 * PLATFORM_OPS payload by accident. Severity, state and label are READ from the
 * item, never re-derived — a second classifier is exactly what the semantics
 * authority exists to prevent.
 */

import type { IncidentPreviewItem, IncidentSubject } from "./preview-core";
import type { SyncIssueDomain, SyncIssueSeverity, SyncIssueState, IncidentRecovery } from "@/lib/platform/sync-issue-semantics";

export interface PlatformIncidentProjection {
  /** Episode id — an opaque row id, for keys and navigation. Never a customer id. */
  id: string;
  /** Canonical operator label from the semantics authority. */
  label: string;
  /** Which operation failed, in operator words; null when not provable. */
  operationLabel: string | null;
  /** "Chase · Checking", "Chase", or null when the platform genuinely does not know. */
  subject: string | null;
  domain: SyncIssueDomain;
  severity: SyncIssueSeverity;
  state: SyncIssueState;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  occurrenceCount: number;
  occurrenceCountKnown: boolean;
  recovery: IncidentRecovery;
  /** The newest correlated execution, or null when no occurrence names one. */
  refreshExecutionId: string | null;
}

/** "Institution · Account" — the only customer-adjacent text D5 permits. */
export function subjectLabel(subject: IncidentSubject): string | null {
  const parts = [subject.primary, subject.secondary].filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return parts.length ? parts.join(" · ") : null;
}

export function projectIncidentForPlatform(
  item: IncidentPreviewItem,
  refreshExecutionId: string | null,
): PlatformIncidentProjection {
  return {
    id: item.id,
    label: item.title,
    operationLabel: item.operationLabel,
    subject: subjectLabel(item.subject),
    domain: item.domain,
    severity: item.severity,
    state: item.state,
    firstOccurredAt: item.firstOccurredAt || null,
    lastOccurredAt: item.lastOccurredAt || null,
    occurrenceCount: item.occurrenceCount,
    occurrenceCountKnown: item.occurrenceCountKnown,
    recovery: item.recovery,
    refreshExecutionId,
  };
}

/** The keys a PLATFORM_OPS incident payload may carry — pinned by the test. */
export const PLATFORM_INCIDENT_KEYS = [
  "id", "label", "operationLabel", "subject", "domain", "severity", "state",
  "firstOccurredAt", "lastOccurredAt", "occurrenceCount", "occurrenceCountKnown", "recovery", "refreshExecutionId",
] as const;
