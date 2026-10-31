/**
 * lib/email/recipient-guard.ts  — the NON-PRODUCTION RECIPIENT GUARD
 *
 * Owner requirement (2026-10-31): Preview must never email an unauthorized
 * recipient. Preview carries a real RESEND_API_KEY, so before this guard every
 * Preview send went to whoever the code addressed. Comms Center contract v1
 * §O-4 / §5.6 step 1 ("Environment guard"): outside Production, only
 * allowlisted recipients; everything else is CAPTURED with reason
 * ENVIRONMENT_GUARD.
 *
 * Applied in exactly ONE place — lib/email/send.ts, immediately before the real
 * provider is called — so it covers every path: direct sendEmail callers, the
 * notification EMAIL channel (lib/notifications/channels/email.ts), the retry
 * job (jobs/retry-notifications.ts, through that channel), the alerts engine,
 * account purge, and scripts (scripts/email-preview.ts).
 *
 * ENVIRONMENT (fail closed): Production is ONLY a Vercel deployment with
 * VERCEL_ENV="production" — the same Vercel branch as lib/env.ts
 * deploymentEnvironment(). Everything else is non-production: preview,
 * development, a Vercel runtime with an unexpected/unset VERCEL_ENV, and any
 * run off Vercel (local `next start`, CI, scripts) even with NODE_ENV=production.
 * deploymentEnvironment() maps "off Vercel + NODE_ENV=production" to production
 * for boot validation; for EMAIL that is deliberately NOT enough.
 *
 * ALLOWLIST: EMAIL_NONPROD_ALLOWLIST — comma-separated exact addresses,
 * trimmed and lower-cased on both sides. Unset or empty ⇒ capture EVERYTHING.
 * No wildcards, no domains: an entry matches one address only.
 *
 * Pure: reads only the env object it is handed. Logs nothing itself; the
 * redacted log line is built by describeGuardedRecipient() (domain + short hash,
 * never the address).
 */

import { createHash } from "node:crypto";

export type EmailEnvironment = "production" | "preview" | "development" | "unknown";

/** The env keys this guard reads (a structural subset of process.env). */
export interface RecipientGuardEnv {
  VERCEL?: string;
  VERCEL_ENV?: string;
  NODE_ENV?: string;
  EMAIL_NONPROD_ALLOWLIST?: string;
}

/** The env var holding the non-production allowlist. Documented in the PR + catalog. */
export const NONPROD_ALLOWLIST_ENV = "EMAIL_NONPROD_ALLOWLIST";

/** Classify the deployment for email purposes. Only "production" sends freely. */
export function emailEnvironment(e: RecipientGuardEnv): EmailEnvironment {
  if (e.VERCEL === "1") {
    if (e.VERCEL_ENV === "production") return "production";
    if (e.VERCEL_ENV === "preview") return "preview";
    if (e.VERCEL_ENV === "development") return "development";
    return "unknown";
  }
  // Off Vercel there is no deployment authority at all — NODE_ENV is a build
  // mode, not an environment. Local dev is "development"; anything else is
  // "unknown". Neither is production.
  return e.NODE_ENV === "development" ? "development" : "unknown";
}

/** Normalise one address for comparison: trim + lower-case. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Parse EMAIL_NONPROD_ALLOWLIST into a set of normalised exact addresses. */
export function parseNonprodAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").map(normalizeAddress).filter((a) => a.length > 0));
}

export type RecipientDecision =
  | { deliver: true; environment: EmailEnvironment }
  | { deliver: false; environment: EmailEnvironment; reason: "ENVIRONMENT_GUARD" };

/**
 * May a real provider send to `to` in this environment?
 *   production            → always.
 *   anything else         → only an exact (normalised) allowlist match.
 *   unset/empty allowlist → never (fail closed).
 */
export function decideRecipient(to: string, e: RecipientGuardEnv): RecipientDecision {
  const environment = emailEnvironment(e);
  if (environment === "production") return { deliver: true, environment };
  const allow = parseNonprodAllowlist(e.EMAIL_NONPROD_ALLOWLIST);
  if (allow.has(normalizeAddress(to))) return { deliver: true, environment };
  return { deliver: false, environment, reason: "ENVIRONMENT_GUARD" };
}

/**
 * The only form of a guarded recipient that may reach a log line: its domain
 * and a short SHA-256 prefix of the normalised address (enough to tell two
 * captured recipients apart, not enough to recover one). Never the local part.
 */
export function describeGuardedRecipient(to: string): string {
  const normalized = normalizeAddress(to);
  const at = normalized.lastIndexOf("@");
  const domain = at >= 0 ? normalized.slice(at + 1) : "(no-domain)";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `domain=${domain || "(no-domain)"} hash=${hash}`;
}
