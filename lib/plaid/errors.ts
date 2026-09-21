/**
 * lib/plaid/errors.ts
 *
 * Parses Plaid API errors (AxiosError wrappers) into user-friendly messages
 * without leaking internal details to the client.
 *
 * Plaid error shape:
 *   err.response.data = {
 *     error_type:    "ITEM_ERROR" | "INVALID_REQUEST" | ...
 *     error_code:    "ITEM_LOGIN_REQUIRED" | "INVALID_ACCESS_TOKEN" | ...
 *     error_message: "<internal detail — never send to client>"
 *     display_message: "<sometimes present, safe for users>"
 *   }
 */

import { PlaidItemStatus } from "@prisma/client";

// Subset of Plaid error codes we handle explicitly
const USER_MESSAGES: Record<string, string> = {
  ITEM_LOGIN_REQUIRED:
    "Your bank connection needs to be re-authenticated. Please reconnect your account.",
  INVALID_ACCESS_TOKEN:
    "Your bank connection has expired. Please reconnect your account.",
  ITEM_LOCKED:
    "Your bank account is temporarily locked. Please try again later.",
  INSTITUTION_DOWN:
    "Your bank is temporarily unavailable. Please try again in a few minutes.",
  INSTITUTION_NOT_RESPONDING:
    "Your bank is not responding. Please try again in a few minutes.",
  INSTITUTION_NO_LONGER_SUPPORTED:
    "This institution is no longer supported by Plaid.",
  PRODUCT_NOT_READY:
    "Your account data is not ready yet. Please try again in a moment.",
  INVALID_PUBLIC_TOKEN:
    "The connection session expired. Please try linking your account again.",
  SANDBOX_ONLY:
    "This action is only available in the Plaid sandbox environment.",
  INVALID_ENVIRONMENT:
    "Invalid Plaid environment configuration. Contact support.",
};

interface PlaidErrorBody {
  error_type?:      string;
  error_code?:      string;
  error_message?:   string;
  display_message?: string | null;
}

interface ParsedError {
  message: string;
  /** HTTP status to return to the client */
  status:  number;
  /** Raw Plaid error_code, for server-side logging only */
  code?:   string;
}

function isAxiosError(err: unknown): err is { response?: { data?: PlaidErrorBody; status?: number } } {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err
  );
}

/**
 * Parse an error thrown by the Plaid SDK into a safe client response.
 * @param err        The caught error
 * @param fallback   Generic message if no specific mapping exists
 */
export function parsePlaidError(err: unknown, fallback: string): ParsedError {
  if (isAxiosError(err)) {
    const data   = err.response?.data;
    const status = err.response?.status ?? 500;
    const code   = data?.error_code;

    if (code && USER_MESSAGES[code]) {
      return { message: USER_MESSAGES[code], status, code };
    }

    // Plaid sometimes provides a display_message safe for end users
    if (data?.display_message) {
      return { message: data.display_message, status, code };
    }

    // Rate limit / auth errors — surface a safe message
    if (status === 401) return { message: "Plaid authentication failed. Check server configuration.", status: 500, code };
    if (status === 429) return { message: "Too many requests. Please try again shortly.", status: 429, code };
  }

  if (err instanceof Error && err.message.includes("ENCRYPTION_KEY")) {
    return { message: "Server configuration error. Contact support.", status: 500 };
  }

  if (err instanceof Error && err.message.includes("Missing env var")) {
    return { message: "Server configuration error. Contact support.", status: 500 };
  }

  return { message: fallback, status: 500 };
}

/**
 * Extracts the raw Plaid error_code from a caught error, or undefined when
 * the error isn't an Axios-shaped Plaid API error. For flow-control checks
 * like `getPlaidErrorCode(err) === "ADDITIONAL_CONSENT_REQUIRED"`.
 */
export function getPlaidErrorCode(err: unknown): string | undefined {
  return isAxiosError(err) ? err.response?.data?.error_code : undefined;
}

/**
 * One-line log summary of a caught Plaid/SDK error — error_code + Plaid's
 * error_message when present, the Error message otherwise. For catch blocks
 * that previously logged the raw error object: an AxiosError dumps its
 * entire config/request/response graph into the logs, which drowns out the
 * one line that matters.
 */
export function plaidErrorSummary(err: unknown): string {
  if (isAxiosError(err)) {
    const data = err.response?.data;
    if (data?.error_code) {
      return `${data.error_code}${data.error_message ? `: ${data.error_message}` : ""}`;
    }
    return `HTTP ${err.response?.status ?? "?"} (no Plaid error body)`;
  }
  return err instanceof Error ? err.message : String(err);
}

// D2 Step 7A — connection health classification. Separate from
// parsePlaidError() above: that function's `status` is an HTTP response
// code for the client, not a health state to persist.
//
// NEEDS_REAUTH — credential is dead; Plaid Link re-authentication is the
// actual fix.
const NEEDS_REAUTH_CODES = new Set(["ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN"]);

// Transient / provider-outage codes — log only, never write PlaidItem.status.
// Kept out of the ERROR bucket on purpose: today's sync queries only ever
// select status: ACTIVE, so moving a transient blip to ERROR would
// permanently lock that item out of every existing sync path (no
// retry/backoff or reconnect UI exists yet to recover it). See
// docs/initiatives/d2/implementation/D2_STEP7A_CONNECTION_HEALTH_IMPLEMENTATION_CHECKLIST.md
// §4/§7.
const TRANSIENT_CODES = new Set([
  "ITEM_LOCKED",
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "PRODUCT_NOT_READY",
  // "Underlying transaction data changed since last page was fetched. Please
  // restart pagination from last update." Plaid raises this when the Item's data
  // mutates mid-pagination — routine during a first-run import, which is exactly
  // when Plaid is still writing history. It is a RESTART instruction, not a fault.
  //
  // Untreated it was neither retried nor classified: the sync threw, the run was
  // recorded failed, and the next attempt began again — the "transactions start
  // back when I refresh" behaviour reported 2026-07-23 (observed on a live Amex
  // import at 23:17).
  //
  // Retrying is precisely what Plaid asks for, and it is safe here: `cursor`
  // advances only after a page is FULLY persisted (the cursor safety invariant),
  // so the retry re-issues from the last persisted cursor — "restart pagination
  // from last update", exactly. Being transient it also classifies to null
  // health, so a mid-import mutation can no longer mark a connection ERROR.
  "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
]);

export interface PlaidHealthResult {
  status: typeof PlaidItemStatus.NEEDS_REAUTH | typeof PlaidItemStatus.ERROR;
  errorCode: string;
}

/**
 * Classifies a caught Plaid/sync error into a PlaidItem health state to
 * persist, or null if it should be logged only (status left unchanged).
 * Requires a real Plaid error_code (Axios-shaped error response) — never
 * fires for transient codes above, rate limiting, or non-Axios exceptions
 * (e.g. decrypt/env/DB errors), since blaming this specific item's
 * credential for an infra-wide failure would be misleading.
 */
export function classifyPlaidErrorForHealth(err: unknown): PlaidHealthResult | null {
  if (!isAxiosError(err)) return null;

  const status = err.response?.status;
  const code   = err.response?.data?.error_code;

  if (status === 429) return null;
  if (!code || TRANSIENT_CODES.has(code)) return null;

  if (NEEDS_REAUTH_CODES.has(code)) {
    return { status: PlaidItemStatus.NEEDS_REAUTH, errorCode: code };
  }

  // Everything else with a real Plaid error_code that isn't transient —
  // INSTITUTION_NO_LONGER_SUPPORTED, INVALID_ENVIRONMENT, SANDBOX_ONLY, and
  // any unrecognized code — is treated as unrecoverable-until-investigated.
  return { status: PlaidItemStatus.ERROR, errorCode: code };
}

// D2 Step 7D — retry/backoff. Separate question from
// classifyPlaidErrorForHealth() above: that function decides what to
// persist to PlaidItem.status; this one decides whether lib/plaid/retry.ts
// should attempt the same call again. A code can be retryable here and
// still resolve to "log only, no status change" there (TRANSIENT_CODES) —
// the two are independent.
//
// Retryable:
//  - Any TRANSIENT_CODES error_code (provider-outage/lock — same bucket
//    classifyPlaidErrorForHealth already treats as log-only).
//  - HTTP 429 (rate limit) — classifyPlaidErrorForHealth already
//    special-cases this as log-only; it's also the textbook retry case.
//  - A raw network-level failure: the request reached axios but never got
//    a response (timeout, ECONNRESET, DNS failure, etc.), recognized via
//    axios's own `isAxiosError` flag — set on every AxiosError regardless
//    of whether a response was received, unlike isAxiosError() above,
//    which requires a `response` key and is false for exactly this case.
//
// Not retryable: NEEDS_REAUTH_CODES, any other recognized-but-terminal code
// (INVALID_ENVIRONMENT, SANDBOX_ONLY, INSTITUTION_NO_LONGER_SUPPORTED), any
// unrecognized error_code, and any non-Axios exception (decrypt/env/DB
// errors) — none of those are fixed by trying again.
export function isRetryablePlaidError(err: unknown): boolean {
  const isAxiosOrigin =
    typeof err === "object" && err !== null && (err as { isAxiosError?: unknown }).isAxiosError === true;
  if (!isAxiosOrigin) return false;

  const axiosErr = err as { response?: { data?: PlaidErrorBody; status?: number } };
  if (!axiosErr.response) return true; // no response reached us at all — network-level

  const status = axiosErr.response.status;
  const code   = axiosErr.response.data?.error_code;

  if (status === 429) return true;
  if (code && TRANSIENT_CODES.has(code)) return true;

  return false;
}

// ── The log-safety boundary (FM-AUDIT-001) ──────────────────────────────────
//
// NEVER log a raw AxiosError. Its `config` carries the outgoing request headers
// and body verbatim — which for Plaid means `PLAID-SECRET`, `PLAID-CLIENT-ID`
// and the item's `access_token` — and its `request` (a ClientRequest) carries the
// raw header block again in `_header`. `console.error(msg, err)` serialises all
// of it, so on 2026-07-22 a production Plaid secret and a live access token sat in
// plaintext in the Vercel runtime logs on EVERY Plaid API failure (c28d853).
//
// c28d853 fixed the call sites it could see and missed five (the pre-S1 audit,
// FM-AUDIT-001) — a call-site discipline is only as good as the last catch block
// someone wrote. So the boundary is now TWO layers, each sufficient alone:
//
//   1. SOURCE — `sanitizeProviderErrorInPlace` runs on every error leaving the
//      `plaidClient` proxy (lib/plaid/client.ts). By the time any catch block in
//      the codebase sees a Plaid error, `config` / `request` / response headers are
//      gone and the response body is reduced to Plaid's own error fields. A raw
//      `console.error(err)` anywhere downstream is harmless.
//   2. RENDER — `redactedErrorForLog` renders any error as one line of
//      allowlisted facts, and scrubs credential shapes from free text. The Plaid
//      logging surface is source-scanned to use it (plaid-log-safety.test.ts).

/** Plaid error-body fields that carry no credential and are worth keeping. */
const SAFE_PLAID_BODY_KEYS = [
  "error_type", "error_code", "error_code_reason", "error_message", "display_message",
  "request_id", "documentation_url", "suggested_action",
] as const;

const SANITIZED = Symbol.for("fm.plaid.sanitizedError");

/** An error shaped like an HTTP-client (axios) failure — the shape that can carry a request. */
function isHttpClientError(err: unknown): err is Record<string, unknown> {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.isAxiosError === true || "config" in e || "request" in e || "response" in e;
}

function pickSafeBody(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SAFE_PLAID_BODY_KEYS) {
    if (typeof src[k] === "string" || src[k] === null) out[k] = src[k];
  }
  return out;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  try {
    delete target[key];
    if (value !== undefined) {
      Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: key !== "toJSON" });
    }
  } catch { /* a frozen/exotic error keeps its shape; the render layer still applies */ }
}

/**
 * Strip every credential-bearing part of an HTTP-client error IN PLACE and
 * return the same object — identity, prototype, `isAxiosError`, `message`,
 * `stack`, `response.status` and Plaid's error body (error_code, error_type,
 * request_id, …) survive, so every classifier downstream behaves exactly as
 * before. What goes: `config` (headers + body; reduced to method + url),
 * `request`, `response.config`, `response.request`, `response.headers`, and any
 * response-body field outside SAFE_PLAID_BODY_KEYS. `toJSON` is replaced so
 * `JSON.stringify(err)` renders only the allowlisted facts. Idempotent.
 * Non-HTTP errors are returned untouched.
 */
export function sanitizeProviderErrorInPlace<T>(err: T): T {
  if (!isHttpClientError(err)) return err;
  const e = err as Record<string | symbol, unknown> & Record<string, unknown>;
  if (e[SANITIZED]) return err;
  const cfg = e.config as { method?: unknown; url?: unknown } | undefined;
  setOwn(e, "config", cfg && typeof cfg === "object"
    ? { method: typeof cfg.method === "string" ? cfg.method : undefined, url: typeof cfg.url === "string" ? cfg.url : undefined }
    : undefined);
  setOwn(e, "request", undefined);
  const resp = e.response as { status?: unknown; statusText?: unknown; data?: unknown } | undefined;
  if (resp && typeof resp === "object") {
    setOwn(e, "response", {
      status: typeof resp.status === "number" ? resp.status : undefined,
      statusText: typeof resp.statusText === "string" ? resp.statusText : undefined,
      data: pickSafeBody(resp.data),
    });
  }
  setOwn(e, "toJSON", function toJSON() { return safePlaidErrorFields(e); });
  try { Object.defineProperty(e, SANITIZED, { value: true, enumerable: false }); } catch { /* frozen */ }
  return err;
}

/** The allowlisted facts of a provider error — safe to log, persist or return to an operator. */
export interface SafePlaidErrorFields {
  kind: "provider-http" | "provider-network" | "error";
  errorType?: string;
  errorCode?: string;
  requestId?: string;
  httpStatus?: number;
  retryable: boolean;
  message: string;
}

export function safePlaidErrorFields(err: unknown): SafePlaidErrorFields {
  if (isHttpClientError(err)) {
    const resp = err.response as { status?: unknown; data?: Record<string, unknown> } | undefined;
    const data = (resp?.data ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      kind: resp ? "provider-http" : "provider-network",
      errorType: str(data.error_type),
      errorCode: str(data.error_code),
      requestId: str(data.request_id),
      httpStatus: typeof resp?.status === "number" ? resp.status : undefined,
      retryable: isRetryablePlaidError(err),
      message: scrubSecrets(str(data.error_message) ?? str(err.message) ?? "provider request failed"),
    };
  }
  return {
    kind: "error",
    retryable: false,
    message: scrubSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
  };
}

const TOKEN_SHAPE = /\b(access|public|link|processor|item)-(sandbox|development|production)-[A-Za-z0-9-]{6,}/g;
const HEADER_SHAPE = /(PLAID-SECRET|PLAID-CLIENT-ID|authorization)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi;
const BODY_FIELD_SHAPE = /("?(?:secret|client_secret|access_token|public_token|client_id)"?\s*[:=]\s*")[^"]*"/gi;

/**
 * Remove credential shapes from free text: the configured PLAID_SECRET /
 * PLAID_CLIENT_ID values wherever they appear, Plaid token shapes, credential
 * headers and credential body fields. Defence in depth for messages and stacks
 * of non-HTTP errors (an Error whose message was built from a request).
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const name of ["PLAID_SECRET", "PLAID_CLIENT_ID"] as const) {
    const v = process.env[name];
    if (v && v.length >= 8) out = out.split(v).join(`[redacted ${name}]`);
  }
  return out
    .replace(TOKEN_SHAPE, "[redacted-token]")
    .replace(HEADER_SHAPE, "$1$2[redacted]")
    .replace(BODY_FIELD_SHAPE, "$1[redacted]\"");
}

function renderSafe(f: SafePlaidErrorFields): string {
  const parts = [
    f.kind === "provider-network" ? "network failure" : `HTTP ${f.httpStatus ?? "?"}`,
    f.errorType && `type=${f.errorType}`,
    f.errorCode && `code=${f.errorCode}`,
    f.requestId && `request_id=${f.requestId}`,
    `retryable=${f.retryable}`,
  ].filter(Boolean);
  return `[provider error] ${parts.join(" ")} — ${f.message}`;
}

/**
 * A log-safe rendering of ANY caught error. The Plaid logging surface must pass
 * errors through this (or `plaidErrorSummary`) — never the raw object.
 *
 * HTTP-client errors render as one line of allowlisted facts (status, Plaid
 * error_type/error_code, request_id, retry classification, Plaid's message).
 * Anything else (Prisma, TypeError, …) keeps name + message + stack — genuinely
 * useful — with credential shapes scrubbed; an HTTP-client `cause` is rendered
 * the safe way rather than dropped.
 */
export function redactedErrorForLog(err: unknown): string {
  if (isHttpClientError(err)) return renderSafe(safePlaidErrorFields(err));
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeLine = cause !== undefined ? `\n[cause] ${redactedErrorForLog(cause)}` : "";
    return scrubSecrets(`${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`) + causeLine;
  }
  return scrubSecrets(typeof err === "string" ? err : safeStringify(err));
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}
