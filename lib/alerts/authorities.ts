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
  | "provider-quota";

/**
 * OBS-004 — the MINIMAL slice of the sync-incident read model the engine
 * reads: ACTIVE episodes (lib/platform/incidents/projections.ts, state
 * "active" by the semantic authority) with their derived severity. Folded by
 * lib/alerts/sync-incidents.ts from IncidentView; the engine never touches a
 * SyncIssue row. Carries opaque ids only — never `detail`, never a label that
 * names an institution.
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
  /** Active episodes, every severity; the rule filters to critical. */
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
}
