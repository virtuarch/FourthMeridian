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
