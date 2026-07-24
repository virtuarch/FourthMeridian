/**
 * lib/plaid/refresh-execution.ts  (DF-2A — Canonical Refresh Execution Authority)
 *
 * THE single write path for the per-item RefreshExecution / RefreshEndpointResult
 * ledger — the runJob() chokepoint idiom (lib/jobs/run.ts) applied at the
 * per-item-refresh grain that JobRun (batch-grained) does not cover.
 *
 *   runFullRefresh({ itemId, trigger, profile })
 *     1. mint ONE runId (the first-class correlator; also threaded into the
 *        transaction sync so its SyncIssue.detail.runId matches this execution).
 *     2. open a RefreshExecution row (overallStatus "RUNNING").
 *     3. run the real refresh stages (refreshPlaidItem) with an observational
 *        recorder — refreshPlaidItem's behavior is byte-identical (the recorder
 *        only observes; when absent, nothing changes).
 *     4. persist one immutable RefreshEndpointResult per attempted stage.
 *     5. DERIVE overallStatus from the child results (no standalone success bool).
 *     6. write the single completion row.
 *
 * IMMUTABILITY: exactly one create + one completion update per execution; child
 * results are created once. Historical facts are never rewritten.
 *
 * TELEMETRY NEVER BREAKS REFRESH (the runJob / notifications house contract):
 * every ledger write is best-effort and swallowed on failure. The provider
 * refresh result (or its thrown error) passes through UNCHANGED — a telemetry
 * failure must never turn a successful refresh into a customer-visible failure.
 * The ONE authoritative business write in this path is the provider refresh
 * itself (inside refreshPlaidItem); the RefreshExecution/EndpointResult writes
 * are OPERATIONAL ledger writes.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { summarizeError } from "@/lib/jobs/run";
import { currentDeploymentSha } from "@/lib/monitoring/deployment";
import { refreshPlaidItem, type RefreshItemResult } from "@/lib/plaid/refresh";
// DF-2D — the provider-call correlation context. runFullRefresh establishes it
// around the runner so every Plaid call inside attributes to this execution.
import { runWithProviderCallContext, type ProviderCallContext } from "@/lib/plaid/provider-call-context";
import type {
  RefreshTrigger,
  RefreshProfile,
  RefreshOverallStatus,
  RefreshEndpoint,
  RefreshStageKind,
  RefreshSkipReason,
  RefreshStageFacts,
  RefreshStageRecord,
  RefreshStageRecorder,
} from "@/lib/plaid/refresh-execution-types";

// ── Narrow write-client seam (the JobRunWriteClient idiom) ───────────────────
//
// Typed against exactly the three operations this module performs, and the
// shared client is cast once below — keeping this module compile-independent of
// Prisma-client regeneration and giving pure tests an injection point.

export interface RefreshExecutionStartData {
  runId: string;
  plaidItemId: string;
  trigger: string;
  profile: string;
  parentJobRunId: string | null;
  startedAt: Date;
  overallStatus: "RUNNING";
  /**
   * OPS-2B′ — the deployment that produced this fact, or null when unobservable.
   * Present on the START data ONLY: `RefreshExecutionCompletionData` deliberately
   * has no such field, so the completion write CANNOT alter it — immutability is
   * enforced by the compiler, not by convention.
   */
  deploymentSha: string | null;
}

export interface RefreshExecutionCompletionData {
  completedAt: Date;
  durationMs: number;
  overallStatus: RefreshOverallStatus;
  errorSummary?: string;
}

export interface RefreshEndpointResultData {
  refreshExecutionId: string;
  endpoint: string;
  stageKind: string;
  status: string;
  skipReason?: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  recordsRead?: number;
  recordsWritten?: number;
  recordsChanged?: number;
  coveredAccountIds: string[];
  freshnessAdvanced?: boolean;
  errorSummary?: string;
}

export interface RefreshEndpointAccountCoverageData {
  refreshExecutionId: string;
  endpoint: string;
  financialAccountId: string;
  status: string;
  reason?: string;
  freshnessAdvanced: boolean;
}

export interface RefreshExecutionWriteClient {
  refreshExecution: {
    create(args: { data: RefreshExecutionStartData; select: { id: true } }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: RefreshExecutionCompletionData }): Promise<unknown>;
  };
  refreshEndpointResult: {
    createMany(args: { data: RefreshEndpointResultData[] }): Promise<unknown>;
  };
  refreshEndpointAccountCoverage: {
    createMany(args: { data: RefreshEndpointAccountCoverageData[] }): Promise<unknown>;
  };
}

const executionDb = db as unknown as RefreshExecutionWriteClient;

// ── The recorder — collects finalized stage records; observes, never controls ─

export class StageRecorder implements RefreshStageRecorder {
  readonly records: RefreshStageRecord[] = [];
  private open?: { endpoint: RefreshEndpoint; stageKind: RefreshStageKind; startedAt: Date; t0: number };

  /**
   * @param onStage DF-2D — invoked with the stage that just became active
   * (begin) or `undefined` (a stage just closed), so runFullRefresh can keep the
   * provider-call context's currentEndpoint in sync for attribution.
   */
  constructor(private readonly onStage?: (endpoint: RefreshEndpoint | undefined) => void) {}

  begin(endpoint: RefreshEndpoint, stageKind: RefreshStageKind): void {
    this.open = { endpoint, stageKind, startedAt: new Date(), t0: Date.now() };
    this.onStage?.(endpoint);
  }

  succeed(endpoint: RefreshEndpoint, facts?: RefreshStageFacts): void {
    const open = this.takeOpen(endpoint);
    const startedAt = open?.startedAt ?? new Date();
    const t0 = open?.t0 ?? Date.now();
    const stageKind = open?.stageKind ?? "PROVIDER";
    const recordsChanged = facts?.recordsChanged;
    this.records.push({
      endpoint,
      stageKind,
      status: "SUCCEEDED",
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      recordsRead: facts?.recordsRead,
      recordsWritten: facts?.recordsWritten,
      recordsChanged,
      coveredAccountIds: facts?.coveredAccountIds ?? [],
      freshnessAdvanced: recordsChanged === undefined ? undefined : recordsChanged > 0,
      accounts: facts?.accounts ?? [],
    });
  }

  fail(endpoint: RefreshEndpoint, err: unknown): void {
    const open = this.takeOpen(endpoint);
    const startedAt = open?.startedAt ?? new Date();
    const t0 = open?.t0 ?? Date.now();
    const stageKind = open?.stageKind ?? "PROVIDER";
    this.records.push({
      endpoint,
      stageKind,
      status: "FAILED",
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      coveredAccountIds: [],
      errorSummary: summarizeError(err),
      accounts: [],
    });
  }

  skip(endpoint: RefreshEndpoint, stageKind: RefreshStageKind, reason: RefreshSkipReason): void {
    this.takeOpen(endpoint);
    const now = new Date();
    this.records.push({
      endpoint,
      stageKind,
      status: "SKIPPED",
      skipReason: reason,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      coveredAccountIds: [],
      accounts: [],
    });
  }

  /** Finalize any stage that began but never succeeded/skipped as FAILED (called from the orchestrator's catch). */
  failOpen(err: unknown): void {
    if (!this.open) return;
    const { endpoint, stageKind, startedAt, t0 } = this.open;
    this.open = undefined;
    this.onStage?.(undefined); // no stage active after a fail-open
    this.records.push({
      endpoint,
      stageKind,
      status: "FAILED",
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      coveredAccountIds: [],
      errorSummary: summarizeError(err),
      accounts: [],
    });
  }

  private takeOpen(endpoint: RefreshEndpoint) {
    const open = this.open?.endpoint === endpoint ? this.open : undefined;
    if (open) this.open = undefined;
    this.onStage?.(undefined); // no stage active after succeed/skip/fail
    return open;
  }
}

// ── Pure completion derivation (exported for direct unit testing) ────────────

/**
 * Derive execution overallStatus from child stage records.
 *
 *   nothing attempted (all SKIPPED / no stages)         → SKIPPED
 *   every attempted PROVIDER stage failed               → FAILED
 *   any stage failed (provider mix, or a derived stage) → PARTIAL
 *   otherwise                                           → SUCCEEDED
 *
 * A SKIPPED stage (e.g. HOLDINGS NOT_APPLICABLE) is not "attempted" and never
 * degrades an otherwise-successful refresh. DERIVED (projection) stages can push
 * a refresh to PARTIAL if they fail, but never to FAILED on their own.
 */
export function deriveOverallStatus(stages: RefreshStageRecord[]): RefreshOverallStatus {
  const attempted = stages.filter((s) => s.status === "SUCCEEDED" || s.status === "FAILED");
  if (attempted.length === 0) return "SKIPPED";

  const providerAttempted = attempted.filter((s) => s.stageKind === "PROVIDER");
  const providerSucceeded = providerAttempted.filter((s) => s.status === "SUCCEEDED");
  if (providerAttempted.length > 0 && providerSucceeded.length === 0) return "FAILED";

  if (stages.some((s) => s.status === "FAILED")) return "PARTIAL";
  return "SUCCEEDED";
}

// ── The orchestrator ──────────────────────────────────────────────────────────

export interface RunFullRefreshParams {
  itemId: string;
  trigger: RefreshTrigger;
  profile: RefreshProfile;
  /** Soft link to a JobRun.id when this refresh runs under a batch (cron); DF-2B. */
  parentJobRunId?: string;
}

/**
 * Runs the actual refresh stages, driving the recorder, and returns whatever
 * result its caller wants. The manual path returns a RefreshItemResult
 * (refreshPlaidItem); the cron path (DF-2B) returns its own outcome shape — the
 * execution AUTHORITY is shared, the stage SEQUENCE is per-path (manual runs
 * holdings/reconciliation; cron runs investment events / wealth self-heal).
 */
export type RefreshStageRunner<T> = (opts: { recorder: RefreshStageRecorder; runId: string }) => Promise<T>;

export interface RunFullRefreshDeps<T> {
  /** Test injection seam — production callers never pass this. */
  client?: RefreshExecutionWriteClient;
  /**
   * Runs the actual refresh stages, driving the recorder. Defaults to
   * refreshPlaidItem (T = RefreshItemResult). Cron/tests inject a runner that
   * records the stage outcomes for their own pipeline.
   */
  refresh?: RefreshStageRunner<T>;
}

/**
 * Wrap one per-item refresh in the canonical execution authority. Returns the
 * runner's result unchanged on success; records the failure and rethrows the
 * ORIGINAL error on failure. The ledger never alters refresh behavior. The
 * default runner is refreshPlaidItem (manual path); DF-2B injects a cron runner.
 */
export async function runFullRefresh<T = RefreshItemResult>(
  params: RunFullRefreshParams,
  deps: RunFullRefreshDeps<T> = {},
): Promise<T> {
  const client = deps.client ?? executionDb;
  const runId = randomUUID();
  const startedAt = new Date();
  const t0 = Date.now();

  const executionId = await openExecution(client, {
    runId,
    plaidItemId: params.itemId,
    trigger: params.trigger,
    profile: params.profile,
    parentJobRunId: params.parentJobRunId ?? null,
    startedAt,
    overallStatus: "RUNNING",
    // Stamped once, here, from the one canonical resolver. Never recomputed at
    // close, never backfilled: this row keeps the deployment that produced it.
    deploymentSha: currentDeploymentSha(),
  });

  // DF-2D — attribute provider calls to this execution only when the ledger row
  // exists (executionId non-null); the recorder keeps the context's active stage
  // in sync so each ProviderCall names the stage that fired it.
  const ctx: ProviderCallContext | null =
    executionId === null ? null : { refreshExecutionId: executionId, currentEndpoint: undefined, attempts: new Map() };
  const recorder = new StageRecorder(ctx ? (ep) => { ctx.currentEndpoint = ep; } : undefined);

  // The default runner (refreshPlaidItem) returns RefreshItemResult; the cast is
  // sound because `deps.refresh` is undefined only when T defaulted to it.
  const runStages: RefreshStageRunner<T> =
    deps.refresh ??
    (((o) => refreshPlaidItem(params.itemId, { recorder: o.recorder, runId: o.runId })) as RefreshStageRunner<T>);

  const execute = async (): Promise<T> => {
    try {
      const result = await runStages({ recorder, runId });
      await closeExecution(client, executionId, recorder.records, startedAt, t0, undefined);
      return result;
    } catch (err) {
      recorder.failOpen(err);
      await closeExecution(client, executionId, recorder.records, startedAt, t0, err);
      throw err;
    }
  };

  return ctx ? runWithProviderCallContext(ctx, execute) : execute();
}

// ── Best-effort ledger writes (swallowed on failure — never break the refresh) ─

async function openExecution(
  client: RefreshExecutionWriteClient,
  data: RefreshExecutionStartData,
): Promise<string | null> {
  try {
    const row = await client.refreshExecution.create({ data, select: { id: true } });
    return row.id;
  } catch (err) {
    console.error(`[refresh-execution] ${data.runId}: start write failed (non-fatal):`, err);
    return null;
  }
}

async function closeExecution(
  client: RefreshExecutionWriteClient,
  executionId: string | null,
  records: RefreshStageRecord[],
  startedAt: Date,
  t0: number,
  err: unknown,
): Promise<void> {
  if (executionId === null) return; // start write never landed — nothing to complete (append-only)

  // Persist one immutable endpoint result per attempted/skipped stage.
  if (records.length > 0) {
    try {
      await client.refreshEndpointResult.createMany({
        data: records.map((r) => ({
          refreshExecutionId: executionId,
          endpoint: r.endpoint,
          stageKind: r.stageKind,
          status: r.status,
          skipReason: r.skipReason,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          durationMs: r.durationMs,
          recordsRead: r.recordsRead,
          recordsWritten: r.recordsWritten,
          recordsChanged: r.recordsChanged,
          coveredAccountIds: r.coveredAccountIds,
          freshnessAdvanced: r.freshnessAdvanced,
          errorSummary: r.errorSummary,
        })),
      });
    } catch (writeErr) {
      console.error(`[refresh-execution] ${executionId}: endpoint-result write failed (non-fatal):`, writeErr);
    }
  }

  // DF-2E — one immutable RefreshEndpointAccountCoverage row per (endpoint,
  // account) the execution evaluated. Flattened from the stage records that
  // reported per-account outcomes (BALANCES, HOLDINGS). Best-effort; a coverage
  // write failure never breaks the refresh.
  const coverageRows: RefreshEndpointAccountCoverageData[] = records.flatMap((r) =>
    r.accounts.map((a) => ({
      refreshExecutionId: executionId,
      endpoint: r.endpoint,
      financialAccountId: a.financialAccountId,
      status: a.status,
      reason: a.reason,
      freshnessAdvanced: a.freshnessAdvanced,
    })),
  );
  if (coverageRows.length > 0) {
    try {
      await client.refreshEndpointAccountCoverage.createMany({ data: coverageRows });
    } catch (writeErr) {
      console.error(`[refresh-execution] ${executionId}: account-coverage write failed (non-fatal):`, writeErr);
    }
  }

  const overallStatus = deriveOverallStatus(records);
  // Prefer the top-level thrown error's message; else the first failed stage's.
  const errorSummary =
    err !== undefined
      ? summarizeError(err)
      : records.find((r) => r.status === "FAILED")?.errorSummary;

  try {
    await client.refreshExecution.update({
      where: { id: executionId },
      data: {
        completedAt: new Date(),
        durationMs: Date.now() - t0,
        overallStatus,
        errorSummary,
      },
    });
  } catch (writeErr) {
    console.error(`[refresh-execution] ${executionId}: completion write failed (non-fatal):`, writeErr);
  }
}
