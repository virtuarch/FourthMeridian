/**
 * lib/timeline-types.ts
 *
 * Canonical TimelineEvent contract shared between:
 *   - GET /api/spaces/[id]/activity  (producer)
 *   - TimelineWidget                      (consumer)
 *   - Future: Daily Briefing engine       (consumer)
 *   - Future: Notifications               (consumer)
 *
 * The widget never cares where an event came from — AuditLog,
 * SpaceGoal, account sync, or any other source. It only renders
 * a normalized event list.
 */

export type TimelineTone =
  | "neutral"
  | "positive"
  | "warning"
  | "danger"
  | "info";

/**
 * Member-facing activity category — the axis the Activity tab's filter chips
 * partition events along. Deliberately a small, member-legible vocabulary,
 * distinct from the broader admin `AUDIT_ACTION_GROUPS` in lib/audit-actions.ts
 * (which carries auth/session/AI-context groups members should never see).
 *
 *   financial  → manual asset lifecycle (add/archive/restore)
 *   connection → account link/unlink, provider sync, historical imports, sync issues
 *   space      → space lifecycle, members, sharing, goals
 *   system     → platform bookkeeping surfaced to members (e.g. import rollback)
 */
export type ActivityCategory = "financial" | "connection" | "space" | "system";

export interface TimelineEvent {
  /** Stable unique ID — typically the AuditLog.id or composite key */
  id: string;

  /**
   * Machine-readable event type.
   * Matches the audit action string (e.g. "GOAL_CREATED") or a virtual
   * type string for events synthesized from other sources.
   */
  type: string;

  /** Short headline shown in the widget (e.g. "Goal completed") */
  title: string;

  /** Supporting detail (e.g. "Emergency Fund reached its target") */
  subtitle?: string;

  /**
   * ISO 8601 date string for the event. The widget renders this as a
   * relative time ("2 hours ago") or formatted date.
   */
  date: string;

  /**
   * Display name of the user who triggered the event.
   * Omitted when the actor is unknown or the event is system-generated.
   */
  actorName?: string;

  /**
   * Lucide icon name string (e.g. "Target", "UserPlus", "Landmark").
   * The widget maps this string to the actual icon component.
   * Defaults to "Activity" if absent.
   */
  icon?: string;

  /**
   * Visual tone applied to the icon and left-border accent:
   *   positive → green  (goal completed, asset restored)
   *   info     → blue   (member joined, account shared)
   *   warning  → amber  (asset archived, member removed)
   *   danger   → red    (permanent delete)
   *   neutral  → gray   (everything else)
   */
  tone?: TimelineTone;

  /**
   * Optional monetary amount to display alongside the event.
   * (e.g. goal target amount, account balance at share time)
   */
  amount?: number;

  /** ISO 4217 currency code. Required if amount is set. */
  currency?: string;

  /**
   * If present, the event title becomes a link.
   * Use relative paths only (e.g. "/dashboard/settings/archived-assets").
   */
  href?: string;

  /**
   * Member-facing category used by the Activity tab's filter chips.
   * Every real producer (the activity route's normalizers, the ImportBatch /
   * SyncIssue normalizers) sets this. Optional at the type level only so the
   * preview rows in lib/timeline-placeholder.ts (which predate categories and
   * are out of scope for this pass) stay valid without modification — an event
   * with no category simply never matches a specific chip, only "All".
   */
  category?: ActivityCategory;

  /**
   * True for events that demonstrate a future Timeline event type
   * (document upload, AI recommendation, wallet added, recurring payment,
   * investment milestone, note, reminder, ...) that has no real backend
   * aggregation yet — see lib/timeline-placeholder.ts. Real producers
   * (the activity route, future Daily Briefing engine) never set this;
   * it defaults to falsy. Consumers that care about real vs. preview rows
   * (e.g. the new SpaceTimelineWidget) badge these distinctly so nobody
   * mistakes a preview row for actual Space history.
   */
  isPreview?: boolean;
}

/**
 * Member-facing filter chips for the Activity tab, in display order.
 * "all" is the default (no filtering). Kept here next to the contract rather
 * than in lib/audit-actions.ts so it stays a member vocabulary, separate from
 * the admin audit groups. The label copy is intentionally plain-language
 * ("Connections", not "connection").
 */
export const ACTIVITY_FILTER_GROUPS: { id: ActivityCategory | "all"; label: string }[] = [
  { id: "all",        label: "All" },
  { id: "financial",  label: "Financial" },
  { id: "connection", label: "Connections" },
  { id: "space",      label: "Space" },
  { id: "system",     label: "System" },
];
