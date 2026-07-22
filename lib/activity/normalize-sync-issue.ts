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
 *   - Only member-meaningful, member-actionable issues surface. REMOVED_TOMBSTONE
 *     and every internal/forensic/reserved kind (BALANCE_TX_MISMATCH, REPLAY_*,
 *     INSTRUMENT_IDENTITY_CONFLICT) are internal bookkeeping — dropped. We never
 *     invent copy for a kind the product hasn't defined a member-facing meaning for.
 *   - PRE-V26-PLAID-CLOSE Phase 4: `kind` alone is NOT a sufficient gate.
 *     `UPSERT_ERROR` also covers investment-repair, import-rollback and BTC
 *     wallet failures, and this feed was telling members to "reconnect" their
 *     bank over an internal instrument-repair retry. Those are operator
 *     concerns with no member action, so they are now EXCLUDED OUTRIGHT rather
 *     than merely reworded — noise in this feed erodes trust in every other
 *     message it carries. The caller derives `customerActionable` via
 *     lib/platform/sync-issue-semantics.ts (the one authority) and passes it in;
 *     `detail` stays out of this module's contract entirely.
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
 * Copy for the kinds that CAN be member-facing. Membership additionally requires
 * `customerActionable` from the semantics authority — this map alone would let
 * an investment-repair UPSERT_ERROR through.
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

export function normalizeSyncIssueEvent(
  issue: SyncIssueRow,
  /**
   * Phase 4 — the caller's verdict from lib/platform/sync-issue-semantics.ts.
   * Defaults to `true` so existing behaviour for the two transaction kinds is
   * unchanged when a caller has not been migrated; the kind map below still
   * gates which kinds are eligible at all.
   */
  customerActionable = true,
): TimelineEvent | null {
  // Resolved issues silently drop (no positive-spin inversion either).
  if (issue.resolved) return null;

  // Not a member's problem to act on (internal repair failure) — drop entirely,
  // rather than showing them bank-reconnect copy for an investments retry.
  if (!customerActionable) return null;

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
