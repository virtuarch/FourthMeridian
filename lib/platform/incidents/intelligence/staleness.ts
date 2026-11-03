/**
 * lib/platform/incidents/intelligence/staleness.ts  (PB-1 Phase 2 — the shared read-time STALE rule, pure)
 *
 * ONE predicate, applied ONCE by the intelligence core (./core.ts) and carried
 * on every verdict as `freshness` / `state`. Attention, alerts and the CS
 * "incident" reason never re-derive it — they read `brokenNow` / `alertable`.
 *
 * READ-TIME ONLY. Nothing here writes: `resolved` stays false (R4 — STALE is not
 * fixed) and `staleSince` is persisted by a later slice (S7), not this one.
 *
 * ── THE RULE (design §3.2, binding correction §12 P2.1) ──────────────────────
 *   current     lastOccurredAt is inside the operation's window.
 *   unverified  outside the window, BUT since lastOccurredAt the operation was
 *               ATTEMPTED (and did not fail again) or SKIPPED (cost freeze,
 *               billable gate, plan restriction, cooldown — RefreshEndpointResult
 *               .skipReason / an admission-denied execution), or the evidence
 *               could not be read. Visible, lower severity: skipped work must
 *               never be hidden by the passage of time.
 *   stale       outside the window AND the operation was neither attempted NOR
 *               skipped since lastOccurredAt. "No failure for N days, but the
 *               operation has not been proven to succeed." Leaves "broken now",
 *               never fires the critical alert, shown separately as needing
 *               verification. NOT resolved.
 *
 * The passage of time alone is never a resolution.
 */

import type { AttemptEvidence, Freshness } from "./types";

export type { AttemptEvidence };

const DAY_MS = 86_400_000;

/**
 * ⚠️ OWNER QUESTION Q2 — PROPOSED DEFAULTS, CONFIRMATION PENDING. The owner's
 * answer is a one-line change here; every consumer reads these through this
 * module (pinned by core.test.ts).
 */
export const STALE_WINDOWS_MS = {
  /** Plaid-item operations (transactions, investments, exchange). */
  plaidItem: 14 * DAY_MS,
  /** Self-custody wallet operations (balance, price, discovery, …). */
  wallet: 7 * DAY_MS,
  /** Member-triggered operations (imports, opening positions, rollbacks). */
  userTriggered: 30 * DAY_MS,
} as const;

export type StaleWindowClass = keyof typeof STALE_WINDOWS_MS;

/** Operations a member triggers by hand — nothing retries them on a schedule. */
const USER_TRIGGERED_OPERATIONS: ReadonlySet<string> = new Set([
  "investment-import-repair",
  "opening-position-repair",
  "import-rollback-repair",
]);

export function staleWindowClass(operation: string | null, provider: string | null): StaleWindowClass {
  if (operation && USER_TRIGGERED_OPERATIONS.has(operation)) return "userTriggered";
  if (provider === "WALLET") return "wallet";
  return "plaidItem";
}

export function staleWindowMs(operation: string | null, provider: string | null): number {
  return STALE_WINDOWS_MS[staleWindowClass(operation, provider)];
}

/**
 * Which refresh stages EXECUTE an operation — the attempt / skip evidence the
 * rule reads. An empty list means the ledger records no attempt of this
 * operation at all (member-triggered work, a one-off exchange): "neither
 * attempted nor skipped" is then literally what the ledger can say.
 */
export function attemptEndpointsFor(operation: string | null, provider: string | null): readonly string[] {
  if (provider === "WALLET") {
    if (operation === "price") return ["VALUATION"];
    if (operation === "unregistered:transactions" || operation === "wallet-ledger-reconcile") return ["TRANSACTIONS"];
    return ["WALLET_SYNC"];
  }
  if (operation && USER_TRIGGERED_OPERATIONS.has(operation)) return [];
  if (operation === "exchange-account-persist") return [];
  if (operation && (operation.startsWith("investment-") || operation === "reconstruction-repair")) {
    return ["HOLDINGS", "INVESTMENT_ACTIVITY"];
  }
  // Bank transactions (and legacy rows with no key, which classify there).
  return ["TRANSACTIONS"];
}


export const UNKNOWN_EVIDENCE: AttemptEvidence = { known: false, lastAttemptAt: null, lastSkipAt: null };

export type IncidentFreshness = Freshness;

export interface FreshnessInput {
  operation: string | null;
  provider: string | null;
  lastOccurredAt: Date;
  now: Date;
  evidence: AttemptEvidence;
}

/** True when the row is outside its window (and so needs attempt evidence). */
export function isPastStaleWindow(i: Pick<FreshnessInput, "operation" | "provider" | "lastOccurredAt" | "now">): boolean {
  return i.now.getTime() - i.lastOccurredAt.getTime() >= staleWindowMs(i.operation, i.provider);
}

export function incidentFreshness(i: FreshnessInput): IncidentFreshness {
  if (!isPastStaleWindow(i)) return "current";
  if (!i.evidence.known) return "unverified";
  const after = (t: Date | null) => t !== null && t.getTime() > i.lastOccurredAt.getTime();
  if (after(i.evidence.lastAttemptAt) || after(i.evidence.lastSkipAt)) return "unverified";
  return "stale";
}

/** One notch lower, for an unverified row (critical → error → warning → info). */
export function demoteSeverity<S extends "critical" | "error" | "warning" | "info">(s: S): "critical" | "error" | "warning" | "info" {
  return s === "critical" ? "error" : s === "error" ? "warning" : "info";
}

/** Operator wording for the two non-current states. */
export function freshnessText(f: IncidentFreshness, operation: string | null, provider: string | null): string | null {
  const days = Math.round(staleWindowMs(operation, provider) / DAY_MS);
  if (f === "stale") return `Stale — no failure for ${days}+ days and no attempt recorded since; not proven to succeed (needs verification)`;
  if (f === "unverified") return `Unverified — no failure for ${days}+ days, but the operation has not been proven to succeed`;
  return null;
}
