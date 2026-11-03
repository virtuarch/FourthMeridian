/**
 * lib/platform/verdicts/provider-outcome.ts  (Ops env-aware verdicts — provider rule v1)
 *
 * THE ONE RULE that turns a provider's recorded outcome COUNTS into a verdict.
 * Shared by the server read-model (lib/platform/provider-health.ts — producing
 * job runs) and the Providers dashboard (components/platform/leads/providers-model.ts
 * — ProviderCall attempts), so the two can never disagree about what a failure
 * count means. Pure and client-safe: no clock, no environment, no I/O.
 *
 * Before v1 a single failed run out of one or two in the window (error rate
 * ≥ 50 %) made a provider FAILING, and any failure at all DEGRADED it, whatever
 * the sample. A verdict needs evidence; v1 states how much.
 *
 * DEFINITION (provider-outcome@1), over one evidence kind at a time, in THIS
 * order (the first step that matches decides):
 *
 *   1.  RECENCY      the last `recentFailingRun` outcomes ALL failed   ⇒ FAILING
 *                    (ordered evidence only — job runs; ProviderCall roll-ups
 *                    carry no order, so for calls this step is skipped).
 *   2b. ALL FAILED   unordered evidence (calls) with at least
 *                    `recentFailingRun` decided outcomes, every one failed ⇒ FAILING
 *                    (all-failed needs no ordering).
 *   2a. SMALL SAMPLE fewer than `minSample[kind]` decided outcomes, but at
 *                    least one failed                                  ⇒ DEGRADED
 *                    (a small sample never HIDES a failure; basis
 *                    "N of M … failed — small sample").
 *   2.  SAMPLE       fewer than `minSample[kind]` decided outcomes, none failed
 *                                                                      ⇒ NOT_ENOUGH_DATA
 *                    (never HEALTHY — too few outcomes is not "fine").
 *   3.  RATIO        failed / decided ≥ `failingRatio`                 ⇒ FAILING
 *   4.  ISOLATED     any failure below that ratio                      ⇒ DEGRADED
 *   5.  NONE         no failure in a sufficient sample                 ⇒ HEALTHY
 *
 * Fail-safe direction: steps 1, 2b and 2a run BEFORE the sample floor, so the
 * floor can only withhold a HEALTHY verdict — it never downgrades a failure to
 * "Not enough data" (review fix, 2026-11-03: 1/1 and 2/2 failed runs, 19/19 and
 * 10/15 failed calls must not read NOT_ENOUGH_DATA).
 *
 * Every input is a count an operator can drill to: job runs are JobRun rows in
 * the provider window; calls are ProviderCall attempt rows in the 7-day roll-up.
 * The result carries its inputs and the definition id, so a verdict on screen
 * traces to the rule and to the records that produced it.
 */

/**
 * THE failing share shared by every provider verdict definition (provider-outcome@1
 * failed outcomes, provider-connection@1 connections in provider-side ERROR, and
 * its reauth-wave share): at or above half, the evidence says the provider — not
 * one customer — is the problem. One constant, so the rules cannot drift apart.
 */
export const PROVIDER_FAILING_SHARE = 0.5;

export const PROVIDER_OUTCOME_DEFINITION = {
  id: "provider-outcome",
  version: 1,
  /** Decided outcomes required before a ratio says anything. */
  minSample: {
    /** Producing-job runs in the provider window (7 d). 3 = the shortest sample a streak or a ratio can rest on;
     *  a daily job leaves ~7 in the window. */
    runs: 3,
    /** ProviderCall attempts in the 7-day roll-up (the dashboard's long-standing floor). */
    calls: 20,
  },
  /** Failed share at or above which a sufficient sample is FAILING (the shared constant). */
  failingRatio: PROVIDER_FAILING_SHARE,
  /** The last N outcomes all failing is FAILING regardless of the ratio (ordered evidence only). */
  recentFailingRun: 3,
} as const;

/** "provider-outcome@1" — the stamp a verdict carries. */
export const PROVIDER_OUTCOME_DEFINITION_ID = `${PROVIDER_OUTCOME_DEFINITION.id}@${PROVIDER_OUTCOME_DEFINITION.version}` as const;

export type OutcomeEvidenceKind = keyof typeof PROVIDER_OUTCOME_DEFINITION.minSample;

export type OutcomeVerdict = "HEALTHY" | "DEGRADED" | "FAILING" | "NOT_ENOUGH_DATA";

export const OUTCOME_VERDICT_WORD: Readonly<Record<OutcomeVerdict, string>> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  FAILING: "Failing",
  NOT_ENOUGH_DATA: "Not enough data",
};

export interface OutcomeEvidence {
  kind: OutcomeEvidenceKind;
  /** Outcomes with a result (succeeded + failed); in-flight rows excluded. */
  decided: number;
  /** Failed outcomes among them. */
  failed: number;
  /** Leading failures, newest first — null when the evidence carries no order (calls). */
  recentConsecutiveFailures: number | null;
}

export interface OutcomeAssessment {
  verdict: OutcomeVerdict;
  definition: typeof PROVIDER_OUTCOME_DEFINITION_ID;
  /** The rule step that decided (see the order above). */
  rule: "recency" | "all-failed" | "small-sample" | "sample" | "ratio" | "isolated" | "none";
  evidence: OutcomeEvidence;
  minSample: number;
  /** One line, figures included: "1 of 20 calls failed". */
  basis: string;
}

const NOUN: Record<OutcomeEvidenceKind, [string, string]> = { runs: ["run", "runs"], calls: ["call", "calls"] };
const words = (c: number, k: OutcomeEvidenceKind) => `${c.toLocaleString("en-US")} ${NOUN[k][c === 1 ? 0 : 1]}`;

/** Apply provider-outcome@1 to one evidence kind. Pure. */
export function assessOutcomes(e: OutcomeEvidence): OutcomeAssessment {
  const d = PROVIDER_OUTCOME_DEFINITION;
  const minSample = d.minSample[e.kind];
  const decided = Math.max(0, e.decided);
  const failed = Math.min(Math.max(0, e.failed), decided);
  const evidence = { ...e, decided, failed };
  const out = (verdict: OutcomeVerdict, rule: OutcomeAssessment["rule"], basis: string): OutcomeAssessment =>
    ({ verdict, definition: PROVIDER_OUTCOME_DEFINITION_ID, rule, evidence, minSample, basis });
  const ratio = `${failed.toLocaleString("en-US")} of ${words(decided, e.kind)} failed`;

  if (e.recentConsecutiveFailures !== null && e.recentConsecutiveFailures >= d.recentFailingRun) {
    return out("FAILING", "recency", `last ${words(e.recentConsecutiveFailures, e.kind)} all failed`);
  }
  if (e.recentConsecutiveFailures === null && decided >= d.recentFailingRun && failed === decided) {
    return out("FAILING", "all-failed", `all ${words(decided, e.kind)} failed`);
  }
  if (decided < minSample && failed > 0) {
    return out("DEGRADED", "small-sample", `${ratio} — small sample`);
  }
  if (decided < minSample) {
    return out("NOT_ENOUGH_DATA", "sample", `${words(decided, e.kind)} with an outcome — ${minSample} needed for a verdict`);
  }
  if (failed / decided >= d.failingRatio) return out("FAILING", "ratio", ratio);
  if (failed > 0) return out("DEGRADED", "isolated", ratio);
  return out("HEALTHY", "none", `no failure in ${words(decided, e.kind)}`);
}
