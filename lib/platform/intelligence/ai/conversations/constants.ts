/**
 * lib/platform/intelligence/ai/conversations/constants.ts  (Platform AI conversations — the numbers)
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md (PR #416). PURE — no
 * database, no env, no I/O, no imports. Every retention interval here is DUPLICATED in
 * prisma/migrations/20261104120000_platform_ai_conversations/migration.sql and
 * pinned to it by ./migration-policy.test.ts (the DB-010 pattern): change one
 * and CI fails until a follow-up migration moves the SQL with it.
 */

// ⚠️ NO IMPORTS. jobs/data-retention.ts reaches this file (through ./purge.ts),
// and the snapshot graph reaches the job; importing ../core here would drag the
// navigation registry and lib/session.ts into the background-job graph
// (lib/snapshots/background-authority.test.ts). The two v0 values below are
// therefore DUPLICATED from ../core and pinned equal in ./conversations.test.ts.
const PLATFORM_AI_QUESTION_MAX = 500;        // = core.PLATFORM_AI_QUESTION_MAX
const PLATFORM_AI_TURN_TIMEOUT_MS = 45_000;  // = core.PLATFORM_AI_TURN_TIMEOUT_MS

/** OD-1 (owner, TENTATIVE pending S2's retention clearance): content is kept 90 days. */
export const PLATFORM_AI_RETENTION_DAYS = 90;
/** OD-10 (owner): soft-delete grace. Default IMMEDIATE — purged on the next daily run. */
export const PLATFORM_AI_DELETE_GRACE_DAYS = 0;
/** An empty conversation shell is purged only once older than this (a create in flight is never raced). */
export const PLATFORM_AI_SHELL_MIN_AGE_DAYS = 1;

/** The purge function's p_limit upper bound (conversations per call). */
export const PLATFORM_AI_PURGE_BATCH = 500;
/** Expired exchanges per call = p_limit × this (the function's `LIMIT p_limit * 20`). */
export const PLATFORM_AI_PURGE_EXCHANGE_FACTOR = 20;
/** At most this many purge calls per daily run; then "more remain" is logged. */
export const PLATFORM_AI_PURGE_MAX_CALLS = 20;

/** Question length — v0's bound, unchanged (S2 B7). */
export const PLATFORM_AI_MESSAGE_MAX = PLATFORM_AI_QUESTION_MAX;
/** Live conversations per operator; create beyond ⇒ 409 CONVERSATION_LIMIT. */
export const PLATFORM_AI_CONVERSATIONS_MAX = 50;
/** Messages per conversation (20 exchanges; FAILED rows count); beyond ⇒ 409 CONVERSATION_FULL. */
export const PLATFORM_AI_CONVERSATION_MESSAGES_MAX = 40;

/** History in a turn's context: at most this many prior COMPLETE messages… */
export const PLATFORM_AI_HISTORY_MESSAGES = 10;
/** …and at most this many estimated tokens (chars ÷ 3, conservative). */
export const PLATFORM_AI_HISTORY_TOKENS = 3_000;
export const PLATFORM_AI_HISTORY_CHARS_PER_TOKEN = 3;

/** A PENDING assistant row older than this is marked FAILED / ABANDONED on the next read or append. */
export const PLATFORM_AI_ABANDON_AFTER_MS = 2 * PLATFORM_AI_TURN_TIMEOUT_MS;

/** The derived list label (S2 Q1): the earliest remaining USER message, truncated on a word boundary. */
export const PLATFORM_AI_LABEL_MAX = 60;

/** #352 limiter keys (app/api/platform/mutating-route-limits.test.ts census). */
export const PLATFORM_AI_CONVERSATION_CREATE_ROUTE = "platform-ai-conversation-create";
export const PLATFORM_AI_CONVERSATION_DELETE_ROUTE = "platform-ai-conversation-delete";
export const PLATFORM_AI_MESSAGE_ROUTE = "platform-ai-message";

/** Retry-After (seconds) for 409 TURN_IN_FLIGHT. */
export const PLATFORM_AI_IN_FLIGHT_RETRY_AFTER_S = 5;
