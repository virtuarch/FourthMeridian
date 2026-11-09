/**
 * lib/platform/stale-wording.ts  (owner rule: stale facts are never shown as current)
 *
 * THE ONE PHRASEBOOK for a fact that is too old to speak for now. Platform Ops
 * (the Platform Health drawer, the Attention table) and Platform AI (the
 * operational briefing and the metric tools) both word staleness through these
 * helpers, so an operator reads the same sentence in the UI and in an answer.
 *
 * Pure, React-free, clock-free: callers hand in the already-decided "when"
 * text (a relative age such as "9 h ago" or an absolute time). Whether a fact
 * IS stale is decided elsewhere (alertEvaluatorSilence for the evaluator; the
 * metrics registry's per-metric limit for Platform AI) — never here.
 */

/** The qualifier every stale fact carries, verbatim. */
export const STALE_QUALIFIER = "may be out of date";

/** Appended where the stale source is the alert evaluator itself. */
export const EVALUATOR_OVERDUE = "evaluator overdue";

/**
 * "last evaluated 9 h ago, may be out of date". A missing or unreadable time is
 * stated as such — it is never omitted and never rendered as "now".
 */
export function lastEvaluatedStale(when: string | null, verb: "evaluated" | "updated" = "evaluated"): string {
  return when == null || when.trim() === ""
    ? `last ${verb} time not recorded, ${STALE_QUALIFIER}`
    : `last ${verb} ${when}, ${STALE_QUALIFIER}`;
}

/** "3 rules firing at last evaluation" — the stale counterpart of "firing now". */
export function firingAtLastEvaluation(n: number): string {
  return `${n} rule${n === 1 ? "" : "s"} firing at last evaluation`;
}

/** "3 rules firing at last evaluation (evaluator overdue)". */
export function firingAtLastEvaluationOverdue(n: number): string {
  return `${firingAtLastEvaluation(n)} (${EVALUATOR_OVERDUE})`;
}
