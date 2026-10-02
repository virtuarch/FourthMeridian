/**
 * lib/plaid/refresh-ledger.ts  (RLS-P-1)
 *
 * THE OPERATIONAL LEDGER GETS EXACTLY ONE DOOR.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A CAPABILITY, NOT A CLIENT. Nothing outside this module may hold a database
 * client that can write the (B) family — the six operational-ledger tables
 * `fm_app` is revoked from outright (prisma/migrations/20261002000100_rls_roles_
 * and_policies/migration.sql §4):
 *
 *     RefreshExecution · RefreshEndpointResult · RefreshEndpointAccountCoverage
 *     ProviderCall     · SyncIssue             · SyncIssueOccurrence
 *
 * Before this slice those writes were spread over four modules and nine call
 * sites, each resolving its own module-global `db`. The authority question —
 * "which principal writes the operational ledger?" — therefore had nine answers,
 * and any slice that flipped it would have had to find all nine and would have
 * gone green having found six.
 *
 * ⚠️ THIS SLICE CHANGES NO AUTHORITY. Every write still runs through exactly the
 * client it ran through before (the migration principal). What changes is that
 * there is now ONE PLACE to change it. The `audit-db-authority` ratchet is
 * unmoved on purpose, and this module deliberately does NOT import `@/lib/db`:
 * it is handed a client, exactly like lib/db/conditional-write.ts is handed a
 * probe. That is what makes the later flip a one-line change at the binding site
 * rather than a hunt, and it is also what lets a pure test drive the whole door.
 *
 * ── THE THREE LOAD-BEARING PROPERTIES ────────────────────────────────────────
 *
 * 1. THE EXECUTION ID IS MINTED, NEVER ACCEPTED. `open()` performs the INSERT
 *    and the row's id is returned only as the handle's `executionId`. No entry
 *    point on `LedgerRecorder` or `LedgerHandle` takes a `refreshExecutionId`,
 *    so there is no argument through which a caller could ask this door about
 *    another execution — let alone another tenant's. Every row written here
 *    carries `refreshExecutionId: this.executionId` and nothing else, and both
 *    halves of that are scanned in refresh-ledger.test.ts. Same reasoning the
 *    migration gives for `fm_visible_space_ids()` being SECURITY DEFINER: the
 *    scope is established by the definer, never argued by the caller.
 *
 * 2. NO ROW CROSSES THE BOUNDARY. Every method of `LedgerHandle` returns `void`
 *    or `Promise<void>`. The rule cannot be "no reads" — the incident lifecycle
 *    legitimately reads `SyncIssue` to converge on an active episode, and the
 *    historical stage writer legitimately reads its own prior attempts to number
 *    the next one. The honest rule is: every read is keyed by a value this
 *    execution minted (`executionId`, or the `incidentKey` the lifecycle derives)
 *    or by a scope its caller already proved (`plaidItemId`), and NO read returns
 *    its rows to the caller.
 *
 * 3. NO CREDENTIAL MAY PASS THROUGH IT. The three credential spellings this
 *    codebase uses — the decryption helper and the two token field names — do
 *    not appear anywhere in this file, not even in a comment, and
 *    refresh-ledger.test.ts asserts it over the RAW source so a comment cannot
 *    launder one in. The ledger describes provider calls; it must never be able
 *    to carry what authorised them.
 *
 * ── WHY METHODS AND NOT `asSystem(fn)` ───────────────────────────────────────
 * The obvious shape for a split-authority seam is a phase runner that yields a
 * client (the BriefRuntime idiom, lib/ai/brief/store.ts). It cannot be used
 * here, for one concrete reason: `recordProviderCall` is dispatched WITHOUT
 * AWAIT from inside the provider round trip (lib/plaid/provider-call.ts), so it
 * can never live inside a scoped transaction under any authority. A phase runner
 * would either have to break that or lie about it. So the system half is a fixed
 * set of methods, each of which owns its own round trip.
 *
 * ── WHY A LEDGER FAILURE IS STILL SWALLOWED ──────────────────────────────────
 * TELEMETRY NEVER BREAKS REFRESH (the runJob house contract). Every method here
 * is best-effort and non-throwing, and `runFullRefresh` returns the runner's
 * result unchanged and rethrows the ORIGINAL error object — which is what lets
 * `reportItemRefreshFailure` classify it byte-identically. Making a ledger
 * failure fatal would turn a telemetry outage into a product outage.
 *
 * What is NEW is that silence is no longer the only record. `degradations` names
 * what this execution's ledger failed to write, by table, by phase and by Prisma
 * code — never a message and never a row. A start failure suppresses every other
 * write for that execution (no stages, no coverage, no provider calls, no
 * completion), which is a TOTAL BLACKOUT of the (B) family for that refresh;
 * `isTotalBlackout()` says so in one place instead of leaving it to be inferred.
 *
 * LEDGER WRITES ARE NEVER ATOMIC WITH FINANCIAL WRITES. Observation must not be
 * able to decide whether the observed mutation lives (OPS-2D-TX-1).
 */

import { classifyDbError } from "@/lib/monitoring/capture";
import { captureLedgerWriteFailure } from "@/lib/monitoring/capture";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { getProviderCallContext } from "@/lib/plaid/provider-call-context";
import {
  prepareHistoricalStageRow,
  type HistoricalStageRow,
  type StageSettleArgs,
} from "@/lib/plaid/historical-stage-recorder";
// ⚠️ TYPE-ONLY, BOTH WAYS. The four row shapes stay declared in
// refresh-execution.ts because lib/monitoring/deployment.test.ts pins the
// deploymentSha immutability THERE — the start data declares it, the completion
// data structurally cannot. `import type` is erased, so the module graph has no
// runtime cycle and this file still imports no database client of any kind.
import type {
  RefreshEndpointAccountCoverageData,
  RefreshEndpointResultData,
  RefreshExecutionCompletionData,
  RefreshExecutionStartData,
} from "@/lib/plaid/refresh-execution";
import type { SyncIssueInput } from "@/lib/plaid/syncIssues";

// ── The provider-call row ────────────────────────────────────────────────────
//
// Declared here rather than in provider-call.ts because it is a LEDGER ROW and
// this module is the only thing that may write one. provider-call.ts re-exports
// both names for its existing importers.
//
// DATA MINIMIZATION: only allowlisted operational fields exist on this type —
// provider, operation, status, timing, attempt, request id, http status, and
// Plaid's own error_code/error_type. There is deliberately no field for a token,
// a secret, a request/response payload, an account number or a free-form body,
// so the write cannot carry one even by mistake.

export type ProviderCallStatus = "SUCCEEDED" | "FAILED" | "RATE_LIMITED";

export interface ProviderCallInput {
  refreshExecutionId: string;
  endpoint?: string;
  provider: string;
  operation: string;
  status: ProviderCallStatus;
  attempt: number;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  providerRequestId?: string;
  httpStatus?: number;
  errorCode?: string;
  errorCategory?: string;
}

// ── The narrow write client (the JobRunWriteClient idiom, widened to six) ─────

/**
 * Exactly the operations this door performs, and nothing else.
 *
 * Structural rather than `typeof db` for the usual two reasons — it keeps this
 * module compile-independent of Prisma-client regeneration, and it lets a pure
 * test drive the real door. The third reason is new and is the point of the
 * slice: the shape names the (B)-family write surface in ONE type, so the
 * authority flip is "bind this to a different client".
 *
 * `SyncIssue` / `SyncIssueOccurrence` are deliberately NOT here. They are
 * reached through the incident lifecycle authority, which owns convergence, the
 * partial-unique-index race and the `$transaction` prohibition that keeps
 * telemetry out of a caller's transaction (lib/platform/incidents/lifecycle.ts).
 * Splitting those statements away from the P2002 retry that handles them would
 * be strictly worse, so the door calls the authority instead of re-spelling it.
 */
export interface LedgerWriteClient {
  refreshExecution: {
    create(args: { data: RefreshExecutionStartData; select: { id: true } }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: RefreshExecutionCompletionData }): Promise<unknown>;
  };
  refreshEndpointResult: {
    createMany(args: { data: RefreshEndpointResultData[] }): Promise<unknown>;
    /** The INCREMENTAL historical stage — one row as each stage settles (V26-STAGE-1). */
    create(args: { data: HistoricalStageRow }): Promise<unknown>;
  };
  refreshEndpointAccountCoverage: {
    createMany(args: { data: RefreshEndpointAccountCoverageData[] }): Promise<unknown>;
  };
  providerCall: {
    create(args: { data: ProviderCallInput }): Promise<unknown>;
  };
}

// ── Degradation — what the ledger failed to record ───────────────────────────

/** The six operational-ledger tables. */
export type LedgerTable =
  | "RefreshExecution"
  | "RefreshEndpointResult"
  | "RefreshEndpointAccountCoverage"
  | "ProviderCall"
  | "SyncIssue"
  | "SyncIssueOccurrence";

/** Which write failed. `start` is the one that suppresses all the others. */
export type LedgerWritePhase =
  | "start"
  | "stages"
  | "coverage"
  | "providerCall"
  | "incident"
  | "completion";

/**
 * One thing this execution's ledger failed to record.
 *
 * ⚠️ NO ROW CONTENTS AND NO MESSAGE, for the same reason `ConditionalWriteSite`
 * carries none (lib/db/conditional-write.ts): this travels into logs and error
 * reporting, and one of these writes is adjacent to operator settings. A table,
 * a phase and a static Prisma code are enough to find the policy.
 */
export interface LedgerDegradation {
  readonly ledger: LedgerTable;
  readonly phase: LedgerWritePhase;
  /** A Prisma code (via the single `classifyDbError` authority), never a message. */
  readonly dbErrorCode: string;
}

/**
 * A start failure means the (B) family recorded NOTHING for this refresh — no
 * execution row, so no stages, no coverage, no provider calls and no completion.
 *
 * Stated as a predicate rather than left to be inferred from an empty list,
 * because the two look identical from outside: a healthy execution also has no
 * stage degradations. The presence of the start failure is the only difference.
 */
export function isTotalBlackout(degradations: readonly LedgerDegradation[]): boolean {
  return degradations.some((d) => d.ledger === "RefreshExecution" && d.phase === "start");
}

// ── The capability ───────────────────────────────────────────────────────────

/**
 * Opens one execution. This is the ONLY way to obtain a `LedgerHandle`, which is
 * the only thing that can write the ledger.
 *
 * `null` from `open()` is not an error to handle — it means the start write
 * failed, the refresh proceeds UNATTRIBUTED, and `degradations` says so.
 */
export interface LedgerRecorder {
  open(data: RefreshExecutionStartData): Promise<LedgerHandle | null>;
  /**
   * Everything this recorder failed to record, INCLUDING a failed `open()`.
   *
   * Present on the recorder as well as the handle because a start failure
   * produces no handle: the blackout would otherwise be the one degradation
   * nothing could report.
   */
  readonly degradations: readonly LedgerDegradation[];
}

/**
 * The write capability for ONE open execution.
 *
 * Every method returns `void` — nothing a caller can read a row out of. The id
 * is readable (it is this execution's own identity, and the stage recorder and
 * the provider-call context both need it for correlation) but it is never
 * writable and never accepted.
 */
export interface LedgerHandle {
  /** Minted by `open()`. Read-only. Nothing can be written under another id. */
  readonly executionId: string;

  /** The immutable per-stage results, flushed once at completion. */
  recordStages(rows: readonly Omit<RefreshEndpointResultData, "refreshExecutionId">[]): Promise<void>;
  /** One row per (endpoint, account) this execution evaluated. */
  recordCoverage(rows: readonly Omit<RefreshEndpointAccountCoverageData, "refreshExecutionId">[]): Promise<void>;
  /**
   * One provider-call attempt.
   *
   * ⚠️ FIRE-AND-FORGET BY CONTRACT, AND NOT BY ACCIDENT. The Plaid proxy
   * dispatches this DURING the provider round trip (`void` at
   * provider-call.ts), so it must never be awaited into the call's latency and
   * must never run inside a transaction. It returns `void`, not
   * `Promise<void>`, so no caller can await it even if it wants to.
   */
  recordProviderCall(input: Omit<ProviderCallInput, "refreshExecutionId">): void;
  /** One historical stage, persisted AS IT SETTLES so a crash is resumable. */
  settleHistoricalStage(args: Omit<StageSettleArgs, "refreshExecutionId">): Promise<void>;
  /**
   * One failure observation, correlated to THIS execution.
   *
   * ⚠️ THE CORRELATOR IS OVERWRITTEN, NOT MERGED. `detail.runId` is replaced
   * with this execution's run id whatever the caller put there, so an
   * observation recorded through this door can never claim another run.
   */
  recordIncident(input: SyncIssueInput): Promise<void>;
  /** Close the active episodes that THIS execution's success actually proves. */
  resolveIncidentsByRecovery(scope: { plaidItemId: string }): Promise<void>;
  /** The single completion write. Append-only: one create, one update. */
  close(data: RefreshExecutionCompletionData): Promise<void>;

  /** What this execution's ledger FAILED to record. Empty = complete. */
  readonly degradations: readonly LedgerDegradation[];
}

/**
 * The collaborators the door does not own.
 *
 * The incident pair are resolved through the FACADE (lib/plaid/syncIssues.ts),
 * never through the lifecycle authority directly — `incident-boundary.test.ts`
 * pins the facade as the authority's only caller, and that ratchet is correct:
 * two entry points into detection is exactly what let btc-sync's failures stop
 * converging. They are resolved LAZILY so that importing this module pulls in
 * neither Prisma nor the semantics authority.
 */
export interface LedgerRecorderDeps {
  recordSyncIssue?: (input: SyncIssueInput) => Promise<void>;
  resolveCursorBlockingIssues?: (plaidItemId: string, runId: string) => Promise<number>;
  /** Escalation for a swallowed write. Defaults to the Sentry capture. */
  capture?: (ledger: LedgerTable, phase: LedgerWritePhase, error: unknown) => void;
}

async function defaultRecordSyncIssue(input: SyncIssueInput): Promise<void> {
  const { recordSyncIssue } = await import("@/lib/plaid/syncIssues");
  await recordSyncIssue(input);
}

async function defaultResolveCursorBlockingIssues(plaidItemId: string, runId: string): Promise<number> {
  const { resolveCursorBlockingIssues } = await import("@/lib/plaid/syncIssues");
  return resolveCursorBlockingIssues(plaidItemId, undefined, runId);
}

/**
 * Escalate a swallowed ledger failure.
 *
 * `captureLedgerWriteFailure` currently types its ledger as JobRun |
 * RefreshExecution and its phase as start | completion. Widening that union to
 * the six tables and six phases, and wiring every site into it, is P-2; until
 * then only the two shapes it already understands are reported to Sentry and
 * everything else is reported through `degradations` and the log. Narrowing the
 * cast instead of widening the type keeps P-1 free of monitoring churn.
 */
function defaultCapture(ledger: LedgerTable, phase: LedgerWritePhase, error: unknown): void {
  if (ledger !== "RefreshExecution") return;
  // Spelled as literals rather than passed through, so the escalation stays
  // greppable: lib/jobs/run.test.ts pins both of these by name, and that ratchet
  // is the reason a write-dead ledger cannot go back to hiding behind a 200.
  if (phase === "start") captureLedgerWriteFailure("RefreshExecution", "start", error);
  else if (phase === "completion") captureLedgerWriteFailure("RefreshExecution", "completion", error);
}

/**
 * Bind the door to a write client.
 *
 * THE ONE PLACE AN AUTHORITY IS CHOSEN is the call site of this function, and
 * there is exactly one in production (lib/plaid/refresh-execution.ts). A test
 * passes an in-memory client and gets the real door, which is why the behaviour
 * below is provable without a database.
 */
export function ledgerRecorderFor(
  client: LedgerWriteClient,
  deps: LedgerRecorderDeps = {},
): LedgerRecorder {
  const degradations: LedgerDegradation[] = [];
  const capture = deps.capture ?? defaultCapture;
  const recordSyncIssue = deps.recordSyncIssue ?? defaultRecordSyncIssue;
  const resolveCursorBlocking = deps.resolveCursorBlockingIssues ?? defaultResolveCursorBlockingIssues;

  /** Swallow, name, and escalate. The only place a ledger failure is absorbed. */
  const degrade = (ledger: LedgerTable, phase: LedgerWritePhase, scope: string, error: unknown): void => {
    degradations.push({ ledger, phase, dbErrorCode: classifyDbError(error) });
    console.error(
      `[refresh-ledger] ${scope}: ${ledger} ${phase} write failed (non-fatal):`,
      redactedErrorForLog(error),
    );
    try { capture(ledger, phase, error); } catch { /* monitoring must not become the failure */ }
  };

  function makeHandle(executionId: string, runId: string): LedgerHandle {
    const handle: LedgerHandle = {
      executionId,
      degradations,

      async recordStages(rows) {
        if (rows.length === 0) return;
        try {
          await client.refreshEndpointResult.createMany({
            data: rows.map((r) => ({ ...r, refreshExecutionId: executionId })),
          });
        } catch (err) {
          degrade("RefreshEndpointResult", "stages", executionId, err);
        }
      },

      async recordCoverage(rows) {
        if (rows.length === 0) return;
        try {
          await client.refreshEndpointAccountCoverage.createMany({
            data: rows.map((r) => ({ ...r, refreshExecutionId: executionId })),
          });
        } catch (err) {
          degrade("RefreshEndpointAccountCoverage", "coverage", executionId, err);
        }
      },

      recordProviderCall(input) {
        // `void`, not `Promise<void>`: the proxy fires this mid-round-trip and
        // must not be able to await it. The rejection is handled HERE so there
        // is no unhandled one to leak into the provider's try/catch.
        void (async () => {
          try {
            await client.providerCall.create({ data: { ...input, refreshExecutionId: executionId } });
          } catch (err) {
            degrade("ProviderCall", "providerCall", executionId, err);
          }
        })();
      },

      async settleHistoricalStage(args) {
        try {
          // The stage VOCABULARY stays with the stage authority: a refused stage
          // name, status or error code produces no row and is not a degradation.
          const row = await prepareHistoricalStageRow(executionId, args);
          if (row === null) return;
          await client.refreshEndpointResult.create({ data: row });
        } catch (err) {
          degrade("RefreshEndpointResult", "stages", executionId, err);
        }
      },

      async recordIncident(input) {
        const detail = { ...(input.detail as Record<string, unknown> | undefined), runId };
        try {
          await recordSyncIssue({ ...input, detail });
        } catch (err) {
          // The facade never throws today; this exists so that a future one that
          // does cannot take a refresh with it.
          degrade("SyncIssue", "incident", executionId, err);
        }
      },

      async resolveIncidentsByRecovery(scope) {
        try {
          await resolveCursorBlocking(scope.plaidItemId, runId);
        } catch (err) {
          degrade("SyncIssue", "incident", executionId, err);
        }
      },

      async close(data) {
        try {
          await client.refreshExecution.update({ where: { id: executionId }, data });
        } catch (err) {
          degrade("RefreshExecution", "completion", executionId, err);
        }
      },
    };
    return handle;
  }

  return {
    degradations,

    async open(data) {
      try {
        const row = await client.refreshExecution.create({ data, select: { id: true } });
        return makeHandle(row.id, data.runId);
      } catch (err) {
        // ⚠️ NON-FATAL BUT LOUD, AND TOTAL. A single denied INSERT erases the
        // whole (B) family for this refresh: no stages, no coverage, no provider
        // calls, no completion. This ledger had been write-dead in production
        // since 2026-07-24 (the table was never migrated) and nothing reported
        // it — which is why the blackout is named rather than merely logged.
        degrade("RefreshExecution", "start", data.runId, err);
        console.error(
          `[refresh-ledger] ${data.runId}: TOTAL LEDGER BLACKOUT — the refresh will run UNATTRIBUTED ` +
            "(no execution, no stages, no coverage, no provider calls, no completion).",
        );
        return null;
      }
    },
  };
}

/**
 * The door for the execution in flight on this async stack, or null.
 *
 * Carried by the provider-call context (AsyncLocalStorage), which
 * `runFullRefresh` establishes around the runner. This is how a producer DEEP
 * inside the pipeline — `syncTransactions`, which is also called with no
 * envelope at all from `exchangeToken` — reaches the ledger without the id being
 * threaded through its signature. A threaded id is exactly the hazard property 1
 * removes: a parameter a caller could point at somebody else's execution.
 *
 * `null` is a normal answer and means "not inside an execution", not "failed".
 */
export function activeLedger(): LedgerHandle | null {
  return getProviderCallContext()?.ledger ?? null;
}
