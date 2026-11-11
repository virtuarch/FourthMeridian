/**
 * lib/platform/incidents/job-commands.ts  (Incident drawer PR-B — S2 09gg b; PURE + client-safe)
 *
 * The ONE mapping from a scheduled job's ledger name (an incident occurrence's
 * evidence `jobName`) to the REGISTERED Manual operations command that runs it
 * (lib/platform/operations/registry.ts, `run-now:<job>`). The incident drawer's
 * "Run job" action is derived from this table SERVER-SIDE (investigation-dto.ts
 * recoveryActionsFor) and RE-VERIFIED by the operations route against the
 * incident's own evidence (action-context.ts verifiedJobIncidentId) — the
 * client never names the job.
 *
 * Kept as plain data (the registry imports SCHEDULED_JOBS, which is not
 * client-safe). incident-drawer-run-job.test.ts pins every entry to a
 * registered, mutating command with the same target and reason requirement,
 * and the key set to EXACTLY the registry's Run Now targets — a job that is not
 * a registered Run Now target (e.g. process-deletions) can never map.
 */

export interface IncidentJobCommand {
  /** The registered operations command id (`run-now:<targetJob>`). */
  commandId: string;
  /** The command requires a structured operator reason (a fleet-wide run). */
  reasonRequired: boolean;
}

export const INCIDENT_JOB_COMMANDS: Readonly<Record<string, IncidentJobCommand>> = {
  "fetch-fx-rates": { commandId: "run-now:fetch-fx-rates", reasonRequired: false },
  "fetch-security-prices": { commandId: "run-now:fetch-security-prices", reasonRequired: false },
  "sync-crypto": { commandId: "run-now:sync-crypto", reasonRequired: true },
  "sync-banks": { commandId: "run-now:sync-banks", reasonRequired: true },
  "evaluate-alerts": { commandId: "run-now:evaluate-alerts", reasonRequired: false },
  "sol-history-backfill": { commandId: "run-now:sol-history-backfill", reasonRequired: true },
};

/** The registered command for a job's ledger name, or null (unmapped / not a string ⇒ no action). */
export function jobCommandForJob(jobName: unknown): IncidentJobCommand | null {
  if (typeof jobName !== "string" || !Object.prototype.hasOwnProperty.call(INCIDENT_JOB_COMMANDS, jobName)) return null;
  return INCIDENT_JOB_COMMANDS[jobName];
}
