/**
 * lib/activity/normalize-sync-issue.ts
 *
 * Pure producer: SyncIssue row → normalized TimelineEvent (or null).
 *
 * Part of the Activity Tab event-feed Phase 1 (see plan §2.6). Surfaces sync
 * *health* to members without turning the feed into an alarm log.
 *
 * Honesty / safety contract:
 *   - Only UNRESOLVED issues are events. A resolved issue already happened and
 *     was fixed; re-surfacing it as "problem!" the day after it was quietly
 *     resolved is dishonest urgency. Resolved issues are silently dropped — and
 *     we do NOT invert them into "issue resolved" positive-spin events either,
 *     because this data doesn't earn that framing.
 *   - Only member-meaningful, member-actionable kinds surface. MISSING_ACCOUNT
 *     and UPSERT_ERROR map to fix-oriented copy. REMOVED_TOMBSTONE and every
 *     internal/forensic/reserved kind (BALANCE_TX_MISMATCH, REPLAY_*,
 *     INSTRUMENT_IDENTITY_CONFLICT) are internal bookkeeping — dropped, exactly
 *     as REMOVED_TOMBSTONE is. We never invent copy for a kind the product hasn't
 *     defined a member-facing meaning for.
 *   - SyncIssue.detail is NEVER exposed. It may carry provider-internal
 *     identifiers. It is deliberately excluded from SyncIssueRow so it is
 *     structurally impossible for this function to read it into copy, and the
 *     route's `select` must never load it.
 *   - id is namespaced (`syncissue:<id>`) so it can never collide with an
 *     AuditLog or ImportBatch id in the merged feed.
 */

import type { TimelineEvent, TimelineTone } from "@/lib/timeline-types";

/**
 * The minimal SyncIssue shape this normalizer needs. Note the ABSENCE of
 * `detail` — it must never influence member-facing copy, so it isn't part of
 * the contract at all.
 */
export interface SyncIssueRow {
  id:        string;
  /** SyncIssueKind — only member-meaningful kinds produce an event. */
  kind:      string;
  resolved:  boolean;
  createdAt: Date;
}

/**
 * The only kinds surfaced to members, with calm, fix-oriented copy. A kind not
 * in this map (REMOVED_TOMBSTONE and all internal/reserved kinds) is dropped.
 */
const MEMBER_MEANINGFUL: Record<string, { title: string; tone: TimelineTone; subtitle: string }> = {
  MISSING_ACCOUNT: {
    title:    "Account sync incomplete",
    tone:     "warning",
    subtitle: "Reconnect this account to restore full sync",
  },
  UPSERT_ERROR: {
    title:    "Sync error",
    tone:     "danger",
    subtitle: "Some recent activity may be missing — reconnect to retry",
  },
};

export function normalizeSyncIssueEvent(issue: SyncIssueRow): TimelineEvent | null {
  // Resolved issues silently drop (no positive-spin inversion either).
  if (issue.resolved) return null;

  // Unknown / internal / reserved kinds (incl. REMOVED_TOMBSTONE) drop.
  const spec = MEMBER_MEANINGFUL[issue.kind];
  if (!spec) return null;

  return {
    id:       `syncissue:${issue.id}`,
    type:     `SYNC_ISSUE_${issue.kind}`,
    date:     issue.createdAt.toISOString(),
    icon:     "AlertTriangle",
    tone:     spec.tone,
    category: "connection",
    title:    spec.title,
    subtitle: spec.subtitle,
  };
}
