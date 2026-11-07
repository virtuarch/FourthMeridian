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
 * PURE and built FIELD BY FIELD. PB-1 R6a: the input is the incident-intelligence
 * module's Ops-tier verdict (identity-free); this never spreads it, so a field
 * added upstream cannot ride along into a PLATFORM_OPS payload by accident.
 * Severity, state, freshness, brokenNow and label are READ from the verdict,
 * never re-derived — a second classifier is exactly what the module exists to
 * prevent.
 */

import type { IncidentSubject } from "./preview-core";
import type { Freshness, IncidentState, IncidentVerdict, Severity } from "./intelligence/types";
import type { SyncIssueDomain } from "@/lib/platform/sync-issue-semantics";

export interface PlatformIncidentProjection {
  /** Episode id — an opaque row id, for keys and navigation. Never a customer id. */
  id: string;
  /** Canonical operator label (the module's, from the semantics authority). */
  label: string;
  /** Which operation failed, in operator words; null when not provable. */
  operationLabel: string | null;
  /** "Chase · Checking", "Chase", or null when the platform genuinely does not know. */
  subject: string | null;
  domain: SyncIssueDomain;
  /** The classified severity (the module's). */
  severity: Severity;
  /** The module's attention severity: one notch lower for an `unverified` incident (D10); else = severity. */
  effectiveSeverity: Severity;
  /** The module's window verdict: current / unverified (stale never reaches a broken-now page). */
  freshness: Freshness;
  /** The module's derived state (active / acknowledged / recovering on a broken-now page). */
  state: IncidentState;
  /** The module's "broken now" verdict — the ONLY open/closed signal attention reads. */
  brokenNow: boolean;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  occurrenceCount: number;
  occurrenceCountKnown: boolean;
  /** The newest correlated execution, or null when no occurrence names one. */
  refreshExecutionId: string | null;
}

/** "Institution · Account" — the only customer-adjacent text D5 permits. */
export function subjectLabel(subject: IncidentSubject): string | null {
  const parts = [subject.primary, subject.secondary].filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return parts.length ? parts.join(" · ") : null;
}

/**
 * PB-1 R6a — one module verdict (Ops tier) → the PLATFORM_OPS projection, field
 * by field. Never spreads the verdict, so `subjectUserId` (a CS-tier field), the
 * opaque item / account ids and anything added to the verdict later cannot ride
 * along into a PLATFORM_OPS payload.
 */
export function projectVerdictForPlatform(
  v: IncidentVerdict,
  subject: IncidentSubject,
  refreshExecutionId: string | null,
): PlatformIncidentProjection {
  return {
    id: v.id,
    label: v.label,
    operationLabel: v.operationLabel,
    subject: subjectLabel(subject),
    domain: v.domain as SyncIssueDomain,
    severity: v.severity,
    effectiveSeverity: v.effectiveSeverity,
    freshness: v.freshness,
    state: v.state,
    brokenNow: v.brokenNow,
    firstOccurredAt: v.firstSeenAt || null,
    lastOccurredAt: v.lastSeenAt || null,
    occurrenceCount: v.occurrenceCount,
    // A converged episode always has at least one occurrence; zero = pre-OPS-2D-5A-1 row, depth unknown.
    occurrenceCountKnown: v.occurrenceCount > 0,
    refreshExecutionId,
  };
}

/** The keys a PLATFORM_OPS incident payload may carry — pinned by the test. */
export const PLATFORM_INCIDENT_KEYS = [
  "id", "label", "operationLabel", "subject", "domain", "severity", "effectiveSeverity", "freshness", "state", "brokenNow",
  "firstOccurredAt", "lastOccurredAt", "occurrenceCount", "occurrenceCountKnown", "refreshExecutionId",
] as const;
