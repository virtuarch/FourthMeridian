/**
 * lib/jobs/run.ts  (OPS-4 S1)
 *
 * THE single background-job execution wrapper. Every scheduled unit of work —
 * today the three Vercel-cron bodies, later anything the S2 dispatcher
 * registers — runs through runJob(); nothing else in the codebase writes a
 * JobRun row (grep-enforced: `.jobRun.` appears only in this file — the
 * lib/notifications/create.ts single-chokepoint idiom).
 *
 * WHAT IT DOES (frozen scope — docs/initiatives/ops4/OPS4_S0_RULINGS.md):
 *   1. Create a JobRun row at start (status "running") with a generated
 *      executionId, echoed in console logs for correlation.
 *   2. Time the wrapped fn.
 *   3. Write exactly ONE completion write: "succeeded" (+ durationMs +
 *      summary) or "failed" (+ durationMs + truncated errorSummary).
 *   4. Return the fn's result / rethrow its error UNCHANGED — the wrapper is
 *      observational; runtime behavior of every job is byte-identical.
 *
 * LEDGER WRITES ARE BEST-EFFORT, NON-THROWING (the EmailResult /
 * CreateNotificationResult house contract): a JobRun write failure is
 * console-logged and swallowed — the ledger must never break the job it
 * observes. If the start write failed, the completion write is skipped
 * (nothing to complete; append-only means we never guess a row into place).
 *
 * ...AND NOW ALSO REPORTED (SCHEDULER-DISPATCH-RESTORE-1, 2026-07-26).
 * RELAXES A DOCUMENTED FENCE, deliberately. R8 below froze "metrics/telemetry"
 * out of this wrapper, and that fence still holds: nothing here counts, times,
 * samples or emits a metric. What it now does is escalate the ONE thing it was
 * already swallowing — a failed ledger write — from console.error to
 * captureLedgerWriteFailure (lib/monitoring/capture.ts, the PS-4A chokepoint).
 *
 * The fence was written to keep an observability system out of the execution
 * wrapper. It was not written to make the wrapper's own blindness permanent, and
 * read that strictly it did real damage: on 2026-07-26 a deploy shipped
 * OPS-2B′ (deploymentSha) without its migration, every jobRun.create() failed
 * P2022 for ten hours, ten registered jobs ran normally and NOT ONE left a row.
 * Dispatch returned 200 throughout, so the only signal was every job silently
 * ageing into "overdue". An error report is not telemetry; it is the wrapper
 * admitting it failed at the one job it has.
 *
 * SUMMARY DOCTRINE (schema comment is authoritative): the fn's resolved value
 * is stored as `summary` only if it JSON-serializes cleanly; callers must
 * return counts/kinds/dates/IDs only — never user content or monetary values.
 *
 * ...AND THE JOB'S OWN FAILURE IS REPORTED TOO (OPERATIONALIZATION P0,
 * 2026-10-07). A body that threw became a `failed` ledger row and a rethrow —
 * correct, and invisible until the once-daily alert pass or an operator opened
 * the Jobs workspace. The same R8 reading applies: this is not telemetry, it is
 * the one error the wrapper already holds, handed to the error monitor
 * (captureJobFailure — static job name + execution id, never the summary or any
 * content). The rethrow is unchanged; a capture failure cannot fail the job.
 *
 * DELIBERATELY NOT HERE (rulings R3–R8): CRON_SECRET auth (stays in the
 * routes — R3), dispatcher/registry (S2), retries/backoff, dead-job
 * detection, alerting, metrics/telemetry (PO1), retention sweeps (S3).
 *
 * ── THE START WRITE IS NOW THE CLAIM (IDEMP-003 / OPS-005 / OPS-006, 2026-10-22)
 * The runtime audit fired two concurrent wakes and every due job ran twice:
 * the in-flight guard was a READ, and the per-job fallback routes never read
 * it at all. Migration 20261022000200 installs a partial unique index
 * JobRun_one_running_per_job ON (jobName) WHERE status = 'running', so the
 * start row that this wrapper already writes is the lock:
 *   · a second writer gets P2002 ⇒ JobAlreadyRunningError, body NEVER runs;
 *   · any OTHER start-write failure now ABORTS the run (JobLedgerUnavailableError)
 *     instead of running an unledgered, unguarded body — the opposite of the
 *     original "ledger never breaks the job" stance, deliberately: with the
 *     ledger as the lock, a body without a row is a body without a guard;
 *   · a `running` row older than the in-flight window is a crashed run and
 *     would block its job forever, so finalizeStaleRuns flips it to
 *     failed/"stale" — runJob does this for its own name before claiming, the
 *     wake does it for every job before selecting.
 * The completion write is unchanged (best-effort, single).
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "@/lib/db";
import { captureLedgerWriteFailure, captureJobFailure } from "@/lib/monitoring/capture";
import { currentDeploymentSha } from "@/lib/monitoring/deployment";
import { IN_FLIGHT_WINDOW_MS } from "@/lib/jobs/cadence-policy.core";

/** How a run was initiated. "cron" for the Vercel-cron routes. */
export type JobTrigger = "cron" | "manual" | "script";

/** Cap for errorSummary — message only, no stack, bounded. */
const ERROR_SUMMARY_MAX_CHARS = 500;

// ── Narrow write-client contract (injection seam for pure tests) ─────────────
//
// Typed against exactly the two operations the wrapper performs, and the
// shared client is cast once below — keeping this module compile-independent
// of Prisma client regeneration (the lib/notifications/create.ts idiom).

export interface JobRunStartData {
  jobName: string;
  trigger: string;
  executionId: string;
  status: "running";
  startedAt: Date;
  /**
   * OPS-2B′ — the deployment that produced this fact, or null when unobservable.
   * Present on the START data ONLY: `JobRunCompletionData` deliberately has no
   * such field, so the completion write CANNOT alter it — immutability is
   * enforced by the compiler, not by convention.
   */
  deploymentSha: string | null;
}

export interface JobRunCompletionData {
  status: "succeeded" | "failed";
  completedAt: Date;
  durationMs: number;
  summary?: unknown;
  errorSummary?: string;
}

/** The stale-run finaliser's single statement. `jobName` scopes it to one job. */
export interface JobRunStaleFinalizeArgs {
  where: { status: "running"; startedAt: { lt: Date }; jobName?: string };
  data: { status: "failed"; completedAt: Date; errorSummary: string };
}

export interface JobRunFinalizeClient {
  jobRun: {
    updateMany(args: JobRunStaleFinalizeArgs): Promise<{ count: number }>;
  };
}

export interface JobRunWriteClient extends JobRunFinalizeClient {
  jobRun: JobRunFinalizeClient["jobRun"] & {
    create(args: { data: JobRunStartData; select: { id: true } }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: JobRunCompletionData }): Promise<unknown>;
  };
}

const jobRunDb = db as unknown as JobRunWriteClient;

/** A `running` row older than this is a crashed run, not a lock (= the wake's in-flight window). */
export const STALE_RUNNING_AFTER_MS = IN_FLIGHT_WINDOW_MS;
/** The errorSummary the finaliser writes — a vocabulary word the health reader can match. */
export const STALE_RUN_ERROR_SUMMARY = "stale";

/** Thrown when another worker holds this job's `running` row. The body did not run. */
export class JobAlreadyRunningError extends Error {
  constructor(public readonly jobName: string) {
    super(`job "${jobName}" is already running (another worker holds the start row)`);
    this.name = "JobAlreadyRunningError";
  }
}

/** Thrown when the start row could not be written for any other reason. The body did not run. */
export class JobLedgerUnavailableError extends Error {
  constructor(public readonly jobName: string, cause: unknown) {
    super(`job "${jobName}" refused: the start-ledger write failed (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = "JobLedgerUnavailableError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Flip crashed `running` rows (older than STALE_RUNNING_AFTER_MS) to
 * failed/"stale" so the unique claim is free again. Scoped to one job when
 * `jobName` is given. Best-effort: a failure is logged and reported, never
 * thrown — the claim itself will still refuse if a row genuinely blocks.
 */
export async function finalizeStaleRuns(
  client: JobRunFinalizeClient,
  now: Date,
  jobName?: string,
): Promise<number> {
  try {
    const res = await client.jobRun.updateMany({
      where: { status: "running", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_AFTER_MS) }, ...(jobName ? { jobName } : {}) },
      data: { status: "failed", completedAt: now, errorSummary: STALE_RUN_ERROR_SUMMARY },
    });
    if (res.count > 0) console.warn(`[job-run] finalised ${res.count} stale running row(s)${jobName ? ` for ${jobName}` : ""} as failed/stale`);
    return res.count;
  } catch (err) {
    console.error(`[job-run] stale-run finaliser failed (non-fatal):`, err);
    captureLedgerWriteFailure("JobRun", "completion", err, jobName ?? "*");
    return 0;
  }
}

// ── Ambient run identity (PLATFORM OPS OBSERVABILITY) ────────────────────────
//
// The batch a piece of work is running under, readable by anything executed
// inside the wrapped body without threading an argument through every layer.
// It exists for ONE purpose: letting a per-item refresh execution stamp
// `RefreshExecution.parentJobRunId`, which had a column and an index but no
// producer — every cron bank refresh and every scheduled wallet refresh ran
// uncorrelated to the JobRun that fired it. AsyncLocalStorage is the same
// mechanism the Plaid provider-call attribution already uses.
//
// `id` was null when the start write failed; since IDEMP-003 a failed start
// write aborts the run, so inside a body it is always set. The type keeps the
// null arm for consumers written against the old contract.

export interface CurrentJobRun {
  /** JobRun.id, or null when the start write never landed. */
  id: string | null;
  jobName: string;
  trigger: JobTrigger;
  executionId: string;
  /**
   * When the enclosing FUNCTION invocation began (ms) — for a dispatch wake,
   * the wake (sync-banks and close-archive may have run first); otherwise the
   * job's own start. Work that must finish inside the function's maxDuration
   * (the inline ETH history step) sizes its deadline from this, not from "now".
   */
  budgetStartedAtMs: number;
}

const jobRunContext = new AsyncLocalStorage<CurrentJobRun>();

/** When the function this code runs in began, if it runs under a job (null: a request — its caller's own start applies). */
export function currentBudgetStartedAtMs(): number | null {
  return jobRunContext.getStore()?.budgetStartedAtMs ?? null;
}

/** The JobRun this code is executing under, or null outside any runJob body. */
export function currentJobRun(): CurrentJobRun | null {
  return jobRunContext.getStore() ?? null;
}

// ── Helpers (pure) ────────────────────────────────────────────────────────────

/** Truncated message-only error summary — never a stack trace. */
export function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > ERROR_SUMMARY_MAX_CHARS
    ? `${message.slice(0, ERROR_SUMMARY_MAX_CHARS - 1)}…`
    : message;
}

/**
 * Best-effort JSON-safe projection of a job result for the summary column.
 * Returns undefined (column stays NULL) for void results, unserializable
 * values (circular, BigInt), or anything that isn't a plain JSON value.
 */
export function toJsonSummary(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

// ── The wrapper ───────────────────────────────────────────────────────────────

export interface RunJobOptions {
  trigger?: JobTrigger;
  /** Test injection seam — production callers never pass this. */
  client?: JobRunWriteClient;
  /** When the enclosing function invocation began (the dispatch wake passes its instant). Default: this job's start. */
  budgetStartedAt?: Date;
}

/**
 * Run a named background job, recording its execution in the JobRun ledger.
 * Returns the fn's resolved value; rethrows the fn's error unchanged.
 */
export async function runJob<T>(
  jobName: string,
  fn: () => Promise<T>,
  options?: RunJobOptions,
): Promise<T> {
  const client = options?.client ?? jobRunDb;
  const trigger: JobTrigger = options?.trigger ?? "cron";
  const executionId = randomUUID();
  const startedAt = new Date();
  const t0 = Date.now();

  // A crashed predecessor must not hold the claim forever.
  await finalizeStaleRuns(client, startedAt, jobName);

  // Start row — THE CLAIM. P2002 means another worker holds it; anything else
  // means the ledger is unavailable. Either way the body does not run.
  let runId: string;
  try {
    const row = await client.jobRun.create({
      // deploymentSha is stamped once, here, from the one canonical resolver.
      // The completion write never touches it.
      data: { jobName, trigger, executionId, status: "running", startedAt, deploymentSha: currentDeploymentSha() },
      select: { id: true },
    });
    runId = row.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log(`[job-run] ${jobName} (${executionId}): refused — already running elsewhere`);
      throw new JobAlreadyRunningError(jobName);
    }
    console.error(`[job-run] ${jobName} (${executionId}): start write failed — run aborted:`, err);
    captureLedgerWriteFailure("JobRun", "start", err, jobName);
    throw new JobLedgerUnavailableError(jobName, err);
  }

  // The single completion write.
  async function complete(data: JobRunCompletionData): Promise<void> {
    try {
      await client.jobRun.update({ where: { id: runId }, data });
    } catch (err) {
      console.error(`[job-run] ${jobName} (${executionId}): completion write failed (non-fatal):`, err);
      // Leaves a permanently "running" row — the crash shape lib/jobs/health.ts
      // counts as a failure after STALE_RUNNING_HOURS. Worth an event: the job
      // itself succeeded, so nothing else will ever report this.
      captureLedgerWriteFailure("JobRun", "completion", err, jobName);
    }
  }

  try {
    const budgetStartedAtMs = Math.min(options?.budgetStartedAt?.getTime() ?? startedAt.getTime(), startedAt.getTime());
    const result = await jobRunContext.run({ id: runId, jobName, trigger, executionId, budgetStartedAtMs }, fn);
    await complete({
      status: "succeeded",
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      summary: toJsonSummary(result),
    });
    return result;
  } catch (err) {
    await complete({
      status: "failed",
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      errorSummary: summarizeError(err),
    });
    // The ledger has the fact; the error monitor gets the error. Static
    // identifiers only — the job name and this run's execution id.
    captureJobFailure(jobName, err, executionId);
    throw err;
  }
}
