/**
 * lib/alerts/authorities.ts  (OPS-5 S5)
 *
 * The set of EXISTING health authorities the alert engine consumes, named once.
 * This module holds ZERO computation — it only imports the authority result
 * TYPES (type-only, no runtime) and bundles them, so the pure engine
 * (evaluate.ts) classifies signals over authority output without ever touching a
 * product table or re-deriving a health state.
 *
 * The impure gather (lib/alerts/run.ts) is the ONE place that calls the
 * authority functions; this module is the shared contract between gather and
 * engine.
 */

import type { JobHealthStatus } from "@/lib/jobs/health";
import type { ConnectionHealthResult } from "@/lib/connections/health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import type { AiFailureHealth } from "@/lib/platform/ai/failures";
import type { AiSpendHealth } from "@/lib/platform/ai/spend-health";
import type { PolicyAssignmentHealth } from "@/lib/entitlements/assignment-health-core";
import type { AnomalyWindow } from "@/lib/alerts/anomaly";

/** The authority a rule reads. `provider-quota` names the not-yet-shipped
 *  OPS-5 S3 authority the dormant `quota-low` rule will bind to.
 *  `ai-failures` (OPERATIONALIZATION P0) is the AiInvocation ledger's outcome
 *  dimension, folded by lib/platform/ai/failures.ts. `ai-spend` (BETA C7) is
 *  the same ledger's RETURNED customer-surface rows priced by the rate card
 *  over the trailing 24 h, folded by lib/platform/ai/spend-health.ts. */
export type AlertAuthority =
  | "job-health"
  | "connection-health"
  | "resource-freshness"
  | "ai-failures"
  | "ai-spend"
  | "sync-incidents"
  | "policy-assignments"
  | "provider-usage"
  | "provider-quota";

/**
 * OBS-004 — the MINIMAL slice of the incident-intelligence module's verdicts
 * the engine reads: the ALERTABLE episodes (PB-1 R5 — the module's `alertable`
 * verdict, read with the SYSTEM token) with the module's severity. Folded by
 * lib/alerts/sync-incidents.ts; the engine never touches a SyncIssue row and
 * never decides open/closed. Carries opaque ids only — never `detail`, never a
 * label that names an institution.
 */
export interface AlertSyncIncident {
  /** SyncIssue.id (opaque). */
  id: string;
  /** PlaidItem.id when the episode names one (opaque); null for wallet / import episodes. */
  plaidItemId: string | null;
  kind: string;
  domain: string;
  severity: "critical" | "error" | "warning" | "info";
  lastOccurredAt: string | null;
  occurrenceCount: number;
}
export interface SyncIncidentHealth {
  checkedAt: string;
  /** Alertable episodes (module verdict), every severity; the rule filters to critical. */
  active: readonly AlertSyncIncident[];
  /** True when the underlying scan hit its ceiling — `active` is then a floor. */
  scanTruncated: boolean;
}

/**
 * The MINIMAL slice of a job-health report the alert engine reads. Deliberately
 * NOT the full JobHealthReport: the OPS-4 authority (and its OPS-5 S2 rich
 * extension) carries many fields the alerting rules never touch, and coupling to
 * the full shape would make this slice churn every time a field is added. The
 * real ScheduledJobsHealth is structurally assignable to this, so the gather
 * boundary passes it through unchanged.
 */
export interface AlertJobHealthReport {
  job: string;
  status: JobHealthStatus;
  expectedEveryHours: number;
  consecutiveFailures: number;
}
export interface AlertJobHealth {
  jobs: readonly AlertJobHealthReport[];
}

/**
 * Quota/cost anomaly (anomaly@1, lib/alerts/anomaly.ts) — the AI spend fold
 * (lib/platform/ai/spend-health.ts foldSpendGroups, the SAME fold the fleet
 * rule reads) over 8 consecutive trailing 24 h windows: `current` ends at
 * `checkedAt`, `baseline` holds the 7 before it, newest first. Customers are
 * named by OPAQUE references only (opaqueUserRef / opaqueDedupeToken); a raw
 * user id never reaches this shape.
 */
export interface AiSpendAnomalyFacts {
  checkedAt: string;
  windowHours: number;
  fleet: { current: AnomalyWindow; baseline: AnomalyWindow[] };
  /** Customers with priced spend in the CURRENT window. Empty when that window is not priced. */
  customers: Array<{ ref: string; dedupe: string; current: AnomalyWindow; baseline: AnomalyWindow[] }>;
}

/**
 * Plaid provider calls per UTC day from the ApiUsageCounter ledger
 * (provider "PLAID", unit "calls" — lib/plaid/client.ts records one per call).
 * The ledger's grain is the UTC day, so `current` is the last COMPLETE day
 * (`dayISO`) and `baseline` the 7 days before it, newest first.
 */
export interface PlaidCallAnomalyFacts {
  checkedAt: string;
  dayISO: string;
  current: AnomalyWindow;
  baseline: AnomalyWindow[];
}

/**
 * The already-fetched output of every consumable authority, gathered ONCE per
 * evaluation cycle and passed to the pure engine. An authority that failed to
 * gather is `null` (its rules simply produce no signals that cycle — a gather
 * failure never fabricates or suppresses a breach). `provider-quota` has no
 * field: it is not yet a consumable authority.
 */
export interface AuthorityOutputs {
  jobHealth: AlertJobHealth | null;
  connectionHealth: ConnectionHealthResult | null;
  resourceFreshness: ResourceFreshnessResult | null;
  /** AI provider failure facts over the evaluation window (null = did not gather). */
  aiFailures: AiFailureHealth | null;
  /** BETA C7 — estimated AI spend (fleet + max per customer) and the unpriced count over 24 h (null = did not gather). */
  aiSpend: AiSpendHealth | null;
  /** OBS-004 — active sync incidents (null = did not gather). */
  syncIncidents: SyncIncidentHealth | null;
  /** Owner ruling (2026-10-30) — missing / invalid customer policy-group assignments
   *  (lib/platform/policy-assignment-health.ts). Optional: absent = did not gather. */
  policyAssignments?: PolicyAssignmentHealth | null;
  /** Quota/cost anomaly — AI spend windows. Optional: absent = did not gather. */
  aiSpendAnomaly?: AiSpendAnomalyFacts | null;
  /** Quota/cost anomaly — Plaid calls per day. Optional: absent = did not gather. */
  plaidCallAnomaly?: PlaidCallAnomalyFacts | null;
}
