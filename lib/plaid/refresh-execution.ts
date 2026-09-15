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
import { summarizeError, currentJobRun } from "@/lib/jobs/run";
import { captureLedgerWriteFailure } from "@/lib/monitoring/capture";
import { currentDeploymentSha } from "@/lib/monitoring/deployment";
// PLATFORM OPS OBSERVABILITY — the Plaid runner is imported LAZILY (inside the
// default runner) rather than at module load. lib/plaid/refresh.ts pulls in the
// Plaid client, which validates credentials at import time; now that the wallet
// dispatcher records through this envelope, a static import here would make
// every wallet path — and every credential-free test of it — require Plaid.
import type { RefreshItemResult } from "@/lib/plaid/refresh";
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
  ExecutionSource,
  ExecutionVerdict,
} from "@/lib/plaid/refresh-execution-types";
import { buildVerdict } from "@/lib/plaid/refresh-verdict.core";

// ── Narrow write-client seam (the JobRunWriteClient idiom) ───────────────────
//
// Typed against exactly the three operations this module performs, and the
// shared client is cast once below — keeping this module compile-independent of
// Prisma-client regeneration and giving pure tests an injection point.

export interface RefreshExecutionStartData {
  runId: string;
  /** The Plaid item, or null for a non-Plaid source (see sourceKind/sourceRef). */
  plaidItemId: string | null;
  /** PLATFORM OPS OBSERVABILITY — generic source identity; see prisma/schema.prisma. */
  sourceKind: string;
  sourceRef: string | null;
  network: string | null;
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
  /** PLATFORM OPS OBSERVABILITY — the derived verdict (refresh-verdict.core.ts). */
  failureStage?: string;
  failureCategory?: string;
  outcome?: string;
  /**
   * OPS-2D-3 — the typed admission reason, set ONLY when the execution was
   * denied before any stage ran. Optional here rather than on the start data
   * because admission is evaluated after the row opens, and because an admitted
   * execution must leave it null.
   */
  admissionReason?: string;
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
  /** V26-STAGE-1 — set when an execution row exists; lets the historical layer
   *  persist its own stages incrementally against this run. */
  refreshExecutionId?: string;
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
  /** The Plaid item being refreshed. Required for the default runner; may be
   *  omitted when `source` names a non-Plaid source. */
  itemId?: string;
  /**
   * PLATFORM OPS OBSERVABILITY — what is being refreshed, generically. When
   * omitted the execution is a Plaid item (`itemId`), exactly as before.
   */
  source?: ExecutionSource;
  trigger: RefreshTrigger;
  profile: RefreshProfile;
  /**
   * Soft link to a JobRun.id when this refresh runs under a batch (cron); DF-2B.
   * When omitted, the ambient JobRun (lib/jobs/run.ts `currentJobRun`) is used,
   * so a refresh fired from inside a job body is correlated without every
   * caller threading the id. Explicit always wins.
   */
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
  /**
   * PLATFORM OPS OBSERVABILITY — a producer's contribution to the verdict, for
   * the fields it genuinely knows better than the generic derivation (a wallet
   * adapter's own failure stage name; a typed error code). Called once at
   * completion with the runner's result or the thrown error and the finalized
   * stage records. Fields left undefined keep the derived value. Never throws
   * into the refresh: an exception here is swallowed like any ledger failure.
   */
  verdict?: (ctx: { result?: T; error?: unknown; stages: readonly RefreshStageRecord[] }) => ExecutionVerdict | undefined;
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

  // The default runner refreshes a Plaid item; it needs to know which one
  // BEFORE any ledger row is opened, so a caller mistake leaves no orphan row.
  const itemId = plaidItemIdOf(params);
  if (!deps.refresh && !itemId) {
    throw new TypeError("runFullRefresh: the default (Plaid) runner requires itemId or a PLAID_ITEM source");
  }

  const executionId = await openExecution(client, startData(params, runId, startedAt));

  // DF-2D — attribute provider calls to this execution only when the ledger row
  // exists (executionId non-null); the recorder keeps the context's active stage
  // in sync so each ProviderCall names the stage that fired it.
  const ctx: ProviderCallContext | null =
    executionId === null ? null : { refreshExecutionId: executionId, currentEndpoint: undefined, attempts: new Map() };
  const recorder = new StageRecorder(ctx ? (ep) => { ctx.currentEndpoint = ep; } : undefined);
  if (executionId !== null) recorder.refreshExecutionId = executionId;

  // The default runner (refreshPlaidItem) returns RefreshItemResult; the cast is
  // sound because `deps.refresh` is undefined only when T defaulted to it.
  const runStages: RefreshStageRunner<T> =
    deps.refresh ??
    ((async (o) => {
      const { refreshPlaidItem } = await import("@/lib/plaid/refresh");
      return refreshPlaidItem(itemId as string, { recorder: o.recorder, runId: o.runId });
    }) as RefreshStageRunner<T>);

  // The producer's verdict override, guarded: a defect in a verdict callback
  // must never become a refresh failure.
  const overrideFor = (ctx: { result?: T; error?: unknown }): ExecutionVerdict | undefined => {
    if (!deps.verdict) return undefined;
    try { return deps.verdict({ ...ctx, stages: recorder.records }); }
    catch (verdictErr) {
      console.error(`[refresh-execution] ${runId}: verdict callback threw (ignored):`, verdictErr);
      return undefined;
    }
  };

  const execute = async (): Promise<T> => {
    try {
      const result = await runStages({ recorder, runId });
      await closeExecution(client, executionId, recorder.records, startedAt, t0, undefined, overrideFor({ result }));
      return result;
    } catch (err) {
      recorder.failOpen(err);
      await closeExecution(client, executionId, recorder.records, startedAt, t0, err, overrideFor({ error: err }));
      throw err;
    }
  };

  return ctx ? runWithProviderCallContext(ctx, execute) : execute();
}

// ── Best-effort ledger writes (swallowed on failure — never break the refresh) ─

/**
 * The START row for one execution. THE single place deployment identity is
 * stamped — OPS-2B′ requires it resolved once, at the start write, from the one
 * canonical resolver, and never recomputed at close. Every function that opens
 * an execution (runFullRefresh, recordAdmissionDenial) goes through here, so
 * that requirement is satisfied by construction rather than by repetition.
 */
function plaidItemIdOf(params: RunFullRefreshParams): string | null {
  if (params.itemId) return params.itemId;
  if (params.source?.kind === "PLAID_ITEM") return params.source.ref;
  return null;
}

function startData(
  params: RunFullRefreshParams,
  runId: string,
  startedAt: Date,
): RefreshExecutionStartData {
  const source: ExecutionSource = params.source ?? { kind: "PLAID_ITEM", ref: params.itemId ?? "" };
  return {
    runId,
    plaidItemId: plaidItemIdOf(params),
    sourceKind: source.kind,
    // A Plaid item's identity lives in plaidItemId; sourceRef names the other kinds.
    sourceRef: source.kind === "PLAID_ITEM" ? null : source.ref,
    network: source.kind === "WALLET" ? source.network : null,
    trigger: params.trigger,
    profile: params.profile,
    parentJobRunId: params.parentJobRunId ?? currentJobRun()?.id ?? null,
    startedAt,
    overallStatus: "RUNNING",
    deploymentSha: currentDeploymentSha(),
  };
}

async function openExecution(
  client: RefreshExecutionWriteClient,
  data: RefreshExecutionStartData,
): Promise<string | null> {
  try {
    const row = await client.refreshExecution.create({ data, select: { id: true } });
    return row.id;
  } catch (err) {
    console.error(`[refresh-execution] ${data.runId}: start write failed (non-fatal):`, err);
    // Same escalation as the JobRun wrapper (SCHEDULER-DISPATCH-RESTORE-1): a
    // null here suppresses every downstream write for this execution — endpoint
    // results, coverage, provider calls — so the refresh runs and the entire
    // DF-2 ledger records nothing. This ledger had been write-dead in production
    // since 2026-07-24 (the RefreshExecution table itself was never migrated)
    // and nothing reported it.
    captureLedgerWriteFailure("RefreshExecution", "start", err);
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
  override?: ExecutionVerdict,
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

  // PLATFORM OPS OBSERVABILITY — the verdict, derived once from the evidence
  // above and the producer's override. A verdict is a fact about THIS run and
  // is written with the same single completion write, never later.
  const verdict = buildVerdict({
    stages: records,
    failed: overallStatus === "FAILED" || overallStatus === "PARTIAL",
    error: err !== undefined ? { message: summarizeError(err), code: errorCodeOf(err) } : undefined,
    override,
  });

  try {
    await client.refreshExecution.update({
      where: { id: executionId },
      data: {
        completedAt: new Date(),
        durationMs: Date.now() - t0,
        overallStatus,
        errorSummary,
        ...(verdict.failureStage ? { failureStage: verdict.failureStage } : {}),
        ...(verdict.failureCategory ? { failureCategory: verdict.failureCategory } : {}),
        ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
      },
    });
  } catch (writeErr) {
    console.error(`[refresh-execution] ${executionId}: completion write failed (non-fatal):`, writeErr);
  }
}

/** A typed provider code carried on a thrown error, when one exists (Plaid errors carry `error_code`). */
function errorCodeOf(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { error_code?: unknown; code?: unknown; response?: { data?: { error_code?: unknown } } };
  const candidate = e.error_code ?? e.response?.data?.error_code ?? e.code;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

// ── OPS-2D-3 — admission evidence ────────────────────────────────────────────

/**
 * Record that a refresh was NOT ADMITTED, as a first-class execution.
 *
 * A denied refresh opens and closes a real RefreshExecution with zero stages.
 * `deriveOverallStatus([])` already returns SKIPPED for "nothing attempted", so
 * the status is derived by the existing rule rather than asserted here — the
 * ledger gains no special case, only a reason.
 *
 * WHY A ROW AT ALL. The alternative — return early, write nothing — would make
 * an operator's own declared pause invisible on the very surfaces built to
 * observe operations, and would leave "nothing was requested" and "we chose not
 * to run" indistinguishable. Row volume is bounded by the request rate, which
 * during a pause is the cron cadence.
 *
 * Deliberately NOT part of runFullRefresh: that function must return the
 * runner's result type, and a denial has no result. Producers therefore ask
 * admission BEFORE entering the envelope and record the denial with this. See
 * the unmigrated-producer census in admission-boundary.test.ts.
 *
 * Non-fatal throughout, exactly like the rest of this ledger: failing to record
 * a denial must never turn into a second failure for the caller to handle.
 */
export async function recordAdmissionDenial(
  params: RunFullRefreshParams & { admissionReason: string },
  deps: { client?: RefreshExecutionWriteClient } = {},
): Promise<{ runId: string }> {
  const client = deps.client ?? executionDb;
  const runId = randomUUID();
  const startedAt = new Date();
  const t0 = Date.now();

  const executionId = await openExecution(client, startData(params, runId, startedAt));

  if (executionId !== null) {
    try {
      await client.refreshExecution.update({
        where: { id: executionId },
        data: {
          completedAt: new Date(),
          durationMs: Date.now() - t0,
          // No stages ran — the existing derivation rule, applied to nothing.
          overallStatus: deriveOverallStatus([]),
          admissionReason: params.admissionReason,
        },
      });
    } catch (writeErr) {
      console.error(`[refresh-execution] ${runId}: admission-denial write failed (non-fatal):`, writeErr);
    }
  }

  return { runId };
}
