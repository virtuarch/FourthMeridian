/**
 * lib/timeline-types.ts
 *
 * Canonical TimelineEvent contract shared between:
 *   - GET /api/workspaces/[id]/activity  (producer)
 *   - TimelineWidget                      (consumer)
 *   - Future: Daily Briefing engine       (consumer)
 *   - Future: Notifications               (consumer)
 *
 * The widget never cares where an event came from — AuditLog,
 * WorkspaceGoal, account sync, or any other source. It only renders
 * a normalized event list.
 */

export type TimelineTone =
  | "neutral"
  | "positive"
  | "warning"
  | "danger"
  | "info";

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
}
