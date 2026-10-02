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
 *
 * ── RLS-P-1: THIS MODULE DERIVES; IT NO LONGER WRITES ────────────────────────
 * The four ledger INSERTs/UPDATEs that used to live here now go through the one
 * door (lib/plaid/refresh-ledger.ts), and the swallowing lives there too. What
 * stays here is everything that is a DECISION rather than a statement: minting
 * the runId, stamping the deployment, flattening per-account coverage out of the
 * stage records, deriving `overallStatus`, and building the verdict.
 *
 * THE ONE PLACE AN AUTHORITY IS CHOSEN for the whole (B) family is the single
 * `ledgerRecorderFor(...)` call below. Flipping the operational ledger to another
 * principal is that line; before this slice it was nine lines in four files.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { summarizeError, currentJobRun } from "@/lib/jobs/run";
import { currentDeploymentSha } from "@/lib/monitoring/deployment";
import {
  describeLedgerDegradations,
  ledgerRecorderFor,
  type LedgerDegradation,
  type LedgerHandle,
  type LedgerRecorder,
  type LedgerWriteClient,
} from "@/lib/plaid/refresh-ledger";
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
import { redactedErrorForLog } from "@/lib/plaid/errors";

// ── The ledger row shapes ────────────────────────────────────────────────────
//
// Declared here, written at the door. They stay here because the deployment
// immutability invariant is pinned on these declarations: the START data carries
// `deploymentSha` and the COMPLETION data structurally cannot, so a completion
// write cannot rewrite it (lib/monitoring/deployment.test.ts).

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

/**
 * ⚠️ THE ONE PLACE A (B)-FAMILY WRITE AUTHORITY IS CHOSEN.
 *
 * Every operational-ledger write in the product tree — RefreshExecution,
 * RefreshEndpointResult, RefreshEndpointAccountCoverage, ProviderCall — passes
 * through the client this line names. It is still the migration principal, by
 * design: RLS-P-1 moved the authority question to one place without answering it
 * differently. The flip is this line.
 *
 * (SyncIssue / SyncIssueOccurrence reach the door too, but the door forwards
 * them to the incident FACADE, which keeps its own client parameter because
 * fourteen non-envelope producers thread one. See refresh-ledger.ts.)
 */
const LEDGER_CLIENT = db as unknown as LedgerWriteClient;

/**
 * ⚠️ RLS-P-2 — ONE RECORDER PER REFRESH, NOT ONE PER PROCESS.
 *
 * This used to be a module-level `const ledgerRecorder = ledgerRecorderFor(db)`,
 * and that made the recorder's `degradations` array PROCESS-GLOBAL. On a warm
 * serverless instance one item's stage-write failure was still in the list when
 * the next item's refresh read it, and a single failed `open()` made
 * `isTotalBlackout()` answer TRUE for every later refresh in that process —
 * including the ones whose start write landed. The array is documented as "what
 * THIS execution failed to record", and at module scope it could not be.
 *
 * A fresh recorder per refresh is cheap (a closure and an empty array) and makes
 * the documented property true by construction. The authority is still chosen in
 * exactly one place: the constant above.
 */
function productionLedgerRecorder(): LedgerRecorder {
  return ledgerRecorderFor(LEDGER_CLIENT);
}

// ── The recorder — collects finalized stage records; observes, never controls ─

export class StageRecorder implements RefreshStageRecorder {
  readonly records: RefreshStageRecord[] = [];
  /** V26-STAGE-1 / RLS-P-1 — the ledger door for this execution, when one opened.
   *  Lets the historical layer persist its own stages incrementally against this
   *  run WITHOUT being handed an execution id it could point elsewhere. */
  ledger?: LedgerHandle;
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

  recordMeasured(
    endpoint: RefreshEndpoint,
    stageKind: RefreshStageKind,
    measured:
      | { ok: true;  startedAt: Date; durationMs: number; facts?: RefreshStageFacts }
      | { ok: false; startedAt: Date; durationMs: number; err: unknown },
  ): void {
    const { startedAt, durationMs } = measured;
    const completedAt = new Date(startedAt.getTime() + durationMs);
    if (measured.ok) {
      const recordsChanged = measured.facts?.recordsChanged;
      this.records.push({
        endpoint, stageKind, status: "SUCCEEDED", startedAt, completedAt, durationMs,
        recordsRead: measured.facts?.recordsRead,
        recordsWritten: measured.facts?.recordsWritten,
        recordsChanged,
        coveredAccountIds: measured.facts?.coveredAccountIds ?? [],
        freshnessAdvanced: recordsChanged === undefined ? undefined : recordsChanged > 0,
        accounts: measured.facts?.accounts ?? [],
      });
    } else {
      this.records.push({
        endpoint, stageKind, status: "FAILED", startedAt, completedAt, durationMs,
        coveredAccountIds: [],
        errorSummary: summarizeError(measured.err),
        accounts: [],
      });
    }
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
  /**
   * Test injection seam — production callers never pass this.
   *
   * ⚠️ A RECORDER, NOT A CLIENT (RLS-P-1). This used to be a write client, and
   * that made it look like the split-authority seam it was not: it reached three
   * of the six ledger tables, because ProviderCall, SyncIssue and the incremental
   * RefreshEndpointResult each resolved their own `db` elsewhere. Setting it
   * would have left three writers on the old principal while the suite went
   * green. Typed as the capability, it can only ever be what it says it is.
   */
  client?: LedgerRecorder;
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
  const recorderClient = deps.client ?? productionLedgerRecorder();
  const runId = randomUUID();
  const startedAt = new Date();
  const t0 = Date.now();

  // The default runner refreshes a Plaid item; it needs to know which one
  // BEFORE any ledger row is opened, so a caller mistake leaves no orphan row.
  const itemId = plaidItemIdOf(params);
  if (!deps.refresh && !itemId) {
    throw new TypeError("runFullRefresh: the default (Plaid) runner requires itemId or a PLAID_ITEM source");
  }

  const ledger = await recorderClient.open(startData(params, runId, startedAt));

  // DF-2D — attribute provider calls to this execution only when the ledger row
  // exists (handle non-null); the recorder keeps the context's active stage in
  // sync so each ProviderCall names the stage that fired it. The context carries
  // the HANDLE, so the Plaid proxy cannot write a ProviderCall for any execution
  // but the one in flight.
  const ctx: ProviderCallContext | null =
    ledger === null ? null : { ledger, currentEndpoint: undefined, attempts: new Map() };
  const recorder = new StageRecorder(ctx ? (ep) => { ctx.currentEndpoint = ep; } : undefined);
  if (ledger !== null) recorder.ledger = ledger;

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
      console.error(`[refresh-execution] ${runId}: verdict callback threw (ignored):`, redactedErrorForLog(verdictErr));
      return undefined;
    }
  };

  const execute = async (): Promise<T> => {
    try {
      const result = await runStages({ recorder, runId });
      await closeExecution(ledger, recorder.records, startedAt, t0, undefined, overrideFor({ result }));
      reportLedgerCompleteness(runId, recorderClient.degradations);
      return result;
    } catch (err) {
      recorder.failOpen(err);
      await closeExecution(ledger, recorder.records, startedAt, t0, err, overrideFor({ error: err }));
      reportLedgerCompleteness(runId, recorderClient.degradations);
      // ⚠️ THE ORIGINAL ERROR OBJECT, NOT A WRAPPED ONE, AND NEVER A LEDGER
      // FAILURE. reportItemRefreshFailure classifies this by identity
      // (lib/plaid/refresh.ts), so a ledger degradation must not reach it.
      throw err;
    }
  };

  return ctx ? runWithProviderCallContext(ctx, execute) : execute();
}

/**
 * ⚠️ RLS-P-2 — THE DEGRADATIONS FINALLY HAVE A READER.
 *
 * RLS-P-1 made a swallowed ledger failure EXPRESSIBLE and nothing consumed it:
 * `degradations` had no production reader, `isTotalBlackout()` had none either,
 * and a refresh whose whole stage evidence failed to write returned exactly what
 * a fully-recorded refresh returns. "The caller must never claim stronger
 * success than the evidence supports" needs somewhere for the weaker claim to
 * arrive, and this is it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * It does not touch the return value, the thrown error, or `overallStatus`. The
 * status is derived from the stages that actually RAN; degrading it because
 * telemetry failed would fabricate a refresh failure, which is the same defect
 * pointing at the customer instead of at the operator. The incompleteness is
 * reported BESIDE the outcome, never folded into it.
 *
 * ── THE ONE GAP, STATED RATHER THAN HIDDEN ───────────────────────────────────
 * `recordProviderCall` is void-dispatched DURING the provider round trip, so its
 * rejection can land after this line has already read the list. A provider-call
 * degradation can therefore be missing from this summary. It is NOT missing from
 * monitoring: the escalation fires from inside the door whenever the write
 * actually fails, so Sentry sees it either way. Awaiting the emit to close the
 * gap is not available — it would put telemetry inside the provider's latency,
 * which is the thing `recordProviderCall` returns `void` to prevent.
 */
function reportLedgerCompleteness(runId: string, degradations: readonly LedgerDegradation[]): void {
  const line = describeLedgerDegradations(runId, degradations);
  if (line) console.error(line);
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

/**
 * Flatten the stage records into their ledger rows and write the one completion.
 *
 * Note what is NOT here any more: a try/catch per write. Swallowing a ledger
 * failure is the door's job, and having it in exactly one place is what made
 * `degradations` expressible at all — four hand-written catches reported four
 * console lines and nothing a caller or a monitor could read.
 */
async function closeExecution(
  ledger: LedgerHandle | null,
  records: RefreshStageRecord[],
  startedAt: Date,
  t0: number,
  err: unknown,
  override?: ExecutionVerdict,
): Promise<void> {
  if (ledger === null) return; // start write never landed — nothing to complete (append-only)

  // Persist one immutable endpoint result per attempted/skipped stage.
  await ledger.recordStages(
    records.map((r) => ({
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
  );

  // DF-2E — one immutable RefreshEndpointAccountCoverage row per (endpoint,
  // account) the execution evaluated. Flattened from the stage records that
  // reported per-account outcomes (BALANCES, HOLDINGS).
  await ledger.recordCoverage(
    records.flatMap((r) =>
      r.accounts.map((a) => ({
        endpoint: r.endpoint,
        financialAccountId: a.financialAccountId,
        status: a.status,
        reason: a.reason,
        freshnessAdvanced: a.freshnessAdvanced,
      })),
    ),
  );

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

  await ledger.close({
    completedAt: new Date(),
    durationMs: Date.now() - t0,
    overallStatus,
    errorSummary,
    ...(verdict.failureStage ? { failureStage: verdict.failureStage } : {}),
    ...(verdict.failureCategory ? { failureCategory: verdict.failureCategory } : {}),
    ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
  });
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
  deps: { client?: LedgerRecorder } = {},
): Promise<{ runId: string }> {
  const recorderClient = deps.client ?? productionLedgerRecorder();
  const runId = randomUUID();
  const startedAt = new Date();
  const t0 = Date.now();

  const ledger = await recorderClient.open(startData(params, runId, startedAt));

  if (ledger !== null) {
    await ledger.close({
      completedAt: new Date(),
      durationMs: Date.now() - t0,
      // No stages ran — the existing derivation rule, applied to nothing.
      overallStatus: deriveOverallStatus([]),
      admissionReason: params.admissionReason,
    });
  }

  // A denial whose ledger writes failed is a denial NOBODY CAN SEE — the row is
  // the entire product of this function. Same report, same reason.
  reportLedgerCompleteness(runId, recorderClient.degradations);

  return { runId };
}
