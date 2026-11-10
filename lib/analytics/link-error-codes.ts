/**
 * lib/analytics/link-error-codes.ts  (the closed Plaid Link error-code vocabulary)
 *
 * Writer-free: the vocabulary and its one mapping function, shared by the
 * product-event writer (CONNECTION_LINK_EXITED, lib/analytics/product-events.ts,
 * which re-exports both unchanged) and the CONNECTION_ADD_FAILED writer
 * (lib/connections/add-failure.ts), which is not a product event and so does
 * not import the product-event writer module.
 */

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

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** Map a raw Plaid error code to the closed error vocabulary. Never returns free text. */
export function linkExitErrorCode(raw: unknown): LinkExitErrorCode {
  if (raw === null || raw === undefined || raw === "") return "NONE";
  if (typeof raw !== "string") return "OTHER";
  const up = raw.trim().toUpperCase();
  return up !== "NONE" && isOneOf(LINK_EXIT_ERROR_CODES, up) ? up : "OTHER";
}
