/**
 * lib/platform/verdicts/provider-connection.ts  (provider trust, connection scope — rule v2)
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
 * v2 (S2 P8 item 5): ERROR concentrated on ONE institution is an institution
 * incident, not a provider one. Under v1 one bank's outage could mark the whole
 * provider Failing. v2 sets the worst institution aside before it fails the
 * provider (Step 2, rule 1). v1 is retired: nothing computes it any more.
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
 * ── Step 2: the verdict (provider-connection@2), first match decides ─────────
 * The denominator `active` is the provider's LIVE connection population: every
 * connection except REVOKED and those whose owner is inactive or pending
 * deletion (lib/connections/health.ts "retired"). PlaidItem and Connection have
 * no soft-delete column; a removed connection is REVOKED.
 *
 * `institutions` (optional) is the same population split by institution:
 * anonymous per-institution counts (active / error / reauth), never a name or
 * a key. Connections without a recorded institution are in `active` but in no
 * institution; they are UNATTRIBUTED.
 *
 *   1. ERROR SHARE    error ≥ FAILING_SHARE × active, with active ≥ 2, then:
 *      a. CONCENTRATION  some ONE institution explains it: it holds a strict
 *                        majority (> FAILING_SHARE) of the errors, AND with its
 *                        connections set aside the rest of the fleet no longer
 *                        meets the share (rest error < FAILING_SHARE × rest
 *                        active, or no error is left)                     ⇒ DEGRADED
 *                        ("institution-concentrated"; the basis says "1 institution"
 *                        and counts, never a name)
 *      b. otherwise      the errors span ≥ 2 institutions with no one
 *                        institution explaining them                      ⇒ FAILING
 *      Unattributed errors are never assumed to share an institution: they stay
 *      in "the rest". With no institution split at all the concentration is
 *      not assessed and v1's share alone decides (FAILING), saying so. A
 *      downgrade needs evidence.
 *   2. ANY ERROR      error > 0 (incl. a lone 1/1)                      ⇒ DEGRADED
 *   3. REAUTH WAVE    reauth ≥ FAILING_SHARE × active, with active ≥ 4  ⇒ DEGRADED
 *                     reauth NEVER fails a provider, so the verdict does not
 *                     move; the same concentration test only chooses the words:
 *                     "possible provider-side reauth wave" vs
 *                     "concentrated at 1 institution — institution-side reauth wave".
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
 * WHY "majority + set the worst institution aside" rather than "top share ≥ X %
 * of errors": it needs no second threshold (both tests reuse the one failing
 * share), and it reads as the questions an operator asks — "is most of this one
 * bank?" and "is the provider failing anywhere ELSE?". "All errors at one
 * institution" is its simplest case (nothing left), and an overwhelming share
 * falls out of it (10 of 11 errors at one institution, 1 of 10 elsewhere ⇒
 * DEGRADED). A real provider outage that also hits a large institution still
 * FAILS (the rest still meets the share), and so do two institutions down
 * side by side (neither holds a majority).
 *
 * A single-institution fleet can never reach FAILING on the connection half; a
 * genuine provider outage also fails the producing job's runs, so
 * provider-outcome@1 raises FAILING through the execution half.
 * 'Degraded (institution-concentrated)' does NOT mean the provider is fine.
 */

import { PROVIDER_FAILING_SHARE } from "./provider-outcome";

export const PROVIDER_CONNECTION_DEFINITION = {
  id: "provider-connection",
  version: 2,
  /** Shared with provider-outcome@1: at or above this share, the provider is the problem. */
  failingShare: PROVIDER_FAILING_SHARE,
  /** Live connections needed before an ERROR share can FAIL a provider (1/1 only degrades). */
  minActiveForErrorShare: 2,
  /** Live connections needed before a reauth share is read as a provider-side wave. */
  minActiveForReauthWave: 4,
  /**
   * The rest of the fleet (the worst institution set aside) is judged by the SAME
   * share; it needs at least this many errors to fail the provider, so FAILING
   * always means errors at ≥ 2 institutions (or unattributed beside one).
   */
  minRestErrorsToFail: 1,
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
  /**
   * The same live population split by institution: ANONYMOUS counts, one entry
   * per institution, no name and no key (OPS identity tier). Connections with no
   * recorded institution are in `active` but in no entry (unattributed).
   * Absent ⇒ the split is unknown and concentration is not assessed.
   */
  institutions?: readonly InstitutionTally[];
}

/** One institution's share of a provider's live connections (counts only). */
export interface InstitutionTally { active: number; error: number; reauth: number }

/** At most this many codes are named in an unclassified basis; the rest are counted ("+2 more"). */
export const UNCLASSIFIED_CODES_SHOWN = 3;
/** The words for a code-less unclassified error. */
export const NO_CODE = "no code";

export type ConnectionVerdict = "FAILING" | "DEGRADED" | null;

export interface ConnectionAssessment {
  definition: typeof PROVIDER_CONNECTION_DEFINITION_ID;
  /** null = connections do not move the provider's trust. */
  verdict: ConnectionVerdict;
  rule: "error-share" | "institution-concentrated" | "any-error" | "reauth-wave" | "unclassified" | "none";
  /**
   * How the deciding share is spread across institutions (error-share,
   * institution-concentrated and reauth-wave only; null otherwise):
   * "spread" = it holds without the worst institution; "institution" = one
   * institution explains it; "not-assessed" = no institution split.
   */
  concentration: "spread" | "institution" | "not-assessed" | null;
  tally: ConnectionTally;
  /** The deciding line, with its counts (null when there is no verdict). */
  basis: string | null;
  /** Neutral facts that never drive trust ("4 connections need the customer to reconnect"). */
  facts: string[];
}

const conns = (c: number) => `${c.toLocaleString("en-US")} connection${c === 1 ? "" : "s"}`;
const insts = (c: number) => `${c.toLocaleString("en-US")} institution${c === 1 ? "" : "s"}`;

/** The result of setting one institution aside. */
export interface ConcentrationTest {
  kind: "spread" | "institution" | "not-assessed";
  /** The deciding count at the institution that explains it (kind "institution"). */
  atTop: number;
  /** The deciding count left outside that institution, and the live connections there. */
  rest: number;
  restActive: number;
  /** Institutions with at least one of the counted connections (attributed only). */
  institutionsHit: number;
  /** Counted connections with no recorded institution. */
  unattributed: number;
}

/**
 * Can ONE institution explain a share? An institution explains it when it holds
 * a strict majority of the counted connections AND, with its connections set
 * aside, the rest of the fleet no longer meets the share (or has fewer than
 * `minRest` counted). The institution that leaves the smallest rest share is
 * the one described (by count, never name). Pure; exported for tests.
 */
export function concentrationOf(t: ConnectionTally, which: "error" | "reauth", minRest: number): ConcentrationTest {
  const total = which === "error" ? t.error : t.reauth;
  const active = Math.max(0, t.active);
  if (!t.institutions) return { kind: "not-assessed", atTop: 0, rest: total, restActive: active, institutionsHit: 0, unattributed: total };
  const share = PROVIDER_CONNECTION_DEFINITION.failingShare;
  const attributed = t.institutions.reduce((a, i) => a + i[which], 0);
  const hit = t.institutions.filter((i) => i[which] > 0);
  const base = { institutionsHit: hit.length, unattributed: Math.max(0, total - attributed) };
  let best: { atTop: number; rest: number; restActive: number } | null = null;
  for (const i of hit) {
    // It must hold MOST of the counted connections (a strict majority: a 50/50 split is spread)…
    if (!(i[which] > share * total)) continue;
    const rest = total - i[which];
    const restActive = Math.max(0, active - i.active);
    // …and the rest of the fleet, judged by the same share, must not fail without it.
    const holds = rest >= minRest && restActive > 0 && rest >= share * restActive;
    if (holds) continue;
    // Smallest rest share wins; ties go to the institution holding more.
    const r = restActive > 0 ? rest / restActive : 0;
    const b = best ? (best.restActive > 0 ? best.rest / best.restActive : 0) : Infinity;
    if (!best || r < b || (r === b && i[which] > best.atTop)) best = { atTop: i[which], rest, restActive };
  }
  if (best) return { kind: "institution", ...best, ...base };
  return { kind: "spread", atTop: 0, rest: total, restActive: active, ...base };
}

/** " across 3 institutions (+2 without a recorded institution)" — counts only. */
function spreadWords(c: ConcentrationTest): string {
  if (c.kind === "not-assessed") return " — institution not recorded, concentration not assessed";
  const un = c.unattributed > 0 ? `${c.institutionsHit > 0 ? " +" : " "}${conns(c.unattributed)} without a recorded institution` : "";
  return c.institutionsHit > 0 ? ` across ${insts(c.institutionsHit)}${un}` : ` —${un}`;
}

/** ", all at 1 institution" / ", 10 at 1 institution (1 of 10 elsewhere)" — counts only, never a name. */
function concentratedWords(c: ConcentrationTest): string {
  return c.rest === 0 ? `, all at 1 institution` : `, ${c.atTop.toLocaleString("en-US")} at 1 institution (${c.rest.toLocaleString("en-US")} of ${conns(c.restActive)} elsewhere)`;
}

/** Step 2: provider-connection@2 over one provider's tallies. Pure. */
export function assessConnections(t: ConnectionTally): ConnectionAssessment {
  const d = PROVIDER_CONNECTION_DEFINITION;
  const active = Math.max(0, t.active);
  const tally = { ...t, active };
  // active 0 = the population is unknown (a payload without per-source tallies): no share rule can fire.
  const of = (k: number) => active > 0 ? `${k.toLocaleString("en-US")} of ${conns(active)}` : conns(k);
  const facts: string[] = [];
  if (t.reauth > 0) facts.push(`${conns(t.reauth)} need${t.reauth === 1 ? "s" : ""} the customer to reconnect`);
  if (t.revoked > 0) facts.push(`${conns(t.revoked)} revoked by the customer`);
  const out = (verdict: ConnectionVerdict, rule: ConnectionAssessment["rule"], basis: string | null, concentration: ConnectionAssessment["concentration"] = null): ConnectionAssessment =>
    ({ definition: PROVIDER_CONNECTION_DEFINITION_ID, verdict, rule, concentration, tally, basis: basis && t.populationUnknown ? `${basis} — connection population unavailable — share not computed` : basis, facts });

  if (active >= d.minActiveForErrorShare && t.error >= d.failingShare * active) {
    const c = concentrationOf(tally, "error", d.minRestErrorsToFail);
    if (c.kind === "institution") {
      return out("DEGRADED", "institution-concentrated", `${of(t.error)} in provider-side error${concentratedWords(c)} — institution-concentrated, not provider-wide`, "institution");
    }
    return out("FAILING", "error-share", `${of(t.error)} in provider-side error${spreadWords(c)}`, c.kind);
  }
  if (t.error > 0) return out("DEGRADED", "any-error", `${of(t.error)} in provider-side error`);
  if (active >= d.minActiveForReauthWave && t.reauth >= d.failingShare * active) {
    const c = concentrationOf(tally, "reauth", 1);
    return c.kind === "institution"
      ? out("DEGRADED", "reauth-wave", `${of(t.reauth)} need reconnecting${concentratedWords(c)} — institution-side reauth wave`, "institution")
      : out("DEGRADED", "reauth-wave", `${of(t.reauth)} need reconnecting — possible provider-side reauth wave`, c.kind);
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

/**
 * Tally rows (state + code [+ institution]) into the rule's counts. `active` is
 * supplied by the caller (the live population). `institutionActive[k]` is the
 * live population of the anonymous institution ref `k`; a row's `institutionRef`
 * is that ref (null = not recorded). Without `institutionActive` the split is
 * unknown and no `institutions` are returned.
 */
export function tallyConnections(
  rows: readonly { healthState: string; errorCode: string | null; count?: number; institutionRef?: number | null }[],
  active: number,
  revoked: number,
  opts: { populationUnknown?: boolean; institutionActive?: readonly number[] } = {},
): ConnectionTally {
  const codes = new Set<string>();
  const t: ConnectionTally = { active, error: 0, reauth: 0, unclassified: 0, revoked };
  const inst = opts.institutionActive ? opts.institutionActive.map((a) => ({ active: a, error: 0, reauth: 0 })) : null;
  for (const r of rows) {
    const k = r.count ?? 1;
    const s = connectionTrustState(r.healthState, r.errorCode);
    const slot = inst && typeof r.institutionRef === "number" ? inst[r.institutionRef] : undefined;
    if (s === "ERROR") { t.error += k; if (slot) slot.error += k; }
    else if (s === "NEEDS_REAUTH") { t.reauth += k; if (slot) slot.reauth += k; }
    else if (s === "UNCLASSIFIED") { t.unclassified += k; codes.add(codeWord(r.errorCode)); }
  }
  if (codes.size > 0) t.unclassifiedCodes = [...codes];
  if (opts.populationUnknown) t.populationUnknown = true;
  // Anonymous and order-free: sorted by size, so nothing about which institution is which survives.
  if (inst) t.institutions = inst.sort((a, b) => b.active - a.active || b.error - a.error || b.reauth - a.reauth);
  return t;
}
