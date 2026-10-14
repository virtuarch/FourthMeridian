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

import type { AlertRuleOutcome, AlertRunSummary } from "@/lib/alerts/evaluate";

/** The latest evaluation, projected for a read surface. No destination. */
export interface AlertLatestEvaluation {
  evaluatedAtISO: string;
  deliveryStatus: AlertRunSummary["deliveryStatus"];
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
    counts: newest.counts,
    rules: Array.isArray(newest.rules) ? newest.rules.map(outcomeOnly) : [],
  };
}

/** The outcomes that breached in the latest run — the "firing now" set. */
export function firingNow(latest: AlertLatestEvaluation | null): AlertRuleOutcome[] {
  return latest ? latest.rules.filter((r) => r.firing) : [];
}

/** Rebuilt field by field so an unexpected key on a persisted summary never rides along. */
function outcomeOnly(r: AlertRuleOutcome): AlertRuleOutcome {
  return { id: r.id, kind: r.kind, enabled: r.enabled, live: r.live, firing: r.firing, breaches: r.breaches, severity: r.severity };
}
