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
 * SUMMARY DOCTRINE (schema comment is authoritative): the fn's resolved value
 * is stored as `summary` only if it JSON-serializes cleanly; callers must
 * return counts/kinds/dates/IDs only — never user content or monetary values.
 *
 * DELIBERATELY NOT HERE (rulings R3–R8): CRON_SECRET auth (stays in the
 * routes — R3), dispatcher/registry (S2), retries/backoff, dead-job
 * detection, alerting, metrics/telemetry (PO1), retention sweeps (S3).
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

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
}

export interface JobRunCompletionData {
  status: "succeeded" | "failed";
  completedAt: Date;
  durationMs: number;
  summary?: unknown;
  errorSummary?: string;
}

export interface JobRunWriteClient {
  jobRun: {
    create(args: { data: JobRunStartData; select: { id: true } }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: JobRunCompletionData }): Promise<unknown>;
  };
}

const jobRunDb = db as unknown as JobRunWriteClient;

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

  // Start row — best-effort; a ledger failure must never break the job.
  let runId: string | null = null;
  try {
    const row = await client.jobRun.create({
      data: { jobName, trigger, executionId, status: "running", startedAt },
      select: { id: true },
    });
    runId = row.id;
  } catch (err) {
    console.error(`[job-run] ${jobName} (${executionId}): start write failed (non-fatal):`, err);
  }

  // The single completion write — skipped if the start write never landed.
  async function complete(data: JobRunCompletionData): Promise<void> {
    if (runId === null) return;
    try {
      await client.jobRun.update({ where: { id: runId }, data });
    } catch (err) {
      console.error(`[job-run] ${jobName} (${executionId}): completion write failed (non-fatal):`, err);
    }
  }

  try {
    const result = await fn();
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
    throw err;
  }
}
