/**
 * lib/platform/incidents/explanations.ts  (Incident detail v1 — PURE, client-safe)
 *
 * Provider error code → what an operator needs to read in the incident drawer:
 * a plain-English explanation, the facts that are CONFIRMED by the code itself,
 * a cause that is only PROBABLE (always labelled so), what the customer must do,
 * and what the operator should do next — plus the remedy CLASS that decides
 * which recovery action may be offered (investigation-dto.ts recoveryActionsFor).
 *
 * TRUTH RULES
 *   - The only confirmed fact is the verified code (and, where Plaid documents
 *     it, what that code means). Anything about WHY is `probableCause`.
 *   - An unknown code gets the honest fallback ("We don't have a verified
 *     explanation for this code") — never a guess.
 *   - A code reaches the wire ONLY through `allowlistedProviderCode`: a known
 *     Plaid error-code string. Free provider text (messages, display messages,
 *     request bodies) never passes; an unrecognised code is reported as such,
 *     never echoed.
 *
 * REMEDY CLASSES
 *   customer-reconnect  the customer must reconnect through Link update mode.
 *                       A server retry cannot help — Resync is NEVER offered.
 *   customer-re-add     the connection is gone at the provider; the customer
 *                       must add it again (no reauth, no retry).
 *   server-retry        transient / provider-side; a later retry can help.
 *   investigate         no verified explanation — operator judgement.
 *
 * Membership of the update-mode set stays in lib/plaid/reauth-codes.ts (the
 * single source of truth; Plaid-documented). This module reads it, never copies it.
 *
 * PURE: no Prisma, no I/O.
 */

import { UPDATE_MODE_FIXABLE_CODES, isUpdateModeFixable } from "@/lib/plaid/reauth-codes";

export type RemedyClass = "customer-reconnect" | "customer-re-add" | "server-retry" | "investigate";

export interface ProviderErrorExplanation {
  code: string | null;
  /** True only for a code this table explains. */
  verified: boolean;
  plainEnglish: string;
  /** Facts the code itself establishes. Never a cause. */
  confirmedFacts: string[];
  /** Always shown under a "Probable" label; null when nothing can be said. */
  probableCause: string | null;
  /** What the customer must do; null when nothing is required of them. */
  customerAction: string | null;
  operatorNext: string;
  remedy: RemedyClass;
  /** The customer (not the server) must act for this to recover. */
  customerActionRequired: boolean;
}

type Entry = Omit<ProviderErrorExplanation, "code" | "verified">;

const RECONNECT_ACTION = "Reconnect this bank from the Connections page (Reconnect) and sign in again.";

const TABLE: Readonly<Record<string, Entry>> = {
  ITEM_LOGIN_REQUIRED: {
    plainEnglish: "The bank needs the customer to sign in again before it will share data.",
    confirmedFacts: ["Plaid returned ITEM_LOGIN_REQUIRED for this connection.", "Plaid documents Link update mode as the fix for this code."],
    probableCause: "The customer changed their bank password, or the bank expired the session or required new multi-factor verification.",
    customerAction: RECONNECT_ACTION,
    operatorNext: "Do not resync — it will fail the same way. Confirm the customer has been prompted to reconnect; follow up through Customer Success if it stays open.",
    remedy: "customer-reconnect", customerActionRequired: true,
  },
  NO_ACCOUNTS: {
    plainEnglish: "The bank connection is working, but it is no longer sharing any accounts with us.",
    confirmedFacts: ["Plaid returned NO_ACCOUNTS for this connection.", "Plaid documents update mode with account selection as the fix when access existed before."],
    probableCause: "The customer de-selected the accounts at the bank or in its data-sharing settings, or the bank stopped sharing the account (e.g. closed or moved).",
    customerAction: "Reconnect this bank from the Connections page and re-select the accounts to share.",
    operatorNext: "Do not resync — a server retry cannot restore account access. The customer must reconnect and choose accounts; the reconnect flow enables account selection for this code.",
    remedy: "customer-reconnect", customerActionRequired: true,
  },
  ACCESS_NOT_GRANTED: {
    plainEnglish: "The customer has not granted the access this connection needs.",
    confirmedFacts: ["Plaid returned ACCESS_NOT_GRANTED for this connection.", "Plaid documents Link update mode as the fix for an existing connection."],
    probableCause: "The customer declined a data-sharing permission at the bank's consent screen, or revoked it afterwards.",
    customerAction: "Reconnect this bank from the Connections page and allow the requested access.",
    operatorNext: "Do not resync. The customer must reconnect and grant access.",
    remedy: "customer-reconnect", customerActionRequired: true,
  },
  PENDING_EXPIRATION: {
    plainEnglish: "The customer's consent for this connection is about to expire.",
    confirmedFacts: ["Plaid reported PENDING_EXPIRATION for this connection."],
    probableCause: "The bank's consent period is ending (common with OAuth institutions).",
    customerAction: "Reconnect this bank from the Connections page before access expires.",
    operatorNext: "Nothing to retry on our side. Make sure the customer is prompted to reconnect.",
    remedy: "customer-reconnect", customerActionRequired: true,
  },
  INVALID_CREDENTIALS: {
    plainEnglish: "The bank rejected the sign-in details the customer provided.",
    confirmedFacts: ["Plaid returned INVALID_CREDENTIALS."],
    probableCause: "A mistyped or changed username or password.",
    customerAction: "Reconnect this bank and sign in with the current username and password.",
    operatorNext: "Do not resync. The customer must sign in again with correct details.",
    remedy: "customer-reconnect", customerActionRequired: true,
  },
  INVALID_ACCESS_TOKEN: {
    plainEnglish: "Our stored access to this connection is no longer valid.",
    confirmedFacts: ["Plaid returned INVALID_ACCESS_TOKEN for this connection."],
    probableCause: null,
    customerAction: RECONNECT_ACTION,
    operatorNext: "Do not resync — the stored credential is dead. The customer must reconnect; escalate to engineering if this repeats across connections.",
    remedy: "customer-reconnect", customerActionRequired: true,
  },
  USER_PERMISSION_REVOKED: {
    plainEnglish: "The customer revoked our access to this connection at the bank or through Plaid.",
    confirmedFacts: ["Plaid reported USER_PERMISSION_REVOKED for this connection."],
    probableCause: "The customer removed the app from their bank's or Plaid's connected-apps settings.",
    customerAction: "Add this bank again from the Connections page if they want it connected.",
    operatorNext: "Nothing to retry or reauthorize: the connection is gone at the provider. Only the customer can add it again.",
    remedy: "customer-re-add", customerActionRequired: true,
  },
  INSTITUTION_DOWN: {
    plainEnglish: "The bank is unavailable right now.",
    confirmedFacts: ["Plaid returned INSTITUTION_DOWN."],
    probableCause: "A bank-side outage or maintenance window. These usually clear without anyone acting.",
    customerAction: null,
    operatorNext: "Wait, then resync once the institution recovers. Check whether other connections at the same bank are affected (spread).",
    remedy: "server-retry", customerActionRequired: false,
  },
  INSTITUTION_NOT_RESPONDING: {
    plainEnglish: "The bank did not respond in time.",
    confirmedFacts: ["Plaid returned INSTITUTION_NOT_RESPONDING."],
    probableCause: "Intermittent bank-side slowness or an outage.",
    customerAction: null,
    operatorNext: "A later resync usually succeeds. If it persists, check the spread across this institution.",
    remedy: "server-retry", customerActionRequired: false,
  },
  RATE_LIMIT_EXCEEDED: {
    plainEnglish: "Requests to the provider were rate-limited.",
    confirmedFacts: ["The provider returned a rate-limit error."],
    probableCause: "Too many requests in a short window — ours, or the bank's limit applied through Plaid.",
    customerAction: null,
    operatorNext: "Wait out the cooldown before resyncing; repeated retries prolong it.",
    remedy: "server-retry", customerActionRequired: false,
  },
  INTERNAL_SERVER_ERROR: {
    plainEnglish: "The provider had an internal error handling the request.",
    confirmedFacts: ["Plaid returned INTERNAL_SERVER_ERROR."],
    probableCause: "A transient Plaid-side failure.",
    customerAction: null,
    operatorNext: "A later resync usually succeeds. Escalate to engineering if it repeats.",
    remedy: "server-retry", customerActionRequired: false,
  },
};
// Plaid has two rate-limit spellings in use; both get the same explanation.
const ALIASES: Readonly<Record<string, string>> = { RATE_LIMIT: "RATE_LIMIT_EXCEEDED" };

/**
 * Known Plaid error-code strings — the ONLY codes that reach the wire. Codes
 * without a TABLE entry are passed through as codes and explained by the fallback.
 */
export const KNOWN_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(TABLE), ...Object.keys(ALIASES), ...UPDATE_MODE_FIXABLE_CODES,
  "ITEM_LOCKED", "USER_SETUP_REQUIRED", "ITEM_NOT_FOUND", "PENDING_DISCONNECT", "INVALID_MFA", "INSUFFICIENT_CREDENTIALS",
  "MFA_NOT_SUPPORTED", "PRODUCT_NOT_READY", "PRODUCTS_NOT_SUPPORTED", "NO_AUTH_ACCOUNTS", "NO_INVESTMENT_ACCOUNTS",
  "PLANNED_MAINTENANCE", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "INVALID_UPDATED_USERNAME", "ITEM_NOT_SUPPORTED",
  "INSTITUTION_NO_LONGER_SUPPORTED", "INSTITUTION_NOT_AVAILABLE", "ITEM_PRODUCT_NOT_READY",
]);

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** The code, when it is a KNOWN provider error-code string; otherwise null. Never echoes anything else. */
export function allowlistedProviderCode(raw: unknown): string | null {
  return typeof raw === "string" && CODE_SHAPE.test(raw) && KNOWN_PROVIDER_ERROR_CODES.has(raw) ? raw : null;
}

/** A non-empty raw value that is NOT an allowlisted code (reported as "unrecognised", never shown). */
export function isUnrecognisedProviderCode(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim() !== "" && allowlistedProviderCode(raw) === null;
}

/** The error code stored on an incident's detail (`detail.errorCode`), allowlisted. Reads that one key only. */
export function providerErrorCodeOfDetail(detail: unknown): { code: string | null; unrecognised: boolean } {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return { code: null, unrecognised: false };
  const raw = (detail as Record<string, unknown>).errorCode;
  return { code: allowlistedProviderCode(raw), unrecognised: isUnrecognisedProviderCode(raw) };
}

export const UNKNOWN_EXPLANATION_TEXT = "We don't have a verified explanation for this code.";

/** The explanation for a code (null ⇒ no code recorded). Unknown codes get the honest fallback. */
export function explainProviderError(code: string | null): ProviderErrorExplanation {
  const key = code ? (ALIASES[code] ?? code) : null;
  const entry = key ? TABLE[key] : undefined;
  if (code && entry) return { code, verified: true, ...entry, confirmedFacts: [...entry.confirmedFacts] };
  // Not in the table, but Plaid documents update mode for it (reauth-codes.ts) — still the customer's to fix.
  if (code && isUpdateModeFixable(code)) {
    return {
      code, verified: false, plainEnglish: UNKNOWN_EXPLANATION_TEXT,
      confirmedFacts: [`The provider returned ${code}.`, "Plaid documents Link update mode as the fix for this code."],
      probableCause: null, customerAction: RECONNECT_ACTION,
      operatorNext: "Do not resync. The customer must reconnect.", remedy: "customer-reconnect", customerActionRequired: true,
    };
  }
  return {
    code, verified: false,
    plainEnglish: code ? UNKNOWN_EXPLANATION_TEXT : "No provider error code was recorded for this incident.",
    confirmedFacts: code ? [`The provider returned ${code}.`] : [],
    probableCause: null, customerAction: null,
    operatorNext: code
      ? "Check the recent attempts below and the provider's documentation for this code before acting."
      : "Check the recent attempts below; the timeline shows what the system recorded.",
    remedy: "investigate",
    customerActionRequired: false,
  };
}

/**
 * The remedy class for this incident's connection RIGHT NOW. A NEEDS_REAUTH
 * item is the customer's to fix whatever the code; a REVOKED item must be
 * re-added. An ACTIVE item is healthy again (e.g. the customer already
 * reconnected): a code the customer had to fix no longer asks anything of
 * them — a sync is what proves the recovery, so it reads as server-retry.
 */
export function remedyFor(code: string | null, itemStatus: string | null): RemedyClass {
  if (itemStatus === "REVOKED") return "customer-re-add";
  if (itemStatus === "NEEDS_REAUTH") return "customer-reconnect";
  const r = explainProviderError(code).remedy;
  if (itemStatus === "ACTIVE" && (r === "customer-reconnect" || r === "customer-re-add")) return "server-retry";
  return r;
}

export function customerActionRequiredFor(code: string | null, itemStatus: string | null): boolean {
  const r = remedyFor(code, itemStatus);
  return r === "customer-reconnect" || r === "customer-re-add";
}
