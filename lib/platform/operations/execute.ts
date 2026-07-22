/**
 * lib/platform/operations/execute.ts  (OPS-5 S4 — Manual Operations)
 *
 * THE single manual-operation execution seam. It orchestrates a registered
 * OperationCommand onto the CANONICAL execution path and nothing else:
 *
 *   run-now (mutating): resolveJobBody() → runJob(jobName, body, {trigger:"manual"})
 *   dry-run  (preview):  builds a plan, executes NOTHING, writes no JobRun.
 *
 * WHAT IT REUSES (never re-implements):
 *   - runJob (lib/jobs/run.ts) — the only JobRun writer; a manual run is a
 *     first-class ledger citizen, tagged trigger:"manual".
 *   - The job body (SCHEDULED_JOBS via resolveJobBody) — byte-identical to the
 *     cron path.
 *   - JobRun itself as the IN-FLIGHT LOCK: a non-stale "running" row for the
 *     jobName means a run is already in progress (cron or manual), so a manual
 *     execute is refused — a double-click, or a manual run colliding with a
 *     cron tick, cannot double-run. Staleness uses the SAME window the health
 *     detector uses (STALE_RUNNING_HOURS), so a crashed run's corpse never
 *     locks the job forever. No new lock table, no new schema.
 *
 * PURE-CORE + INJECTED-IMPURITY (the run.ts / health.ts idiom): all I/O
 * (runJob, the running-row read) is injected via OperationDeps, so the engine
 * is unit-testable with in-memory fakes and no live DB. The route supplies the
 * real deps and owns auth + audit + rate-limit around this call.
 *
 * This module does NOT authorize and does NOT write AuditLog — those are the
 * route's job (they need the request/session). Keeping them out keeps this
 * engine a pure orchestration seam.
 */

import "server-only";
import { runJob as realRunJob, type JobTrigger } from "@/lib/jobs/run";
import { STALE_RUNNING_HOURS } from "@/lib/jobs/health";
import { resolveJobBody, type OperationCommand } from "./registry";

const HOUR_MS = 60 * 60 * 1000;

/** The minimal running-row shape the in-flight lock needs. */
export interface RunningJobRow {
  startedAt: Date;
}

/**
 * True when a "running" JobRun row is a LIVE in-flight lock (vs. a crashed
 * run's stale corpse). Pure — same crash-window the dead-job detector uses, so
 * "in flight" here and "healthy in-flight" there agree.
 */
export function isInFlight(row: RunningJobRow | null, now: Date): boolean {
  if (!row) return false;
  return now.getTime() - row.startedAt.getTime() <= STALE_RUNNING_HOURS * HOUR_MS;
}

/** What a Run Now WOULD do — a dry-run preflight (reads state, executes nothing). */
export interface DryRunPlan {
  targetJob: string;
  /** A Run Now runs this canonical body through runJob(trigger:"manual"). */
  wouldExecute: string;
  /** A Run Now writes one manual JobRun; a dry-run writes nothing. */
  writesJobRun: boolean;
  /** Is a run already in progress right now (would block a Run Now)? */
  inFlight: boolean;
  note: string;
}

export type OperationOutcome = "executed" | "planned" | "in-flight" | "failed";

export interface OperationRunResult {
  commandId: string;
  kind: string;
  jobName: string;
  outcome: OperationOutcome;
  /** JobRun status for an executed run ("succeeded"; "failed" arrives via outcome). */
  status?: string;
  /** The job body's result (counts/kinds/IDs only, per the JobRun summary contract). */
  summary?: unknown;
  /** Present on outcome "failed". */
  error?: string;
  /** Present on outcome "planned" (dry-run). */
  plan?: DryRunPlan;
}

/** Injected I/O — real deps in the route, fakes in tests. */
export interface OperationDeps {
  runJob: <T>(name: string, fn: () => Promise<T>, opts: { trigger: JobTrigger }) => Promise<T>;
  /** Newest "running" JobRun row for a jobName (the in-flight lock), or null. */
  findRunningJobRun: (jobName: string) => Promise<RunningJobRow | null>;
  now: () => Date;
}

/**
 * Run one registered command.
 *
 *   - dry-run / any non-mutating command: build a plan, execute nothing.
 *   - mutating command already in flight: refuse (outcome "in-flight").
 *   - otherwise: runJob(jobName, canonical-body, {trigger:"manual"}). A body
 *     throw is caught and reported as outcome "failed" — runJob has ALREADY
 *     ledgered the failure (status "failed" + errorSummary); we do not rethrow.
 */
export async function runOperation(
  command: OperationCommand,
  deps: OperationDeps,
): Promise<OperationRunResult> {
  const base = { commandId: command.id, kind: command.kind, jobName: command.jobName };

  // Non-mutating (dry-run): preflight only. NEVER touches runJob or a body.
  if (!command.mutates) {
    const running = await deps.findRunningJobRun(command.jobName);
    const inFlight = isInFlight(running, deps.now());
    const plan: DryRunPlan = {
      targetJob: command.targetJob,
      wouldExecute: `runJob("${command.jobName}", <canonical body>, { trigger: "manual" })`,
      writesJobRun: false,
      inFlight,
      note: inFlight
        ? "A run is currently in progress — a Run Now would be refused until it finishes."
        : "No run in progress — a Run Now would start immediately.",
    };
    return { ...base, outcome: "planned", plan };
  }

  // Mutating: in-flight lock (reuse the running JobRun row — no new lock table).
  const running = await deps.findRunningJobRun(command.jobName);
  if (isInFlight(running, deps.now())) {
    return { ...base, outcome: "in-flight" };
  }

  // Canonical execution: the SAME body the dispatcher runs, through runJob.
  const body = resolveJobBody(command.targetJob);
  try {
    const summary = await deps.runJob(command.jobName, body, { trigger: "manual" });
    return { ...base, outcome: "executed", status: "succeeded", summary };
  } catch (err) {
    // runJob already ledgered status "failed" + errorSummary; surface, don't rethrow.
    return {
      ...base,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Real dependency factory (used by the route) ───────────────────────────────

/**
 * The production deps: the real runJob and a JobRun read for the in-flight
 * lock. `db` is injected by the route so this module stays free of a direct
 * client import at module scope (mirrors the run.ts narrow-client idiom).
 */
export function realOperationDeps(jobRunReader: {
  jobRun: {
    findFirst(args: {
      where: { jobName: string; status: "running" };
      orderBy: { startedAt: "desc" };
      select: { startedAt: true };
    }): Promise<RunningJobRow | null>;
  };
}): OperationDeps {
  return {
    runJob: realRunJob,
    findRunningJobRun: (jobName) =>
      jobRunReader.jobRun.findFirst({
        where: { jobName, status: "running" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      }),
    now: () => new Date(),
  };
}
