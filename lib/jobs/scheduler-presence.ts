/**
 * lib/jobs/scheduler-presence.ts  (Ops env-aware verdicts)
 *
 * Does THIS deployment have a scheduler that fires the registered jobs?
 *
 * Vercel fires the vercel.json crons on PRODUCTION deployments only. A Preview
 * deployment never receives a cron invocation (the dispatcher there is woken
 * only by a manual, CRON_SECRET-authorised GET — lib/jobs/registry.core.ts,
 * lib/jobs/dispatch.ts), so a job that has not run on Preview is the expected
 * state of that environment, not a failure of the job. The Operations UI has
 * said so in words since it2 (components/platform/ops-visual/ops-visual-model.ts
 * SCHEDULER_PREVIEW); this module makes the SERVER-SIDE readers say it too.
 *
 * THE DECISION IS SERVER-SIDE ONLY. It comes from `deploymentEnvironment()`
 * (lib/env.ts — VERCEL_ENV on Vercel, NODE_ENV elsewhere), never from a client
 * value, a query parameter or a header.
 *
 *   production   "present"  — behaviour is unchanged (byte-identical verdicts).
 *   development  "present"  — local runs keep today's verdicts (a developer
 *                             harness drives the dispatcher there on purpose).
 *   preview      "absent"   — jobs that did not run are "not-scheduled".
 */

import "server-only";
import { deploymentEnvironment } from "@/lib/env";
import { schedulerPresenceFor, type SchedulerPresence } from "@/lib/jobs/scheduler-presence.core";

export { NOT_SCHEDULED_LABEL, schedulerPresenceFor, type SchedulerPresence } from "@/lib/jobs/scheduler-presence.core";

/** The scheduler presence of the running deployment (server-side, from the environment). */
export function deploymentSchedulerPresence(): SchedulerPresence {
  return schedulerPresenceFor(deploymentEnvironment());
}
