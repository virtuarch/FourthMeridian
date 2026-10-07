/**
 * lib/refresh/outcomes.ts  (P1 — provider-agnostic Refresh All: the VOCABULARY)
 *
 * "Refresh All" means: refresh Fourth Meridian's understanding from EVERY
 * eligible connected financial authority — not "refresh Plaid". Every authority
 * the orchestrator considers gets exactly one structured outcome, so the surface
 * never pretends a provider refreshed when it was skipped or refused, and an
 * operator can read why.
 *
 * Pure types + one fold. The orchestrator (lib/refresh/refresh-all.ts) composes
 * the existing execution primitives (runFullRefresh under the Plaid item lock;
 * syncWalletByChain under the wallet claim) and never adds a second execution
 * path. Two AUTHORITIES share this vocabulary and nothing else: the customer's
 * own "Refresh All" (entitlement-bounded, ledgered as REFRESH_ALL_REQUESTED) and
 * an operator's refresh on a customer's behalf (OPERATOR_REFRESH_ALL, audited
 * through recordOperatorAction).
 */

/** The kinds of financial authority a customer can have connected today. */
export type RefreshAuthorityKind = "PLAID_ITEM" | "WALLET";

export type RefreshDecision = "STARTED" | "SKIPPED" | "REFUSED" | "FAILED";

export type RefreshSkipReason =
  | "COOLDOWN"        // the customer's manual-refresh cooldown is active
  | "IN_FLIGHT"       // another sync holds this authority's lock
  | "FRESH"           // refreshed recently enough under policy (operator path only)
  | "NOT_REFRESHABLE" // e.g. a chain with no sync adapter, an Item not ACTIVE
  | "NOT_ADMITTED"    // platform admission (maintenance / ingestion pause) denied work
  | "NOT_ENTITLED"    // the customer's effective entitlement excludes it
  | "RATE_LIMITED"    // a per-user ceiling (e.g. wallet syncs/hour) is exhausted
  | "BUDGET"          // the sequential wallet pass ran out of wall-clock budget; nothing was dropped
  | "ERROR";          // the refresh ran and failed (decision FAILED)

export interface RefreshAuthorityOutcome {
  kind: RefreshAuthorityKind;
  /** PlaidItem.id or FinancialAccount.id — the authority's own id, never a secret. */
  id: string;
  /** Institution name or wallet chain label. */
  label: string;
  decision: RefreshDecision;
  reason: RefreshSkipReason | null;
  /** Seconds until the authority may be retried, when the reason is time-based. */
  retryAfterSeconds?: number;
  /** RefreshExecution.id when one was opened. */
  executionId?: string | null;
  /** Which effective entitlement dimension produced NOT_ENTITLED / COOLDOWN, when applicable. */
  entitlement?: string;
}

export interface RefreshAllSummary {
  considered: number;
  started: number;
  skipped: number;
  refused: number;
  failed: number;
  byReason: Partial<Record<RefreshSkipReason, number>>;
}

export interface RefreshAllReport {
  authority: "USER" | "OPERATOR";
  userId: string;
  startedAtISO: string;
  outcomes: RefreshAuthorityOutcome[];
  summary: RefreshAllSummary;
}

/** PURE — fold outcomes into counts (what the audit row and the UI show). */
export function summarizeRefreshOutcomes(outcomes: readonly RefreshAuthorityOutcome[]): RefreshAllSummary {
  const s: RefreshAllSummary = { considered: outcomes.length, started: 0, skipped: 0, refused: 0, failed: 0, byReason: {} };
  for (const o of outcomes) {
    if (o.decision === "STARTED") s.started++;
    else if (o.decision === "SKIPPED") s.skipped++;
    else if (o.decision === "REFUSED") s.refused++;
    else s.failed++;
    if (o.reason) s.byReason[o.reason] = (s.byReason[o.reason] ?? 0) + 1;
  }
  return s;
}

// ── Presentation of a report — ONE sentence, shared by the customer's Refresh
// button and the operator's Customer Success action, so neither surface invents
// its own semantics for the same outcomes ───────────────────────────────────────

export type RefreshPhase = "idle" | "loading" | "done" | "error" | "cooldown" | "partial";

/** The subset of an outcome a surface reads to describe it. */
export interface RefreshOutcomeLike {
  kind?: string;
  label?: string;
  decision?: RefreshDecision;
  reason?: string | null;
  retryAfterSeconds?: number;
}

/** secs → " (42m)" (ceil), or "" when unknown. */
function minutesLabel(secs: unknown): string {
  return typeof secs === "number" && secs > 0 ? ` (${Math.ceil(secs / 60)}m)` : "";
}

/** PURE — the terse banner: "3 refreshed · 1 on cooldown (42m) · 1 not refreshable". */
export function describeRefreshOutcomes(outcomes: readonly RefreshOutcomeLike[]): string {
  const started = outcomes.filter((o) => o.decision === "STARTED").length;
  const cooldown = outcomes.filter((o) => o.reason === "COOLDOWN");
  const inFlight = outcomes.filter((o) => o.reason === "IN_FLIGHT").length;
  const rate = outcomes.filter((o) => o.reason === "RATE_LIMITED").length;
  const notRefreshable = outcomes.filter((o) => o.reason === "NOT_REFRESHABLE" || o.reason === "NOT_ENTITLED").length;
  const paused = outcomes.filter((o) => o.reason === "NOT_ADMITTED").length;
  const budget = outcomes.filter((o) => o.reason === "BUDGET").length;
  const failed = outcomes.filter((o) => o.decision === "FAILED").length;
  const longestWait = cooldown.reduce((m, o) => Math.max(m, o.retryAfterSeconds ?? 0), 0);
  const parts: string[] = [];
  if (started) parts.push(`${started} refreshed`);
  if (cooldown.length) parts.push(`${cooldown.length} on cooldown${minutesLabel(longestWait)}`);
  if (inFlight) parts.push(`${inFlight} already syncing`);
  if (rate) parts.push(`${rate} over the hourly limit`);
  if (notRefreshable) parts.push(`${notRefreshable} not refreshable`);
  if (paused) parts.push(`${paused} paused by the platform`);
  if (budget) parts.push(`${budget} deferred`);
  if (failed) parts.push(`${failed} failed`);
  return parts.length ? parts.join(" · ") : "nothing to refresh";
}

/** PURE — the phase a report resolves to. */
export function phaseForOutcomes(outcomes: readonly RefreshOutcomeLike[]): Exclude<RefreshPhase, "idle" | "loading"> {
  const started = outcomes.filter((o) => o.decision === "STARTED").length;
  const failed = outcomes.filter((o) => o.decision === "FAILED").length;
  if (outcomes.length === 0 || started === outcomes.length) return "done";
  if (started > 0) return "partial";
  return failed > 0 ? "error" : "cooldown";
}
