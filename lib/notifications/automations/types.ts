/**
 * lib/notifications/automations/types.ts  (Comms Center B2 — the automation vocabulary)
 *
 * Contract v1 §4.6–§4.10, §5 and v1.1 §6, transcribed: states, the closed
 * predicate set, the run / item vocabularies, the DTOs and the numeric guards.
 * Pure types plus closed value lists. No I/O — client-safe.
 */

import type { RecipientResolver, TriggerKey } from "@/lib/notifications/catalog/types";
import type { SuppressionReason } from "@/lib/notifications/delivery/types";
import type { UserLifecycleState } from "@/lib/entitlements/beta-lifecycle";

export const AUTOMATION_STATES = ["DRAFT", "ACTIVE", "PAUSED", "DISABLED"] as const;
export type AutomationState = (typeof AUTOMATION_STATES)[number];

export const AUTO_PAUSE_REASONS = ["DEFINITION_CHANGED", "STORM_BREAKER", "ERROR_RATE", "TRIGGER_RETIRED"] as const;
export type AutoPauseReason = (typeof AUTO_PAUSE_REASONS)[number];

export const RUN_STATUSES = ["RUNNING", "SUCCEEDED", "PARTIAL", "FAILED", "HALTED"] as const;
export type AutomationRunStatus = (typeof RUN_STATUSES)[number];

export const ITEM_STATUSES = ["SCHEDULED", "SENDING", "SENT", "SUPPRESSED", "CANCELLED", "FAILED", "DEAD"] as const;
export type RunItemStatus = (typeof ITEM_STATUSES)[number];

export type AutomationChannel = "EMAIL" | "IN_APP";
export const AUTOMATION_CHANNELS = ["EMAIL", "IN_APP"] as const satisfies readonly AutomationChannel[];

export type RetryPolicy = "NONE" | "STANDARD";
export const RETRY_POLICIES = ["NONE", "STANDARD"] as const satisfies readonly RetryPolicy[];

/** v1 §5.2 — the closed predicate set. AND-ed, at most 8; no OR, no expressions, no regex. */
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

/**
 * The predicates the B2 engine can EVALUATE against a recorded trigger fact.
 * The rest of the closed set is valid vocabulary but is refused on write (400
 * VALIDATION) until its reader exists: an unevaluable condition must never be
 * stored, because the only honest evaluation of it would be "fail closed".
 */
export const ENGINE_PREDICATES = [
  "recipient.has_verified_email",
  "recipient.account_age_days",
  "recipient.has_platform_grant",
  "event.field_equals",
] as const satisfies readonly Condition["op"][];

/** v1 §4.6 + C8 — counts only, every suppression reason present (0 allowed). */
export interface AutomationRunCounts {
  matched: number;
  eligible: number;
  scheduled: number;
  accepted: number;
  failed: number;
  captured: number;
  cancelled: number;
  suppressed: Record<SuppressionReason, number>;
}

/**
 * ACTIVATION HARD GATE (review of PR #187, 2026-10-31). A CODE constant — never an
 * env var, never a PlatformSetting — so no deploy-time or operator action can open
 * it. While false:
 *   · POST /automations/[id]/activate refuses with 409 ACTIVATION_DISABLED_PENDING_HARDENING
 *     before any state write (owner approval and dry run still work);
 *   · viewer.canActivate is false with `activationDisabledReason`;
 *   · the ENGINE sends nothing: if an ACTIVE row exists anyway, the executor writes
 *     nothing and reports { outcome: "SKIPPED", skipReason: "ACTIVATION_DISABLED_PENDING_HARDENING" }.
 * It may be flipped ONLY after review items A1–A9 are fixed (the tracked follow-up PR).
 * HARDENING (the A1–A9 / N1–N11 PR) fixed them but deliberately leaves this false: flipping it is a
 * SEPARATE owner-approved PR, after that one merges. N10 (separation of duties between the owner
 * approval and the CONTROL activation) is an OWNER decision and is not changed by the hardening PR.
 */
export const AUTOMATION_ACTIVATION_ENABLED: boolean = false;
export const ACTIVATION_DISABLED_REASON = "ACTIVATION_DISABLED_PENDING_HARDENING" as const;

/** v1.1 §6.2 — why activate would refuse now (empty ⇒ the §6.3 checks pass). */
export type ActivationBlocker =
  | "TRIGGER_NOT_AVAILABLE" | "DEFINITION_NOT_ACTIVATABLE" | "PROTECTED" | "MARKETING_NOT_IN_V1"
  | "OWNER_APPROVAL_REQUIRED" | "DRY_RUN_REQUIRED" | "STATE"
  /** Review M2 — the stored definitionVersion is behind the code: a re-validating PATCH is required first. */
  | "DEFINITION_CHANGED";

/** The numeric guards (v1 §5.4, §5.7; v1.1 §6.6, §6.7). */
export const AUTOMATION_LIMITS = {
  maxConditions: 8,
  maxDelayMinutes: 10_080,
  defaultMaxRecipientsPerRun: 50,
  maxRecipientsCeiling: 500,
  /** PLATFORM_AREA_STAFF fan-out cap (v1.1 §6.7). */
  staffFanOutCap: 50,
  nameMax: 120,
  descriptionMax: 500,
  dedupeTemplateMax: 200,
  /** A dry run of THIS version must have SUCCEEDED within this many days (§6.3 rule 6). */
  dryRunFreshDays: 7,
  /** Frequency-cap bounds when the definition declares none. */
  frequencyMaxCeiling: 10,
  frequencyHoursCeiling: 720,
} as const;

/** STANDARD retry: 3 attempts in total, the 2nd at +15 min, the 3rd at +4 h, then DEAD (v1 §5.5). */
export const STANDARD_RETRY_DELAYS_MS = [15 * 60_000, 4 * 60 * 60_000] as const;
/** The send lease (v1.1 §6.6 step 1): an expired lease returns the item to SCHEDULED. */
export const SEND_LEASE_MS = 5 * 60_000;
/**
 * v1.1 §6.7 — the global automation breaker: > 200 accepted automation sends in the window auto-pauses every automation.
 * HARDENING N1 (review of #187): the contract's 10-minute window could never trip — one pass delivers at most
 * DEFAULT_BUDGET.maxItems (200) and passes are ~15 min apart — so the window is 60 minutes, and the count is the
 * engine's OWN SENT item rows (written inline) plus the sends of the current pass, checked before EVERY send
 * (the CommsDelivery rows are written after the response and are blind within a pass, A2).
 */
export const GLOBAL_BREAKER = { maxAccepted: 200, windowMinutes: 60 } as const;
/** v1.1 §8.7 — AutomationRun / AutomationRunItem live 90 days (parity with the ledger, O-9); DEDUPE_OPEN never looks further back (N6). */
export const AUTOMATION_RETENTION_DAYS = 90;
/** N2 — facts younger than this are left for the next wake (an AuditLog row that commits late is never skipped by the keyset cursor). */
export const FACT_SETTLE_MS = 60_000;
/** N4 — a fact older than this when first read (a backlog after a freeze, maintenance or a long pause) is skipped, never sent. */
export const MAX_FACT_AGE_MS = 24 * 3_600_000;
/** N4 — an item more than this past its notBefore when the scanner reaches it is CANCELLED / OBSOLETE. */
export const MAX_SEND_LATENESS_MS = 24 * 3_600_000;
/**
 * A6 — the EV-1 handler's bell for the SAME fact: a Notification of the same type, recipient and Space, with no
 * auditLogId (EV-1 producers omit it; the engine's own bells carry the fact ref), created in this window around the fact.
 */
export const HANDLER_BELL_WINDOW = { beforeMs: 5 * 60_000, afterMs: 30 * 60_000 } as const;
/** v1.1 §6.7 — ≥ 20 attempts and > 50 % failed in an hour auto-pauses one automation (ERROR_RATE). */
export const ERROR_RATE_BREAKER = { minAttempts: 20, maxFailedFraction: 0.5, windowMinutes: 60 } as const;

export interface AutomationSummary {
  id: string;
  name: string;
  state: AutomationState;
  triggerKey: TriggerKey;
  definitionKey: string;
  definitionVersion: number;
  channels: AutomationChannel[];
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
  /* v1.1 §6.2 */
  variant: string;
  customerFacing: boolean;
  ownerApproval: { approvedVersion: number; approvedDefinitionVersion: number; approvedAt: string; current: boolean } | null;
  lastDryRun: { runId: string; at: string; automationVersion: number; wouldExceedMaxRecipients: boolean } | null;
  activationBlockers: ActivationBlocker[];
  /**
   * HARDENING A6 — the definition already has a CODE producer (an EV-1 handler / registry call site) that delivers it
   * for this trigger: an automation is an ADDITIONAL send. Its in-app leg dedupes against the handler's bell for the
   * same fact; its email leg is a second message. Shown to the owner before approval (optional: older fixtures omit it).
   */
  overlapsExistingDelivery?: boolean;
  liveContent: Array<{ channel: AutomationChannel; source: "CODE_DEFAULT" | "PUBLISHED"; versionId: string | null }>;
}

/** v1 §4.6 — one run in GET /automations/[id]/runs. */
export interface AutomationRunDTO {
  id: string;
  mode: "LIVE" | "DRY_RUN";
  status: AutomationRunStatus;
  automationVersion: number;
  triggerRef: string | null;
  startedAt: string;
  completedAt: string | null;
  counts: AutomationRunCounts;
  haltReason: SuppressionReason | null;
  deduped: number;
}

/** v1 §4.7 + v1.1 §6.8. */
export interface DryRunResult {
  runId: string;
  window: { window: "7d" | "30d"; from: string; to: string } | null;
  counts: AutomationRunCounts;
  deduped: number;
  lifecycle: Record<UserLifecycleState, { value: number | null; withheld: boolean }>;
  content: Array<{ channel: AutomationChannel; source: "CODE_DEFAULT" | "PUBLISHED"; versionId: string | null }>;
  examples: Array<{ variant: string; subject: string | null; inAppTitle: string | null }>;
  wouldExceedMaxRecipients: boolean;
  activationBlockers: ActivationBlocker[];
  /** HARDENING A6 — see AutomationDetail.overlapsExistingDelivery. */
  overlapsExistingDelivery?: boolean;
  floor: boolean;
  checkedAt: string;
}
