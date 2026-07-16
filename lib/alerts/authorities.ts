/**
 * lib/alerts/authorities.ts  (OPS-5 S5)
 *
 * The set of EXISTING health authorities the alert engine consumes, named once.
 * This module holds ZERO computation — it only imports the authority result
 * TYPES (type-only, no runtime) and bundles them, so the pure engine
 * (evaluate.ts) classifies signals over authority output without ever touching a
 * product table or re-deriving a health state.
 *
 * The impure gather (lib/alerts/run.ts) is the ONE place that calls the three
 * authority functions; this module is the shared contract between gather and
 * engine.
 */

import type { JobHealthStatus } from "@/lib/jobs/health";
import type { ConnectionHealthResult } from "@/lib/connections/health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";

/** The authority a rule reads. `provider-quota` names the not-yet-shipped
 *  OPS-5 S3 authority the dormant `quota-low` rule will bind to. */
export type AlertAuthority =
  | "job-health"
  | "connection-health"
  | "resource-freshness"
  | "provider-quota";

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
}
