/**
 * lib/alerts/authority-sources.ts  (B10 monitoring — S2 ruling)
 *
 * The stable names of every authority the alert evaluator gathers, as persisted
 * in the evaluate-alerts JobRun summary (`AlertRunSummary.authorities`). Kept in
 * its own import-free module (type-only imports) so read surfaces — the Ops
 * attention / posture composers — can name a source without pulling the engine.
 */

import type { AuthorityOutputs } from "@/lib/alerts/authorities";

/**
 * B10 monitoring (S2 ruling) — EVERY authority the evaluator gathers, by its
 * stable summary key (the AuthorityOutputs field name). Names are persisted in
 * JobRun.summary.authorities: never rename one; add new keys at the end.
 * `provider-quota` is absent on purpose — it is not gathered (no field).
 */
export const ALERT_AUTHORITY_SOURCES = [
  "jobHealth",
  "connectionHealth",
  "resourceFreshness",
  "aiFailures",
  "aiSpend",
  "syncIncidents",
  "policyAssignments",
  "aiSpendAnomaly",
  "plaidCallAnomaly",
  "platformAiPurge",
] as const satisfies readonly (keyof AuthorityOutputs)[];
export type AlertAuthoritySource = (typeof ALERT_AUTHORITY_SOURCES)[number];
/** Gather outcome as persisted. `unknown` is a READ-side value only (row predates the field / unreadable entry). */
export type AlertAuthorityGatherStatus = "ok" | "failed";

/** Operator words for each source ("Alert source unavailable: <label>"). */
export const ALERT_AUTHORITY_SOURCE_LABEL: Readonly<Record<AlertAuthoritySource, string>> = {
  jobHealth: "job health",
  connectionHealth: "connection health",
  resourceFreshness: "resource freshness",
  aiFailures: "AI failures",
  aiSpend: "AI spend",
  syncIncidents: "sync incidents",
  policyAssignments: "policy assignments",
  aiSpendAnomaly: "AI spend anomaly",
  plaidCallAnomaly: "Plaid call anomaly",
  platformAiPurge: "Platform AI purge",
};
