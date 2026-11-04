/**
 * lib/jobs/scheduler-presence.core.ts  (Ops env-aware verdicts)
 *
 * The PURE half of lib/jobs/scheduler-presence.ts — no environment read, so it
 * is safe for client view-models and pure tests. See that module's header for
 * the contract: the presence of a scheduler is decided SERVER-SIDE from the
 * deployment environment; nothing here reads it.
 */

/** The deployment environments the decision is defined over (lib/env.ts DeploymentEnvironment). */
export type SchedulerEnvironment = "production" | "preview" | "development";

export type SchedulerPresence = "present" | "absent";

/** Pure: the scheduler presence an environment implies. Only Preview has no scheduler. */
export function schedulerPresenceFor(env: SchedulerEnvironment): SchedulerPresence {
  return env === "preview" ? "absent" : "present";
}

/** The words for a job the environment never schedules — one place, shared by every reader. */
export const NOT_SCHEDULED_LABEL = "Not scheduled in this environment";
