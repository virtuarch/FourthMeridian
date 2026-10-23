/**
 * lib/alerts/latest-evaluation.ts  (UX-P1 · Agent 2)
 *
 * WHAT "FIRING NOW" MEANS, AND THE ONLY PLACE IT IS DEFINED.
 *
 * There is no alert open/resolved authority in Fourth Meridian: the ledger is
 * the alert store, and each evaluate-alerts JobRun summary records every rule's
 * outcome for THAT cycle (`AlertRuleOutcome.firing`). So the one honest notion
 * of "active" is: the rule breached in the LATEST evaluation. The `fired`
 * records across recent runs are a DELIVERY HISTORY — they say an email went
 * out, not that the condition still holds — and a surface that ranks them as
 * open keeps "Action needed" lit for days after a breach cleared (investigation
 * §4 pain point 8, §13 risk 1).
 *
 * This module is PURE so the projection is testable without the database, and
 * so the alerts route, the overview posture and the Attention reader all get
 * the same answer from the same function. It strips `destination` — an email
 * address — on purpose: the run summary carries it for the operator's record,
 * but it never crosses into a PLATFORM_OPS payload.
 */

import type { AlertRuleOutcome, AlertRunSummary, AlertUndelivered } from "@/lib/alerts/evaluate";

/** The latest evaluation, projected for a read surface. No destination. */
export interface AlertLatestEvaluation {
  evaluatedAtISO: string;
  deliveryStatus: AlertRunSummary["deliveryStatus"];
  /**
   * OBS-003 — breaches that were due and did NOT reach a real transport, with
   * the reason. Null = nothing was lost, or the run predates the field (older
   * rows are projected as null; a reader must not infer "delivered" from null
   * alone — `deliveryStatus` carries that). Optional on the TYPE so fixtures
   * written before the field still type; the projector always sets it.
   */
  undelivered?: AlertUndelivered | null;
  /** OBS-011 — presence of a destination at evaluation time; null when the run predates the field. */
  destinationConfigured?: boolean | null;
  counts: AlertRunSummary["counts"];
  /** Every rule's outcome in that run; `firing` is the only "active" there is. */
  rules: AlertRuleOutcome[];
}

/**
 * Project the newest summary (callers pass newest-first) to the read shape.
 * Null when no evaluation has ever been recorded — which a consumer renders as
 * UNKNOWN, never as "nothing firing". A summary written before per-rule
 * outcomes existed carries no `rules`; it is still an evaluation, with an
 * empty outcome list rather than an invented one.
 */
export function latestAlertEvaluation(recent: readonly AlertRunSummary[]): AlertLatestEvaluation | null {
  const newest = recent[0];
  if (!newest) return null;
  return {
    evaluatedAtISO: newest.evaluatedAtISO,
    deliveryStatus: newest.deliveryStatus,
    undelivered: undeliveredOnly(newest.undelivered),
    // A legacy row carried the address; its PRESENCE is all that is projected.
    destinationConfigured:
      typeof newest.destinationConfigured === "boolean" ? newest.destinationConfigured
      : typeof newest.destination === "string" ? newest.destination.length > 0
      : newest.destination === null ? false
      : null,
    counts: newest.counts,
    rules: Array.isArray(newest.rules) ? newest.rules.map(outcomeOnly) : [],
  };
}

/** Rebuilt field by field (reason word + count only). */
function undeliveredOnly(u: AlertRunSummary["undelivered"]): AlertUndelivered | null {
  if (!u || typeof u !== "object") return null;
  const reason = u.reason;
  const breaches = typeof u.breaches === "number" ? u.breaches : 0;
  if (reason !== "NO_EMAIL_TRANSPORT" && reason !== "NO_DESTINATION" && reason !== "SEND_ERROR" && reason !== "LEDGER_WRITE_FAILED") return null;
  return { reason, breaches };
}

/** OBS-003 — one operator sentence for an undelivered outcome. Pure; no address, no content. */
export function undeliveredSentence(u: AlertUndelivered): string {
  const n = `${u.breaches} breach${u.breaches === 1 ? "" : "es"}`;
  switch (u.reason) {
    case "NO_EMAIL_TRANSPORT": return `${n} NOT delivered — no email transport: RESEND_API_KEY is not set, so the message was captured in memory and reached nobody.`;
    case "NO_DESTINATION":     return `${n} NOT delivered — PLATFORM_ALERTS_EMAIL is not set.`;
    case "SEND_ERROR":         return `${n} NOT delivered — the email provider returned an error; the next evaluation retries.`;
    case "LEDGER_WRITE_FAILED": return `${n} NOT delivered — the evaluator's own JobRun row failed to write, so delivery was circuit-broken to prevent an alert storm.`;
  }
}

/** The outcomes that breached in the latest run — the "firing now" set. */
export function firingNow(latest: AlertLatestEvaluation | null): AlertRuleOutcome[] {
  return latest ? latest.rules.filter((r) => r.firing) : [];
}

/** Rebuilt field by field so an unexpected key on a persisted summary never rides along. */
function outcomeOnly(r: AlertRuleOutcome): AlertRuleOutcome {
  return { id: r.id, kind: r.kind, enabled: r.enabled, live: r.live, firing: r.firing, breaches: r.breaches, severity: r.severity };
}
