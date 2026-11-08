/**
 * lib/platform/intelligence/ai/memory/constants.ts  (Platform AI operational memory — the numbers and registries)
 *
 * Design: Platform AI operational memory v2 (S2-approved 2026-11-08, O1 ruled (b)).
 * PURE — no database, no env, no I/O, no imports (jobs/data-retention.ts reaches
 * this file through ./purge.ts; see conversations/constants.ts for why the
 * background-job graph must not drag the AI core in).
 *
 * ⚠️ DUPLICATED IN SQL (the DB-010 pattern). Every interval, cap and registry
 * below is also a literal in
 * prisma/migrations/20261110120000_platform_ai_operational_memory/migration.sql
 * (the insert trigger's B2 sourceRefs validation, the CHECKs, the purge) and is
 * pinned to it by ./migration-policy.test.ts. The registries are ALSO pinned to
 * their live sources (the metric / navigation registries, the retrieval
 * contracts' parts, the scheduled-job facts, ProviderType) by ./memory.test.ts,
 * so adding a metric key, page, part, window, job or provider that memory may
 * reference needs a migration (S2 B2).
 */

// ── Fact shape ───────────────────────────────────────────────────────────────

export const MEMORY_FACT_TYPES = ["WATCHING_ISSUE", "OPERATIONAL_STATE", "FOLLOW_UP", "OPERATOR_PREFERENCE"] as const;
export type MemoryFactType = (typeof MEMORY_FACT_TYPES)[number];

export const MEMORY_ORIGINS = ["OPERATOR_EXPLICIT", "TOOL_DERIVED"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export const MEMORY_CONCERNS = ["RECURRING_FAILURE", "DEGRADATION", "COST_SPIKE", "CUSTOMER_IMPACT", "AWAITING_FIX", "MONITOR_ONLY"] as const;
export type MemoryConcern = (typeof MEMORY_CONCERNS)[number];

export const MEMORY_TTLS = ["H24", "H72", "D7", "D30"] as const;
export type MemoryTtl = (typeof MEMORY_TTLS)[number];

export const MEMORY_INVALID_REASONS = ["GONE", "STATE_CHANGED", "AREA_LOST", "SUPERSEDED"] as const;
export type MemoryInvalidReason = (typeof MEMORY_INVALID_REASONS)[number];

/** Hours per TTL value (the trigger's CASE; pinned). */
export const MEMORY_TTL_HOURS: Readonly<Record<MemoryTtl, number>> = { H24: 24, H72: 72, D7: 168, D30: 720 };

/** OPERATIONAL_STATE: live status — at most 72 h, and the confirm card fixes it at 72 h (D8). */
export const MEMORY_OPERATIONAL_STATE_CAP_HOURS = 72;
/** Every other type: at most 30 days (D8). */
export const MEMORY_MAX_CAP_HOURS = 720;
/** The TTLs the confirm card offers per type (D8): OPERATIONAL_STATE fixed 72 h; others 7 d or 30 d. */
export const MEMORY_TTL_CHOICES: Readonly<Record<MemoryFactType, readonly MemoryTtl[]>> = {
  OPERATIONAL_STATE: ["H72"],
  WATCHING_ISSUE: ["D7", "D30"],
  FOLLOW_UP: ["D7", "D30"],
  OPERATOR_PREFERENCE: ["D7", "D30"],
};

/**
 * The closed payload schema per fact type (design v1 §2, unchanged in v2):
 * enum values only — no free text, no number, no date. Every key is optional
 * except OPERATOR_PREFERENCE's `pref`.
 */
export const MEMORY_PAYLOAD_SCHEMA: Readonly<Record<MemoryFactType, Readonly<Record<string, readonly string[]>>>> = {
  WATCHING_ISSUE: {},
  OPERATIONAL_STATE: { expected: ["OPEN", "DEGRADED", "FAILING"] },
  FOLLOW_UP: { due: ["H24", "D7"] },
  OPERATOR_PREFERENCE: { pref: ["TERSE_ANSWERS", "DEFAULT_WINDOW_7D"] },
};
export const MEMORY_PAYLOAD_REQUIRED: Readonly<Record<MemoryFactType, readonly string[]>> = {
  WATCHING_ISSUE: [], OPERATIONAL_STATE: [], FOLLOW_UP: [], OPERATOR_PREFERENCE: ["pref"],
};

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Operator note: at most this many characters (clipped, then guarded). */
export const MEMORY_NOTE_MAX = 140;
/**
 * …and at most this many UTF-8 bytes, so the ciphertext always fits the
 * `noteEncrypted` ≤ 512 CHECK (v3 cipher: 46 fixed chars + 2 × bytes ≤ 512).
 */
export const MEMORY_NOTE_MAX_BYTES = 200;
export const MEMORY_NOTE_CIPHER_MAX = 512;
export const MEMORY_PAYLOAD_MAX_OCTETS = 512;
export const MEMORY_REFS_MAX_OCTETS = 1024;
export const MEMORY_REFS_MAX = 5;
export const MEMORY_REF_ID_MAX = 64;
/** At most this many facts are injected into one turn (D9). */
export const MEMORY_FACTS_INJECTED_MAX = 10;
/** The revalidation budget per surface (D9): an unfinished check is UNVERIFIED. */
export const MEMORY_REVALIDATE_BUDGET_MS = 2_000;
/** Proposal token lifetime (D3). */
export const MEMORY_PROPOSAL_TTL_MS = 15 * 60_000;
/** Shingles carried in one proposal token (B5). */
export const MEMORY_SHINGLES_MAX = 512;
/** A shingle is this many consecutive normalised words (D7 threshold). */
export const MEMORY_SHINGLE_WORDS = 6;
/** The character threshold of the propose-time verbatim check (D7). */
export const MEMORY_VERBATIM_CHARS = 40;

/** An invalidated row is kept this long (hidden by the store) before the purge removes it (D8). */
export const MEMORY_INVALIDATED_KEEP_DAYS = 1;
/** The purge function's p_limit upper bound (facts per call). */
export const MEMORY_PURGE_BATCH = 500;
/** At most this many purge calls per run; then "more remain" is logged. */
export const MEMORY_PURGE_MAX_CALLS = 20;

// ── B2: what a sourceRef may name (pinned to the live registries) ────────────

export const MEMORY_REF_TYPES = ["METRIC", "PAGE", "INCIDENT", "JOB", "PROVIDER"] as const;
export type MemoryRefType = (typeof MEMORY_REF_TYPES)[number];

/** The keys a sourceRef element may carry; t, id and observedState are required. */
export const MEMORY_REF_KEYS = ["t", "id", "part", "w", "observedState"] as const;

/** The closed observed-state list (never a number). */
export const MEMORY_OBSERVED_STATES = [
  "OK", "DEGRADED", "FAILING", "OPEN", "ACKNOWLEDGED", "RESOLVED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN",
] as const;
export type MemoryObservedState = (typeof MEMORY_OBSERVED_STATES)[number];

/** INCIDENT ids: a cuid (SyncIssue.id). */
export const MEMORY_INCIDENT_ID_PATTERN = "^c[a-z0-9]{24}$";

/** = METRICS.map(metricKey) (lib/platform/intelligence/metrics/registry.ts; pinned). */
export const MEMORY_METRIC_KEYS = [
  "provider-outcome@1", "provider-connection@2", "provider-call-volume@1", "ops-overall-posture@1",
  "customer-impact-24h@1", "alerts-firing-now@1", "connection-health-summary@1", "refresh-pipeline@1",
  "scheduled-job-health@1", "data-freshness@1", "ai-fleet-spend-status@1", "economics-ai-cost@1",
  "economics-operating-cost@1", "economics-provider-cost@1", "ai-call-outcomes@1", "ai-cost-per-call@1",
  "presence-state@1", "engaged-users@1", "growth-registrations@1", "incident-broken-now@1",
  "incident-alertable@1", "incident-needs-verification@1", "incident-resolved-window@1",
  "merchant-identity-linked@1", "cs-needs-help@1", "open-customers@1", "live-sessions@1",
  "accounts-with-live-session@1",
] as const;

/** = NAVIGATION_TARGETS ids (lib/platform/intelligence/navigation/registry.ts; pinned). */
export const MEMORY_PAGE_IDS = [
  "platform:overview", "platform:ai",
  "PLATFORM_OPS:platform-overview:overview", "PLATFORM_OPS:platform-overview:jobs", "PLATFORM_OPS:platform-overview:pipeline",
  "PLATFORM_OPS:platform-providers:health", "PLATFORM_OPS:platform-economics:overview", "PLATFORM_OPS:platform-economics:ai",
  "PLATFORM_OPS:platform-economics:providers", "PLATFORM_OPS:platform-economics:entitlements",
  "PLATFORM_OPS:platform-policies:groups", "PLATFORM_OPS:platform-policies:defaults", "PLATFORM_OPS:platform-policies:alerts",
  "PLATFORM_OPS:platform-policies:emergency", "PLATFORM_OPS:platform-incidents:open", "PLATFORM_OPS:platform-incidents:verify",
  "PLATFORM_OPS:platform-incidents:history",
  "SECURITY_OPS:platform-overview:overview", "SECURITY_OPS:platform-audit", "SECURITY_OPS:platform-operator-actions",
  "GROWTH_REVENUE:platform-overview:overview",
  "CUSTOMER_SUCCESS:platform-overview:overview", "CUSTOMER_SUCCESS:platform-incidents:summary",
  "CUSTOMER_SUCCESS:platform-incidents:open", "CUSTOMER_SUCCESS:platform-incidents:verify",
  "CUSTOMER_SUCCESS:platform-incidents:history", "CUSTOMER_SUCCESS:platform-communications:library",
  "CUSTOMER_SUCCESS:platform-communications:automations", "CUSTOMER_SUCCESS:platform-communications:delivery",
  "CUSTOMER_SUCCESS:platform-communications:preferences",
  "MERCHANT_OPS:platform-overview:overview",
] as const;

/** = every part key of every retrieval contract's valueUnits (metrics/retrieve-core.ts RETRIEVAL; pinned). */
export const MEMORY_METRIC_PARTS = [
  "aiFailures", "aiUsd", "briefFailed", "calls", "callsMonth", "callsToday", "costPerCallUsd", "costUsd",
  "customerImpacting", "customersAffected", "dead", "degraded", "distinctUsers", "empty", "enabledRules", "error",
  "errorRatePct", "executions", "failed", "failing", "firing", "firingCritical", "fresh", "healthy", "idle",
  "infrastructureUsd", "institutionConcentrated", "invocations", "largestMeasuredCategory", "linked", "live",
  "meteredProviders", "needsReauth", "neverRan", "noConnections", "noRuns", "noVerdict", "notEnoughData",
  "notEvaluable", "notRefreshed", "notScheduled", "overdue", "pricedUsd", "providersUsd", "reconnectNeeded",
  "refreshFailed", "refreshPartial", "returned", "returnedCalls", "running", "runningNow", "sessions", "skipped",
  "sourcesAffected", "sourcesUnavailable", "spendUsd", "stale", "syncFailures", "thresholdUsd", "totalUsd",
  "unknown", "unmeteredProviders", "unpricedInvocations", "utilisationPct",
] as const;

/** = the union of every metric's window.days (metrics/registry.ts; pinned). */
export const MEMORY_METRIC_WINDOWS = [1, 7, 30, 90] as const;

/** = SCHEDULED_JOB_FACTS names (lib/jobs/registry.core.ts; pinned). */
export const MEMORY_JOB_NAMES = [
  "sync-banks", "fetch-fx-rates", "fetch-security-prices", "sync-crypto", "sync-crypto-continuation",
  "process-deletions", "notification-cleanup", "notification-retry", "purge-trash", "rate-limit-sweep",
  "plaid-removal-retry", "product-event-retention", "comms-automations", "sol-history-backfill", "evaluate-alerts",
] as const;

/** = PROVIDER_SPECS keys (lib/platform/provider-health.ts — the provider pages' identity; pinned). */
export const MEMORY_PROVIDER_IDS = ["PLAID", "OPEN_EXCHANGE_RATES"] as const;
