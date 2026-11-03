/**
 * lib/platform/incidents/codes.ts  (PB-1 Phase 1 — the incident code registries)
 *
 * Every code column on the incident tables (SyncIssue.resolutionReasonCode,
 * SyncIssue.causeCode, SyncIssueEvent.*Code, SyncIssueArchive codes) holds a
 * REGISTRY CODE, never free text. The database enforces the shape
 * (CHECK x ~ '^[A-Z0-9_]{2,64}$'); this module is the vocabulary, and the
 * writers only accept values from it. A code is added here deliberately, with
 * its meaning — never composed at a call site.
 *
 * Pure.
 */

/** The DB CHECK, verbatim. */
export const CODE_PATTERN = /^[A-Z0-9_]{2,64}$/;

export function isRegistryCode(x: unknown): x is string {
  return typeof x === "string" && CODE_PATTERN.test(x);
}

/** Why a CONDITION was closed (SyncIssue.resolutionReasonCode). */
export const RESOLUTION_REASON_CODES = {
  /** §5 — the account was soft-deleted (disconnect / remove). */
  SUBJECT_DELETED: "The account the incident observed was removed",
  /** §5 — the Plaid item was revoked. */
  SUBJECT_REVOKED: "The connection the incident observed was revoked",
  /** §5 — the subject row no longer exists. */
  SUBJECT_MISSING: "The subject the incident observed no longer exists",
  /** P8 #1 — AUTOMATIC_RECOVERY: a later transactions sync for the connection succeeded (the held page replayed). */
  TRANSACTIONS_SYNC_SUCCEEDED: "A later transactions sync for the same connection succeeded",
  /** P8 #1 — AUTOMATIC_RECOVERY: a balance was observed for the account. */
  BALANCE_OBSERVED: "A balance was observed for the account",
} as const;
export type ResolutionReasonCode = keyof typeof RESOLUTION_REASON_CODES;

/**
 * Confirmed / hypothesised causes (SyncIssue.causeCode, SyncIssueEvent.causeCode).
 * Declared for the schema; the writers (operator cause actions) are Phase 2+.
 */
export const CAUSE_CODES = {
  PROVIDER_OUTAGE: "The provider was unavailable or erroring",
  PROVIDER_DATA_DEFECT: "The provider returned data that could not be stored as delivered",
  PLATFORM_DEFECT: "A defect in the platform's own processing",
  CONFIGURATION: "Missing or wrong configuration (credentials, endpoints)",
  MEMBER_INPUT: "Data the member supplied was invalid for the operation",
  UNKNOWN: "Investigated; the cause could not be determined",
} as const;
export type CauseCode = keyof typeof CAUSE_CODES;

/** Persisted lifecycle states (mirrors the SyncIssue CHECK); also SyncIssueEvent.from/toState. */
export const STATE_CODES = ["ACTIVE", "ACKNOWLEDGED", "RECOVERING", "STALE", "RESOLVED"] as const;

/** SyncIssueEvent.type (mirrors the CHECK). */
export const EVENT_TYPES = [
  "OBSERVED", "STATE_CHANGED", "CAUSE_HYPOTHESIZED", "CAUSE_CONFIRMED", "CAUSE_RETRACTED",
  "ACTION_TAKEN", "ACTION_OUTCOME", "NOTE_CODE",
] as const;
export type IncidentEventType = (typeof EVENT_TYPES)[number];

/** Operator actions (SyncIssueEvent.actionCode) — writers are Phase 2+ (S6). */
export const ACTION_CODES = {
  ACKNOWLEDGE: "Operator took ownership",
  RESOLVE: "Operator closed the incident with a reason",
  REOPEN: "Operator reopened a closed incident",
  REQUEST_REAUTH: "Operator asked the member to reconnect",
  RESYNC: "Operator triggered a refresh",
} as const;

/** Outcome of an action (SyncIssueEvent.outcomeCode). */
export const OUTCOME_CODES = {
  SUCCEEDED: "The action completed",
  FAILED: "The action did not complete",
  NO_CHANGE: "The action completed and changed nothing",
} as const;

/** Every registry, for the pattern pin. */
export const ALL_CODE_REGISTRIES: Record<string, readonly string[]> = {
  RESOLUTION_REASON_CODES: Object.keys(RESOLUTION_REASON_CODES),
  CAUSE_CODES: Object.keys(CAUSE_CODES),
  STATE_CODES,
  ACTION_CODES: Object.keys(ACTION_CODES),
  OUTCOME_CODES: Object.keys(OUTCOME_CODES),
};
