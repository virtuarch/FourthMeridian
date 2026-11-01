/**
 * lib/platform/comms-center/contract-v1-section-4.ts  (Comms Center UI — Session 2)
 *
 * THE one import path the Communications views use for contract §3.3, §3.5,
 * §4.6, §4.11 and §4.12 (docs/plans/COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md).
 *
 * Re-exported from the server (merged):
 *   §3.3   DeliveryStatus / SuppressionReason + their value lists   (#170, #177)
 *   §3.1   Aggregate (C1 scalar)                                     (#168)
 *   §4.11  DeliveryAnalytics / DeliveryWindow / StatusCounts / ReasonCounts / SeriesKey  (#170)
 * all through lib/notifications/catalog/types.ts, the server's stable,
 * type-only export path.
 *
 * Still LOCAL (the server exports no type for these yet):
 *   §3.5   mutation envelope (the seam for activate / pause / disable / test-send)
 *   §4.6   GET /automations, /automations/[id], /automations/[id]/runs
 *   §4.12  GET /preferences
 * TODO(comms-center): when Session 1 merges the preferences read and the
 * Phase B automation engine, delete each local block below and re-export the
 * server's own types instead. Every consumer imports from THIS file only, so
 * the switch is one line per block.
 *
 * Pure types plus closed value lists. No I/O, client-safe.
 */

import type {
  Aggregate, CommsChannel, Count, DeliveryAnalytics as ServerDeliveryAnalytics, ListEnvelope, RecipientResolver, SeriesKey, SuppressionReason, TriggerKey,
} from "@/lib/notifications/catalog/types";
import type { NotificationCategory } from "@/lib/notifications/types";

// ── §3.3 + §4.11 (server) ───────────────────────────────────────────────────────

export { DELIVERY_STATUSES, SUPPRESSION_REASONS } from "@/lib/notifications/catalog/types";
export type {
  Aggregate, DeliveryAnalytics, DeliveryStatus, DeliveryWindow, ReasonCounts, StatusCounts, SuppressionReason,
} from "@/lib/notifications/catalog/types";

/** C4 — the six fixed series (server type SeriesKey), in display order. */
export const DELIVERY_SERIES_KEYS = ["accepted", "failed", "dead", "suppressed", "captured", "cancelled"] as const satisfies readonly SeriesKey[];
export type DeliverySeriesKey = SeriesKey;

/**
 * Phase C (contract v1.2) — the OPTIONAL verified-event series, derived from the
 * server's own `series` type (so a server key the UI lacks fails to compile),
 * present only when `measured.delivered` is true. Display order.
 */
export type ProviderSeriesKey = Exclude<keyof ServerDeliveryAnalytics["series"], SeriesKey>;
export const PROVIDER_SERIES_KEYS = ["delivered", "bounced", "complained"] as const satisfies readonly ProviderSeriesKey[];

// ── §3.5 Mutation envelope — LOCAL (the seam; no mutation route exists yet) ─────

/** lib/audit.ts OperatorReasonCode — kept as string here so this file stays free of server imports. */
export interface MutationRequest<B> {
  reason: { code: string; note?: string };
  expectedVersion?: number;
  body: B;
}
export interface MutationResult<T> { ok: true; result: T; auditLogId: string }

// ── §4.6 Automations — LOCAL (TODO(comms-center): Phase B engine types) ──────────────────────────────────────────────────────────

export const AUTOMATION_STATES = ["DRAFT", "ACTIVE", "PAUSED", "DISABLED"] as const;
export type AutomationState = (typeof AUTOMATION_STATES)[number];
export type AutoPauseReason = "DEFINITION_CHANGED" | "STORM_BREAKER" | "ERROR_RATE" | "TRIGGER_RETIRED";
export type AutomationRunStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "HALTED";
export type RetryPolicy = "NONE" | "STANDARD";

/** §5.2 — the closed predicate set (as data; the UI only renders it). */
export type Condition =
  | { op: "recipient.has_verified_email" }
  | { op: "recipient.account_age_days"; cmp: "gte" | "lte"; value: number }
  | { op: "recipient.cohort_in"; cohortIds: string[] }
  | { op: "recipient.lifecycle_stage_in"; stages: string[] }
  | { op: "recipient.has_platform_grant"; area: string }
  | { op: "event.field_equals"; field: string; value: string | number | boolean }
  | { op: "event.count_in_window"; cmp: "gte"; value: number; windowHours: number }
  | { op: "connection.status_in"; statuses: Array<"ACTIVE" | "NEEDS_REAUTH" | "ERROR" | "REVOKED"> }
  | { op: "connection.removed_by_user"; value: false };

export interface AutomationSummary {
  id: string;
  name: string;
  state: AutomationState;
  triggerKey: TriggerKey;
  definitionKey: string;
  definitionVersion: number;
  channels: CommsChannel[];
  version: number;
  activatedVersion: number | null;
  autoPausedReason: AutoPauseReason | null;
  lastRun: { id: string; at: string; status: AutomationRunStatus } | null;
  updatedAt: string;
}

export interface AutomationDetail extends AutomationSummary {
  description: string;
  conditions: Condition[];
  recipient: RecipientResolver;
  delay: { minutes: number } | null;
  dedupeKeyTemplate: string;
  frequencyCap: { max: number; perHours: number };
  retryPolicy: RetryPolicy;
  maxRecipientsPerRun: number;
  history: Array<{ at: string; action: string; actorKind: "PLATFORM_OPERATOR" | "SYSTEM_ADMIN" | "SYSTEM"; auditLogId: string }>;
}

export interface AutomationRunItem {
  id: string;
  mode: "LIVE" | "DRY_RUN";
  status: AutomationRunStatus;
  automationVersion: number;
  triggerRef: string;
  startedAt: string;
  completedAt: string | null;
  counts: {
    matched: number; eligible: number; scheduled: number; accepted: number; failed: number;
    captured: number; cancelled: number;
    suppressed: Record<SuppressionReason, number>;
  };
  haltReason: SuppressionReason | null;
}

export type AutomationsResponse = ListEnvelope<AutomationSummary>;
export type RunsResponse = ListEnvelope<AutomationRunItem>;

// ── §4.12 Preference aggregate — LOCAL (TODO(comms-center): preferences read) ───────────────────────────────────────────────

export interface PreferenceCell {
  default: boolean;
  optedOut: Count;
  optedIn: Count;
  withheld: boolean;
}

export interface PreferenceAggregate {
  population: number;
  rows: Array<{
    category: NotificationCategory;
    locked: boolean;
    channels: Record<"IN_APP" | "EMAIL", PreferenceCell>;
  }>;
  coupledSuppression: Array<{ key: string; usersAffected: Aggregate; explanation: string }>;
  floor: boolean;
  checkedAt: string;
}
