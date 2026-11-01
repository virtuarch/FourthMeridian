/**
 * lib/analytics/product-events.ts  (BETA A1–A8 — the product-event writer)
 *
 * ONE TYPED FUNCTION PER EVENT. The parameters of each function are exactly the
 * metadata keys the event is allowed to carry (`day`, `spaceType`, `briefDay`,
 * `cached`, `accountId`, `connectionId`, `chain`, `currency`), so a caller cannot
 * pass a name, an amount, an address, a prompt or a description by construction
 * — there is no parameter to put it in. lib/analytics/product-events.test.ts
 * scans every call site for the same reason.
 *
 * WHAT THESE ROWS ARE. First-party presence / engagement facts, written SERVER
 * SIDE only (route handlers and server components; never from the client, never
 * from a job, a webhook, a cron or an operator path), onto the existing
 * append-only `AuditLog` through the one shape authority (`buildAuditData`,
 * lib/audit.ts). `ipAddress` and `userAgent` are always null: a product event is
 * not a security event and carries no request forensics. `actorType` is always
 * USER and `result` SUCCESS — the shape helper's envelope, so the admin audit
 * view renders them like every other row.
 *
 * DEDUPE, CONCURRENCY-SAFE AND READ-BACK-FREE. "Once per (user, Space, UTC day)"
 * is enforced by the WRITER with one statement:
 *
 *     INSERT INTO "AuditLog" (…) SELECT … WHERE NOT EXISTS (same user, action,
 *     Space and key already present)
 *
 * so a reload, a double render or two concurrent first pages cannot double-count
 * through a read-then-write race, and nothing is read back after the insert
 * (`auditInsert`'s lesson: a RETURNING needs a SELECT grant the writer may not
 * hold). There is deliberately no unique index behind it (a migration this
 * slice does not make), so two statements racing in the same millisecond can
 * still both pass the check; every READER therefore counts DISTINCT (user, day)
 * — the owner's "dedupe AND count distinct" rule, applied on both sides.
 *
 * AUTHORITY. The client is whatever phase the caller is already in: the tenant
 * transaction of a route or server page (fm_app: INSERT is `WITH CHECK (true)`
 * and the NOT EXISTS reads the user's OWN rows, which `fm_app_sel` admits), or a
 * transaction client in a test. SESSION_ACTIVE_DAY is NOT written here — it runs
 * on the pre-identity role inside the session-activity statement, where the
 * dedupe cannot read AuditLog at all (lib/auth/session-activity.ts).
 *
 * NEVER THROWS INTO THE REQUEST PATH. Analytics must not break a page: every
 * writer catches, logs the failure class and resolves `false`. A caller that
 * wants the write to be part of its transaction's outcome should not use this.
 */

import { randomUUID } from "crypto";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";
import { toISODateUTC } from "@/lib/time/clock";
import type { CHAT_REFUSAL_SAY } from "@/lib/ai/conversation/refusal-sentences";

/** The one capability a writer needs: run a single parameterised statement. */
export interface ProductEventClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

/**
 * The only metadata keys a product event may carry. Pinned by the test, and
 * ENFORCED AT RUNTIME by `allowlistedMetadata` below (a key outside this list,
 * or a value that is not a short string or a boolean, is dropped before the row
 * is built). The last six are the S2-(a) connection-funnel and AI-failure keys:
 * each carries a value from a closed vocabulary in this file, never free text.
 */
export const PRODUCT_EVENT_METADATA_KEYS = [
  "day", "spaceType", "briefDay", "cached", "accountId", "connectionId", "chain", "currency",
  "provider", "stage", "errorCode", "sourceKind", "surface", "reason",
] as const;
export type ProductEventMetadataKey = (typeof PRODUCT_EVENT_METADATA_KEYS)[number];

type ProductMetadata = Partial<Record<ProductEventMetadataKey, string | boolean>>;

/** The longest string value a product event may carry (ids, UTC days, enum codes). */
export const PRODUCT_EVENT_MAX_VALUE_LENGTH = 64;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(PRODUCT_EVENT_METADATA_KEYS);

/**
 * THE RUNTIME ALLOWLIST. The typed writers already cannot name another key, but
 * a cast, a spread or a future writer could; this is the last line. Drops every
 * key outside PRODUCT_EVENT_METADATA_KEYS and every value that is not a boolean
 * or a string of at most PRODUCT_EVENT_MAX_VALUE_LENGTH characters (an object,
 * an array, a number that could be an amount, a long string that could be prose).
 */
export function allowlistedMetadata(input: Record<string, unknown>): ProductMetadata {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= PRODUCT_EVENT_MAX_VALUE_LENGTH) out[k] = v;
  }
  return out as ProductMetadata;
}

/** `YYYY-MM-DD` of an instant, UTC — the day grain every dedupe key uses. */
export function productEventDay(now: Date = new Date()): string {
  return toISODateUTC(now);
}

interface WriteInput {
  userId: string;
  spaceId: string | null;
  action: AuditActionType;
  metadata: ProductMetadata;
  /**
   * The metadata key that, with (userId, action, spaceId), identifies the one row
   * allowed; `"once"` means one row per (userId, action) EVER (no Space, no key);
   * null means every occurrence is a row.
   */
  dedupeKey: "day" | "briefDay" | "once" | null;
}

function failSoft(action: string, err: unknown): false {
  const name = err instanceof Error ? `${err.name}: ${err.message.split("\n")[0].slice(0, 120)}` : String(err).slice(0, 120);
  console.warn(`[product-events] ${action} not recorded (${name})`);
  return false;
}

/**
 * The shared writer. One statement; a deduped event inserts only when no row with
 * the same (userId, action, spaceId, metadata->>key) exists; an undeduped event
 * inserts unconditionally. Resolves `true` when a row was written.
 */
async function writeProductEvent(client: ProductEventClient, input: WriteInput): Promise<boolean> {
  const metadata = allowlistedMetadata(input.metadata);
  const data = buildAuditData({
    actorId: input.userId, actorType: "USER", action: input.action, result: "SUCCESS",
    spaceId: input.spaceId, metadata, ipAddress: null, userAgent: null,
  });
  const id = randomUUID();
  const metadataJson = JSON.stringify(data.metadata);
  try {
    let written: number;
    if (input.dedupeKey === "once") {
      written = await client.$executeRaw`
        INSERT INTO "AuditLog" ("id", "userId", "spaceId", "action", "metadata", "ipAddress", "userAgent")
        SELECT ${id}::text, ${input.userId}::text, ${input.spaceId}::text, ${input.action}::text, ${metadataJson}::jsonb, NULL, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM "AuditLog"
            WHERE "userId" = ${input.userId}::text
              AND "action" = ${input.action}::text
         )`;
    } else if (input.dedupeKey) {
      const keyValue = String(metadata[input.dedupeKey]);
      written = await client.$executeRaw`
        INSERT INTO "AuditLog" ("id", "userId", "spaceId", "action", "metadata", "ipAddress", "userAgent")
        SELECT ${id}::text, ${input.userId}::text, ${input.spaceId}::text, ${input.action}::text, ${metadataJson}::jsonb, NULL, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM "AuditLog"
            WHERE "userId" = ${input.userId}::text
              AND "action" = ${input.action}::text
              AND "spaceId" IS NOT DISTINCT FROM ${input.spaceId}::text
              AND "metadata"->>(${input.dedupeKey}::text) = ${keyValue}::text
         )`;
    } else {
      written = await client.$executeRaw`
        INSERT INTO "AuditLog" ("id", "userId", "spaceId", "action", "metadata", "ipAddress", "userAgent")
        VALUES (${id}::text, ${input.userId}::text, ${input.spaceId}::text, ${input.action}::text, ${metadataJson}::jsonb, NULL, NULL)`;
    }
    return written > 0;
  } catch (err) {
    return failSoft(input.action, err);
  }
}

// ── The events ───────────────────────────────────────────────────────────────

/**
 * SPACE_VIEWED — a Space's server page rendered for one of its members. Once per
 * (user, Space, UTC day). `spaceType` is the Space's kind (PERSONAL / SHARED),
 * never its name. Platform Spaces are never recorded (the caller decides; the
 * platform page does not call this).
 */
export function recordSpaceViewed(
  client: ProductEventClient,
  input: { userId: string; spaceId: string; spaceType: string; now?: Date },
): Promise<boolean> {
  const day = productEventDay(input.now);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: input.spaceId, action: AuditAction.SPACE_VIEWED,
    metadata: { day, spaceType: input.spaceType }, dedupeKey: "day",
  });
}

/**
 * BRIEF_VIEWED — a Daily Brief was SHOWN to its reader (not generated, not
 * polled for, not prefetched). Once per (user, Space, briefDay): the key is the
 * Brief's own day, so a Brief read again on a later calendar day is still one
 * view of that Brief. `cached` says whether the Brief shown already existed
 * (true: a read path) or was generated in the same request (false).
 */
export function recordBriefViewed(
  client: ProductEventClient,
  input: { userId: string; spaceId: string; briefDay: string; cached: boolean },
): Promise<boolean> {
  return writeProductEvent(client, {
    userId: input.userId, spaceId: input.spaceId, action: AuditAction.BRIEF_VIEWED,
    metadata: { briefDay: input.briefDay, cached: input.cached }, dedupeKey: "briefDay",
  });
}

/**
 * TRANSACTIONS_VIEWED — the Transactions workspace loaded its FIRST page for a
 * Space (never a cursor continuation). Once per (user, Space, UTC day).
 */
export function recordTransactionsViewed(
  client: ProductEventClient,
  input: { userId: string; spaceId: string; now?: Date },
): Promise<boolean> {
  const day = productEventDay(input.now);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: input.spaceId, action: AuditAction.TRANSACTIONS_VIEWED,
    metadata: { day }, dedupeKey: "day",
  });
}

/**
 * MANUAL_ASSET_VALUE_UPDATED — `PATCH /api/accounts/manual/[id]` succeeded. One
 * row per update (frequency is the figure), carrying the account id and NEVER
 * the value, the name or the kind of asset.
 */
export function recordManualAssetValueUpdated(
  client: ProductEventClient,
  input: { userId: string; accountId: string },
): Promise<boolean> {
  return writeProductEvent(client, {
    userId: input.userId, spaceId: null, action: AuditAction.MANUAL_ASSET_VALUE_UPDATED,
    metadata: { accountId: input.accountId }, dedupeKey: null,
  });
}

/**
 * Metadata for the two NORMALISED lifecycle writers (they keep their own
 * `auditLog.create` inside the tenant phase that creates the account; this only
 * fixes what they are allowed to say). Pure, so the test can pin the keys.
 */
export function walletAddMetadata(input: { connectionId: string | null; chain: string }): { connectionId: string | null; chain: string } {
  return { connectionId: input.connectionId, chain: input.chain };
}
export function manualAssetAddMetadata(input: { accountId: string; currency: string }): { accountId: string; currency: string } {
  return { accountId: input.accountId, currency: input.currency };
}

// ── S2-(a) — the connection funnel and AI failures ──────────────────────────
//
// Four events the derived taxonomy cannot reconstruct from existing rows
// (docs/plans/PRE-BETA-READINESS-SESSION2-2026-11-01.md §(a), items 11–14).
// Every property is a value from a CLOSED vocabulary below; anything else a
// caller hands in is mapped to "OTHER" (exit stage / error code) or refused
// outright (provider, source kind, surface, reason). Nothing here can carry an
// institution name, a Plaid error_message, a link_session_id, a request id, a
// figure, or a word of a conversation.

/** Connection providers whose Link flow is instrumented. */
export const LINK_PROVIDERS = ["PLAID"] as const;
export type LinkProvider = (typeof LINK_PROVIDERS)[number];

/**
 * Where in Plaid Link the user was when it closed (`metadata.status` on onExit,
 * upper-cased). NONE = Plaid reported no status; OTHER = a status this list
 * does not know (a new Plaid value, or anything a client made up).
 */
export const LINK_EXIT_STAGES = [
  "NONE",
  "REQUIRES_QUESTIONS", "REQUIRES_SELECTIONS", "REQUIRES_CODE", "CHOOSE_DEVICE",
  "REQUIRES_CREDENTIALS", "REQUIRES_ACCOUNT_SELECTION", "REQUIRES_OAUTH",
  "INSTITUTION_NOT_FOUND", "INSTITUTION_NOT_SUPPORTED",
  "OTHER",
] as const;
export type LinkExitStage = (typeof LINK_EXIT_STAGES)[number];

/**
 * Plaid error codes a Link exit can carry (`error.error_code`). NONE = a clean
 * cancel (no error); OTHER = any code outside this list.
 */
export const LINK_EXIT_ERROR_CODES = [
  "NONE",
  // ITEM_ERROR
  "INVALID_CREDENTIALS", "INVALID_MFA", "INVALID_SEND_METHOD", "INSUFFICIENT_CREDENTIALS",
  "ITEM_LOCKED", "ITEM_LOGIN_REQUIRED", "ITEM_NOT_SUPPORTED", "MFA_NOT_SUPPORTED",
  "NO_ACCOUNTS", "NO_INVESTMENT_ACCOUNTS", "PRODUCTS_NOT_SUPPORTED", "USER_SETUP_REQUIRED",
  "USER_INPUT_TIMEOUT", "ACCESS_NOT_GRANTED", "PASSWORD_RESET_REQUIRED",
  // INSTITUTION_ERROR
  "INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_NO_LONGER_SUPPORTED", "INSTITUTION_NOT_ENABLED_IN_ENVIRONMENT",
  "INSTITUTION_REGISTRATION_REQUIRED",
  // INVALID_INPUT / OAUTH / API
  "INVALID_LINK_TOKEN", "LINK_TOKEN_EXPIRED", "OAUTH_STATE_ID_MISMATCH", "OAUTH_INVALID_STATE",
  "REDIRECT_URI_MISMATCH", "RATE_LIMIT_EXCEEDED", "INTERNAL_SERVER_ERROR", "PLANNED_MAINTENANCE",
  "OTHER",
] as const;
export type LinkExitErrorCode = (typeof LINK_EXIT_ERROR_CODES)[number];

/** Where a first successful sync came from (RefreshExecution.sourceKind). */
export const FIRST_SYNC_SOURCE_KINDS = ["PLAID_ITEM", "WALLET"] as const;
export type FirstSyncSourceKind = (typeof FIRST_SYNC_SOURCE_KINDS)[number];

/** AI surfaces whose turn failures are recorded. */
export const AI_TURN_FAILURE_SURFACES = ["chat"] as const;
export type AiTurnFailureSurface = (typeof AI_TURN_FAILURE_SURFACES)[number];

/**
 * Why an accepted turn produced no answer: the chat route's own typed failure
 * sentences (lib/ai/conversation/refusal-sentences.ts CHAT_REFUSAL_SAY keys
 * failed / silent / unpriced / timedOut) plus the paid-AI pause that lands
 * mid-turn. Input refusals (malformed / empty / tooLong / forbidden) and the
 * pre-turn gates (pacing, allowance, plan, pause before the turn) are not turn
 * failures and are not recorded.
 */
export const AI_TURN_FAILURE_REASONS = ["failed", "silent", "unpriced", "timedOut", "paused"] as const satisfies
  readonly (keyof typeof CHAT_REFUSAL_SAY | "paused")[];
export type AiTurnFailureReason = (typeof AI_TURN_FAILURE_REASONS)[number];

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** Map a raw Plaid exit status to the closed stage vocabulary. Never returns free text. */
export function linkExitStage(raw: unknown): LinkExitStage {
  if (raw === null || raw === undefined || raw === "") return "NONE";
  if (typeof raw !== "string") return "OTHER";
  const up = raw.trim().toUpperCase();
  return up !== "NONE" && isOneOf(LINK_EXIT_STAGES, up) ? up : "OTHER";
}

/** Map a raw Plaid error code to the closed error vocabulary. Never returns free text. */
export function linkExitErrorCode(raw: unknown): LinkExitErrorCode {
  if (raw === null || raw === undefined || raw === "") return "NONE";
  if (typeof raw !== "string") return "OTHER";
  const up = raw.trim().toUpperCase();
  return up !== "NONE" && isOneOf(LINK_EXIT_ERROR_CODES, up) ? up : "OTHER";
}

/**
 * CONNECTION_LINK_STARTED — a Plaid Link token was minted for the user (a fresh
 * link or update mode). One row per token: frequency is the figure, and the
 * link-token route's own per-user limit (10 / 15 min) bounds it.
 */
export function recordConnectionLinkStarted(
  client: ProductEventClient,
  input: { userId: string; provider: LinkProvider },
): Promise<boolean> {
  if (!isOneOf(LINK_PROVIDERS, input.provider)) return Promise.resolve(false);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: null, action: AuditAction.CONNECTION_LINK_STARTED,
    metadata: { provider: input.provider }, dedupeKey: null,
  });
}

/**
 * CONNECTION_LINK_EXITED — Plaid Link closed without success (onExit). Stage and
 * error code pass through the closed vocabularies again here, whatever the
 * caller already did. One row per exit, bounded by the endpoint's per-user limit.
 */
export function recordConnectionLinkExited(
  client: ProductEventClient,
  input: { userId: string; provider: LinkProvider; stage: LinkExitStage; errorCode: LinkExitErrorCode },
): Promise<boolean> {
  if (!isOneOf(LINK_PROVIDERS, input.provider)) return Promise.resolve(false);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: null, action: AuditAction.CONNECTION_LINK_EXITED,
    metadata: {
      provider: input.provider,
      stage: isOneOf(LINK_EXIT_STAGES, input.stage) ? input.stage : "OTHER",
      errorCode: isOneOf(LINK_EXIT_ERROR_CODES, input.errorCode) ? input.errorCode : "OTHER",
    },
    dedupeKey: null,
  });
}

/**
 * FIRST_SYNC_SUCCEEDED — the user's first refresh execution whose derived status
 * is SUCCEEDED. ONCE PER USER, EVER (the "once" dedupe: no Space, no day), so a
 * second source, a second day or a racing cron cannot add a row. Unlike the
 * presence events this is a data-readiness fact, so it is written by whichever
 * execution first succeeds — a connect's deferred import, a webhook or the cron —
 * from lib/plaid/refresh-execution.ts on the system authority.
 *
 * Retention still applies (13 months): after its row is purged, a user's next
 * successful sync records again. Readers treat the row as "first observed
 * success", and compare it to the registration date.
 */
export function recordFirstSyncSucceeded(
  client: ProductEventClient,
  input: { userId: string; sourceKind: FirstSyncSourceKind },
): Promise<boolean> {
  if (!isOneOf(FIRST_SYNC_SOURCE_KINDS, input.sourceKind)) return Promise.resolve(false);
  return writeProductEvent(client, {
    userId: input.userId, spaceId: null, action: AuditAction.FIRST_SYNC_SUCCEEDED,
    metadata: { sourceKind: input.sourceKind }, dedupeKey: "once",
  });
}

/**
 * AI_TURN_FAILED — an accepted Conversations turn ended without an answer. The
 * surface and the typed reason only: no prompt, no completion, no model, no
 * Space. One row per failure, bounded by the chat route's pacing windows.
 */
export function recordAiTurnFailed(
  client: ProductEventClient,
  input: { userId: string; surface: AiTurnFailureSurface; reason: AiTurnFailureReason },
): Promise<boolean> {
  if (!isOneOf(AI_TURN_FAILURE_SURFACES, input.surface) || !isOneOf(AI_TURN_FAILURE_REASONS, input.reason)) {
    return Promise.resolve(false);
  }
  return writeProductEvent(client, {
    userId: input.userId, spaceId: null, action: AuditAction.AI_TURN_FAILED,
    metadata: { surface: input.surface, reason: input.reason }, dedupeKey: null,
  });
}
