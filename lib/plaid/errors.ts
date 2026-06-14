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
