/**
 * lib/platform/comms-center/contract-v1-section-4.ts  (Comms Center UI — Session 2)
 *
 * LOCAL transcription of the Comms Center contract sections whose server code
 * is NOT merged yet:
 *   docs/plans/COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md
 *     §3.3   delivery status + suppression reason vocabulary
 *     §3.5   mutation envelope (the seam for activate / pause / disable / test-send)
 *     §4.6   GET /automations, /automations/[id], /automations/[id]/runs
 *     §4.11  GET /delivery
 *     §4.12  GET /preferences
 *
 * The Library types (§2.1, §3.1, §4.2–§4.5) are NOT here: they are merged
 * (lib/notifications/catalog/types.ts, PR #168) and are imported from there.
 *
 * TODO(comms-center): when Session 1 merges the Phase A delivery / preferences
 * reads and the Phase B automation engine, delete each block below and import
 * the server's own types instead (expected under lib/notifications/** or
 * lib/comms/**). Every consumer imports from THIS file only, so the switch is
 * one import line per block.
 *
 * Pure types plus closed value lists. No I/O, client-safe.
 */

import type { CommsChannel, Count, DaySeries, ListEnvelope, RecipientResolver, TriggerKey } from "@/lib/notifications/catalog/types";
import type { NotificationCategory } from "@/lib/notifications/types";

// ── §3.3 Delivery status vocabulary ─────────────────────────────────────────────

export const DELIVERY_STATUSES = [
  "QUEUED", "SCHEDULED", "SUPPRESSED", "CANCELLED", "CAPTURED", "ACCEPTED", "FAILED", "DEAD", "DELIVERED", "BOUNCED", "COMPLAINED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const SUPPRESSION_REASONS = [
  "PREFERENCE_OFF", "NO_RECIPIENT", "OBSOLETE",
  "DEDUPE_OPEN", "FREQUENCY_CAP", "ELIGIBILITY_FAILED",
  "ADMISSION_REFUSED",
  "ACCOUNT_RESTRICTED",
  "BETA_LIFECYCLE", "ENTITLEMENT", "PROVIDER_FREEZE",
  "ENVIRONMENT_GUARD",
  "AUTOMATION_PAUSED", "STORM_BREAKER",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

// ── §3.1 (C1) scalar aggregate — not yet exported by the merged catalog types ──

/** `withheld: true` = observed but a small cell (1–4); `value` is then null. `withheld: false` + null = not observed. */
export type Aggregate = { value: number | null; withheld: boolean };

// ── §3.5 Mutation envelope (the seam; no mutation route exists yet) ─────────────

/** lib/audit.ts OperatorReasonCode — kept as string here so this file stays free of server imports. */
export interface MutationRequest<B> {
  reason: { code: string; note?: string };
  expectedVersion?: number;
  body: B;
}
export interface MutationResult<T> { ok: true; result: T; auditLogId: string }

// ── §4.6 Automations ────────────────────────────────────────────────────────────

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

// ── §4.11 Delivery analytics ────────────────────────────────────────────────────

export type StatusCounts = Record<DeliveryStatus, number>;
export type ReasonCounts = Record<SuppressionReason, number>;

/** C4 — the six fixed series, always all present. */
export const DELIVERY_SERIES_KEYS = ["accepted", "failed", "dead", "suppressed", "captured", "cancelled"] as const;
export type DeliverySeriesKey = (typeof DELIVERY_SERIES_KEYS)[number];

export type DeliveryWindow = "7d" | "30d" | "90d";

export interface DeliveryAnalytics {
  window: DeliveryWindow;
  from: string;
  to: string;
  filters: { channel: CommsChannel | null; status: DeliveryStatus | null; template: string | null };
  totals: StatusCounts | null;
  suppressedByReason: ReasonCounts | null;
  byKey: Array<{ key: string; counts: StatusCounts }> | null;
  series: Record<DeliverySeriesKey, DaySeries>;
  measured: { delivered: false; opens: false; clicks: false };
  coverage: { ledgerSince: string | null; directSendsCovered: boolean; environment: "production" | "preview" | "development" };
  providerHealth: { href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers"; source: "GET /api/platform/platform-ops/email-health" };
  floor: boolean;
  capped: boolean;
  checkedAt: string;
}

// ── §4.12 Preference aggregate ──────────────────────────────────────────────────

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
