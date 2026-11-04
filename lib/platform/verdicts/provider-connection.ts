/**
 * lib/platform/verdicts/provider-connection.ts  (provider trust, connection scope — rule v1)
 *
 * THE one rule that turns a provider's CONNECTION states into a provider-level
 * verdict. It sits beside provider-outcome@1 (./provider-outcome.ts) and shares its
 * failing share (PROVIDER_FAILING_SHARE). Pure and client-safe: no clock, no
 * environment, no I/O.
 *
 * Before v1, ONE customer's connection in ERROR, REVOKED or NEEDS_REAUTH made the
 * whole provider FAILING (lib/platform/provider-health.ts connectionsHaveHardFault).
 * A customer who must reconnect is a per-customer state. Customer Success and
 * attention already surface it. It says nothing about whether the provider works.
 *
 * ── Step 1: classify each connection (the code→state pin) ────────────────────
 * Only provider- or institution-side codes count as ERROR. Customer-actionable
 * codes count as NEEDS_REAUTH, whatever status was written. A code in neither
 * list is UNCLASSIFIED: it can DEGRADE a provider, never fail it. So a new code
 * cannot silently become a provider-wide outage. The mapping is pinned by test.
 *
 *   REVOKED                                        → REVOKED       neutral
 *   status NEEDS_REAUTH, or a CUSTOMER_REAUTH code → NEEDS_REAUTH  neutral (except a wave)
 *   status ERROR + a PROVIDER_SIDE code            → ERROR
 *   status ERROR + any other / no code             → UNCLASSIFIED  (degrades only)
 *   state DEGRADED (an error code, no status flip) → UNCLASSIFIED  (degrades only)
 *   STALE / HEALTHY                                → NONE          (recency is the freshness authority's)
 *
 * ── Step 2: the verdict (provider-connection@1), first match decides ─────────
 * The denominator `active` is the provider's LIVE connection population: every
 * connection except REVOKED and those whose owner is inactive or pending
 * deletion (lib/connections/health.ts "retired"). PlaidItem and Connection have
 * no soft-delete column; a removed connection is REVOKED.
 *
 *   1. ERROR SHARE    error ≥ FAILING_SHARE × active, with active ≥ 2   ⇒ FAILING
 *   2. ANY ERROR      error > 0 (incl. a lone 1/1)                      ⇒ DEGRADED
 *   3. REAUTH WAVE    reauth ≥ FAILING_SHARE × active, with active ≥ 4  ⇒ DEGRADED
 *                     ("possible provider-side reauth wave"; reauth NEVER fails a provider)
 *   4. UNCLASSIFIED   unclassified > 0                                  ⇒ DEGRADED
 *                     (the basis names the codes, sorted and capped at
 *                     UNCLASSIFIED_CODES_SHOWN; codes only, a non-code value is never echoed)
 *
 * Without the authority's per-source tally the population is unknown: no share
 * is computed, and the basis says "connection population unavailable — share
 * not computed".
 *   5. NONE           ⇒ no connection verdict (neutral facts only)
 *
 * Facts that never drive trust are reported as neutral words: customers who must
 * reconnect, and REVOKED connections. Every figure is a count of rows in the
 * connection authority.
 *
 * FOLLOW-UP (out of scope for v1): a per-institution concentration rule, e.g.
 * all of one institution's connections failing while the provider is fine.
 */

import { PROVIDER_FAILING_SHARE } from "./provider-outcome";

export const PROVIDER_CONNECTION_DEFINITION = {
  id: "provider-connection",
  version: 1,
  /** Shared with provider-outcome@1: at or above this share, the provider is the problem. */
  failingShare: PROVIDER_FAILING_SHARE,
  /** Live connections needed before an ERROR share can FAIL a provider (1/1 only degrades). */
  minActiveForErrorShare: 2,
  /** Live connections needed before a reauth share is read as a provider-side wave. */
  minActiveForReauthWave: 4,
} as const;

export const PROVIDER_CONNECTION_DEFINITION_ID =
  `${PROVIDER_CONNECTION_DEFINITION.id}@${PROVIDER_CONNECTION_DEFINITION.version}` as const;

/** Provider- or institution-side codes: the provider or the institution failed, not the customer. */
export const PROVIDER_SIDE_ERROR_CODES: ReadonlySet<string> = new Set([
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_NO_LONGER_SUPPORTED",
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
  "RATE_LIMIT_EXCEEDED",
  "PRODUCT_NOT_READY",
]);

/** Customer-actionable codes: the customer must sign in again, consent again, or fix their account. */
export const CUSTOMER_REAUTH_CODES: ReadonlySet<string> = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_ACCESS_TOKEN",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "USER_PERMISSION_REVOKED",
  "USER_SETUP_REQUIRED",
  "ACCESS_NOT_GRANTED",
  "ITEM_LOCKED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "INSUFFICIENT_CREDENTIALS",
  "MFA_NOT_SUPPORTED",
  "NO_ACCOUNTS",
]);

export type ConnectionTrustState = "ERROR" | "NEEDS_REAUTH" | "UNCLASSIFIED" | "REVOKED" | "NONE";

/** Step 1: one connection's state for provider trust, from its health state and error code. Pure. */
export function connectionTrustState(healthState: string, errorCode: string | null): ConnectionTrustState {
  if (healthState === "REVOKED") return "REVOKED";
  if (healthState === "NEEDS_REAUTH") return "NEEDS_REAUTH";
  if (healthState === "ERROR" || healthState === "DEGRADED") {
    if (errorCode && CUSTOMER_REAUTH_CODES.has(errorCode)) return "NEEDS_REAUTH";
    if (healthState === "ERROR" && errorCode && PROVIDER_SIDE_ERROR_CODES.has(errorCode)) return "ERROR";
    return "UNCLASSIFIED";
  }
  return "NONE";
}

/** A provider's connection tallies (counts of rows in the connection authority). */
export interface ConnectionTally {
  /** Live connections (REVOKED and owner-inactive excluded). */
  active: number;
  error: number;
  reauth: number;
  unclassified: number;
  /** REVOKED connections — outside `active`, reported only. */
  revoked: number;
  /** The distinct error CODES behind `unclassified` (codes only, never messages); "no code" for a null code. */
  unclassifiedCodes?: readonly string[];
  /** True when the live population is unknown (no per-source tally): no share is computed. */
  populationUnknown?: boolean;
}

/** At most this many codes are named in an unclassified basis; the rest are counted ("+2 more"). */
export const UNCLASSIFIED_CODES_SHOWN = 3;
/** The words for a code-less unclassified error. */
export const NO_CODE = "no code";

export type ConnectionVerdict = "FAILING" | "DEGRADED" | null;

export interface ConnectionAssessment {
  definition: typeof PROVIDER_CONNECTION_DEFINITION_ID;
  /** null = connections do not move the provider's trust. */
  verdict: ConnectionVerdict;
  rule: "error-share" | "any-error" | "reauth-wave" | "unclassified" | "none";
  tally: ConnectionTally;
  /** The deciding line, with its counts (null when there is no verdict). */
  basis: string | null;
  /** Neutral facts that never drive trust ("4 connections need the customer to reconnect"). */
  facts: string[];
}

const conns = (c: number) => `${c.toLocaleString("en-US")} connection${c === 1 ? "" : "s"}`;

/** Step 2: provider-connection@1 over one provider's tallies. Pure. */
export function assessConnections(t: ConnectionTally): ConnectionAssessment {
  const d = PROVIDER_CONNECTION_DEFINITION;
  const active = Math.max(0, t.active);
  const tally = { ...t, active };
  // active 0 = the population is unknown (a payload without per-source tallies): no share rule can fire.
  const of = (k: number) => active > 0 ? `${k.toLocaleString("en-US")} of ${conns(active)}` : conns(k);
  const facts: string[] = [];
  if (t.reauth > 0) facts.push(`${conns(t.reauth)} need${t.reauth === 1 ? "s" : ""} the customer to reconnect`);
  if (t.revoked > 0) facts.push(`${conns(t.revoked)} revoked by the customer`);
  const out = (verdict: ConnectionVerdict, rule: ConnectionAssessment["rule"], basis: string | null): ConnectionAssessment =>
    ({ definition: PROVIDER_CONNECTION_DEFINITION_ID, verdict, rule, tally, basis: basis && t.populationUnknown ? `${basis} — connection population unavailable — share not computed` : basis, facts });

  if (active >= d.minActiveForErrorShare && t.error >= d.failingShare * active) {
    return out("FAILING", "error-share", `${of(t.error)} in provider-side error`);
  }
  if (t.error > 0) return out("DEGRADED", "any-error", `${of(t.error)} in provider-side error`);
  if (active >= d.minActiveForReauthWave && t.reauth >= d.failingShare * active) {
    return out("DEGRADED", "reauth-wave", `${of(t.reauth)} need reconnecting — possible provider-side reauth wave`);
  }
  if (t.unclassified > 0) return out("DEGRADED", "unclassified", `${of(t.unclassified)} with an unclassified error${codesWords(t.unclassifiedCodes)}`);
  return out(null, "none", null);
}

/** The words for a value in errorCode that is not code-shaped (it may be free text): never echoed. */
export const NOT_A_CODE = "non-code value";
/** Codes only, never messages: an errorCode is named only when it is code-shaped (UPPER_SNAKE, ≤ 64 chars). */
export function codeWord(errorCode: string | null): string {
  if (errorCode == null || errorCode === "") return NO_CODE;
  return /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : NOT_A_CODE;
}

/** " (FOO, BAR, BAZ +2 more)" — sorted codes, capped; "" when none are known. */
function codesWords(codes: readonly string[] | undefined): string {
  if (!codes || codes.length === 0) return "";
  const sorted = [...codes].sort();
  const shown = sorted.slice(0, UNCLASSIFIED_CODES_SHOWN).join(", ");
  const more = sorted.length - UNCLASSIFIED_CODES_SHOWN;
  return ` (${shown}${more > 0 ? ` +${more} more` : ""})`;
}

/** Tally rows (state + code) into the rule's counts. `active` is supplied by the caller (the live population). */
export function tallyConnections(
  rows: readonly { healthState: string; errorCode: string | null; count?: number }[],
  active: number,
  revoked: number,
  opts: { populationUnknown?: boolean } = {},
): ConnectionTally {
  const codes = new Set<string>();
  const t: ConnectionTally = { active, error: 0, reauth: 0, unclassified: 0, revoked };
  for (const r of rows) {
    const k = r.count ?? 1;
    const s = connectionTrustState(r.healthState, r.errorCode);
    if (s === "ERROR") t.error += k;
    else if (s === "NEEDS_REAUTH") t.reauth += k;
    else if (s === "UNCLASSIFIED") { t.unclassified += k; codes.add(codeWord(r.errorCode)); }
  }
  if (codes.size > 0) t.unclassifiedCodes = [...codes];
  if (opts.populationUnknown) t.populationUnknown = true;
  return t;
}
