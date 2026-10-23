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
import type { LedgerWritePhase, OperationalLedger } from "@/lib/monitoring/capture";
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
    /**
     * ⚠️ RLS-P-2 — THE ONLY READ ON THIS CLIENT, AND IT IS PART OF A WRITE.
     * Numbering the next historical attempt used to resolve the module-global
     * `db` inside the stage authority while the INSERT it feeds ran through
     * whatever client this door was bound to, so one logical write was split
     * across two principals. A probe on a WIDER authority than its write
     * answers about rows the writer cannot see — the rule
     * lib/db/conditional-write.ts states and the reason its probe is a thunk
     * over the writing client. It returns a number, never a row, so property 2
     * (no row crosses the boundary) is untouched.
     */
    findFirst(args: {
      where: { refreshExecutionId: string; endpoint: string };
      orderBy: { attempt: "desc" };
      select: { attempt: true };
    }): Promise<{ attempt: number | null } | null>;
  };
  refreshEndpointAccountCoverage: {
    createMany(args: { data: RefreshEndpointAccountCoverageData[] }): Promise<unknown>;
  };
  providerCall: {
    create(args: { data: ProviderCallInput }): Promise<unknown>;
  };
}

// ── Degradation — what the ledger failed to record ───────────────────────────

/**
 * The six operational-ledger tables — the (B) family, which is exactly the
 * escalation vocabulary minus `JobRun` (that ledger belongs to lib/jobs/run.ts
 * and is written at a different grain).
 *
 * Derived rather than re-spelled so the two cannot drift: a table added to the
 * family arrives here automatically, and a degradation can never name a table
 * `captureLedgerWriteFailure` has no tag for.
 */
export type LedgerTable = Exclude<OperationalLedger, "JobRun">;

/**
 * Which write failed. `start` is the one that suppresses all the others.
 *
 * ⚠️ RLS-P-2 — ONE VOCABULARY, DEFINED ONCE. This used to be a second,
 * independent union that happened to resemble the one in lib/monitoring/capture.ts
 * and was NARROWER than it: a degradation could name a phase the escalation had
 * no word for, and `defaultCapture` silently dropped those on the floor. They are
 * now the same type, so the two can no longer drift apart and a new phase must be
 * given an effect sentence before it can be degraded under.
 */
export type { LedgerWritePhase } from "@/lib/monitoring/capture";

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
 * WHERE a swallowed write happened, with no error attached (RLS-P-2).
 *
 * The incident lifecycle swallows its own failures by contract — every one of
 * its fourteen producers calls it from inside a catch block — so the error
 * object is gone by the time this door could see it. What CAN be reported is the
 * statement, and that is all this carries. `dbErrorCode` is therefore absent
 * here and filled in as `UNKNOWN` by `classifyDbError`, which is the honest
 * answer: the code was classified where the error was, not here.
 */
export interface LedgerWriteSite {
  readonly ledger: LedgerTable;
  readonly phase: LedgerWritePhase;
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

/**
 * HOW COMPLETE THIS EXECUTION'S LEDGER ACTUALLY IS (RLS-P-2).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A BOOLEAN ─────────────────────────────
 * RLS-P-1 made the degradations EXPRESSIBLE and nothing READ them: `degradations`
 * had no production consumer at all, `isTotalBlackout` had none either, and a
 * refresh whose entire stage evidence failed to write logged four lines and then
 * returned exactly what a fully-recorded refresh returns. That is the shape this
 * programme is here to remove — the caller claiming a success the evidence does
 * not support — so the degradations needed somewhere honest to arrive.
 *
 * It is deliberately NOT a boolean, because the three states are not ordered on
 * one axis and an operator acts on them differently:
 *
 *   COMPLETE     every write landed. The ledger can be read at face value.
 *   PARTIAL      the execution row exists but some of its evidence does not, so
 *                the row OVERSTATES what is recorded beneath it. A `SUCCEEDED`
 *                execution with no stage rows is the readable symptom.
 *   BLACKOUT     the start write failed, so NOTHING was recorded and the refresh
 *                ran unattributed. Not a worse PARTIAL — a different fact.
 *
 * ⚠️ IT DOES NOT, AND MUST NOT, CHANGE `overallStatus`. The status is derived
 * from the stages that actually ran; degrading it because telemetry failed would
 * FABRICATE a refresh failure, which is the mirror image of the defect and
 * strictly worse (it reaches the customer). The incompleteness is reported
 * BESIDE the status, never folded into it.
 *
 * ⚠️ AND IT CARRIES NO ROW, NO MESSAGE AND NO IDENTIFIER, for the same reason a
 * `LedgerDegradation` does not: it is built to travel into a log line.
 */
export type LedgerCompleteness = "COMPLETE" | "PARTIAL" | "BLACKOUT";

export function ledgerCompleteness(degradations: readonly LedgerDegradation[]): LedgerCompleteness {
  if (isTotalBlackout(degradations)) return "BLACKOUT";
  return degradations.length === 0 ? "COMPLETE" : "PARTIAL";
}

/**
 * One line an operator can act on, or `null` when there is nothing to say.
 *
 * `null` rather than an empty string so a caller cannot log a blank line for a
 * healthy refresh, which is how a warning channel becomes noise and then becomes
 * ignored — the end state of the 2026-07-26 incident.
 */
export function describeLedgerDegradations(
  runId: string,
  degradations: readonly LedgerDegradation[],
): string | null {
  if (degradations.length === 0) return null;
  const completeness = ledgerCompleteness(degradations);
  // Deduplicated: a provider-call failure repeated forty times is one fact about
  // the ledger, and forty copies of it in a log line is a reason not to read it.
  const named = [...new Set(degradations.map((d) => `${d.ledger}/${d.phase}:${d.dbErrorCode}`))].sort();
  return (
    `[refresh-ledger] ${runId}: LEDGER ${completeness} — this execution's operational record is incomplete ` +
    `and must not be read as evidence of what the refresh did: ${named.join(" ")}`
  );
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
  /**
   * ⚠️ RLS-P-2 — IT REPORTS WHETHER IT WROTE. The facade's contract is NEVER
   * THROWS (fourteen producers call it from inside their own catch blocks), so
   * a failed incident write used to be indistinguishable from a successful one
   * at this boundary: the door's `try/catch` around it could not fire, and a
   * SyncIssue failure was the one degradation this door structurally could not
   * report. The failure therefore travels as a RETURN VALUE.
   *
   * `null` means recorded (or refused by the lifecycle's own invariants, which
   * is not a failure and must not be reported as one). A site means the write
   * failed, and names the table and the half of the lifecycle it was.
   */
  recordSyncIssue?: (input: SyncIssueInput) => Promise<LedgerWriteSite | null>;
  resolveCursorBlockingIssues?: (
    plaidItemId: string,
    runId: string,
  ) => Promise<{ resolved: number; failedWrite: LedgerWriteSite | null }>;
  /** Escalation for a swallowed write. Defaults to the Sentry capture. */
  capture?: (ledger: LedgerTable, phase: LedgerWritePhase, error: unknown) => void;
}

/**
 * The incident lifecycle names a table from the whole seven-value escalation
 * vocabulary; only the two incident tables can reach this door. Anything else
 * would mean the authority reported a statement it does not own, which is worth
 * seeing rather than coercing.
 */
function asIncidentSite(ledger: OperationalLedger, phase: LedgerWritePhase): LedgerWriteSite | null {
  if (ledger !== "SyncIssue" && ledger !== "SyncIssueOccurrence") {
    console.error(`[refresh-ledger] the incident authority reported a ${ledger} write failure, which it does not own — ignored.`);
    return null;
  }
  return { ledger, phase };
}

async function defaultRecordSyncIssue(input: SyncIssueInput): Promise<LedgerWriteSite | null> {
  const { recordSyncIssue } = await import("@/lib/plaid/syncIssues");
  let failed: LedgerWriteSite | null = null;
  // The facade forwards this straight to the lifecycle authority, which is the
  // only code that knows WHICH of its statements failed. Nothing but a table and
  // a phase crosses back: no row, no message, no Prisma error object.
  await recordSyncIssue(input, undefined, {
    onWriteFailure: (ledger, phase) => { failed = asIncidentSite(ledger, phase) ?? failed; },
  });
  return failed;
}

async function defaultResolveCursorBlockingIssues(
  plaidItemId: string,
  runId: string,
): Promise<{ resolved: number; failedWrite: LedgerWriteSite | null }> {
  const { resolveCursorBlockingIssues } = await import("@/lib/plaid/syncIssues");
  let failed: LedgerWriteSite | null = null;
  const resolved = await resolveCursorBlockingIssues(plaidItemId, undefined, runId, {
    onWriteFailure: (ledger, phase) => { failed = asIncidentSite(ledger, phase) ?? failed; },
  });
  return { resolved, failedWrite: failed };
}

/**
 * Escalate a swallowed ledger failure.
 *
 * ── RLS-P-2 — ALL EIGHT PAIRS, AND WHY EACH ONE IS SPELLED OUT ───────────────
 * This used to escalate TWO of the nine ledger-write sites and return early for
 * the other seven, so a write-dead ProviderCall / coverage / stage / incident
 * ledger reached `console.error` and stopped there — the identical shape of the
 * 2026-07-26 incident that `captureLedgerWriteFailure` was created for.
 *
 * ⚠️ THE ARGUMENTS ARE LITERALS, NOT THE PARAMETERS, AND THAT IS DELIBERATE.
 * `captureLedgerWriteFailure(ledger, phase, error)` type-checks, is shorter, and
 * SILENTLY RETIRES THE RATCHET: lib/jobs/run.test.ts greps for the literal text
 * `captureLedgerWriteFailure("RefreshExecution", "start"` precisely because the
 * narrowed-variable form compiles while naming nothing a scan can find. So each
 * pair is written out.
 *
 * The `default` is NOT exhaustiveness — six tables times eight phases is
 * forty-eight combinations of which eight are real, so the compiler cannot help
 * here. What the default does is REPORT the gap instead of returning early, so a
 * future write whose escalation nobody added is visible in the log rather than
 * silently unmonitored. That early return is precisely what this function did
 * for seven of its nine callers until this slice.
 */
function defaultCapture(ledger: LedgerTable, phase: LedgerWritePhase, error: unknown): void {
  switch (`${ledger}/${phase}` as `${LedgerTable}/${LedgerWritePhase}`) {
    case "RefreshExecution/start":
      captureLedgerWriteFailure("RefreshExecution", "start", error); return;
    case "RefreshExecution/completion":
      captureLedgerWriteFailure("RefreshExecution", "completion", error); return;
    case "RefreshEndpointResult/stages":
      captureLedgerWriteFailure("RefreshEndpointResult", "stages", error); return;
    case "RefreshEndpointAccountCoverage/coverage":
      captureLedgerWriteFailure("RefreshEndpointAccountCoverage", "coverage", error); return;
    case "ProviderCall/providerCall":
      captureLedgerWriteFailure("ProviderCall", "providerCall", error); return;
    case "SyncIssue/incident":
      captureLedgerWriteFailure("SyncIssue", "incident", error); return;
    case "SyncIssue/resolution":
      captureLedgerWriteFailure("SyncIssue", "resolution", error); return;
    case "SyncIssueOccurrence/incident":
      captureLedgerWriteFailure("SyncIssueOccurrence", "incident", error); return;
    default:
      // A (table, phase) combination the door never produces. Reported rather
      // than dropped, because reaching here means the door grew a write whose
      // escalation nobody wrote — exactly the state this function was in before.
      console.error(
        `[refresh-ledger] UNESCALATED ledger failure ${ledger}/${phase} — this pair has no ` +
          "capture line, so the failure reached no monitor. Add it to defaultCapture.",
      );
  }
}

/**
 * Bind the door to a write client, FOR ONE REFRESH.
 *
 * THE ONE PLACE AN AUTHORITY IS CHOSEN is the call site of this function, and
 * there is exactly one in production (lib/plaid/refresh-execution.ts). A test
 * passes an in-memory client and gets the real door, which is why the behaviour
 * below is provable without a database.
 *
 * ── ⚠️ RLS-P-2 — ONE RECORDER PER REFRESH, AND THAT IS NOT A STYLE PREFERENCE ─
 * `degradations` is a closure variable, so it belongs to the RECORDER and not to
 * the execution. RLS-P-1 bound one recorder at MODULE SCOPE, which made the
 * array process-global: on a warm serverless instance a stage failure from one
 * item's refresh stayed in the list and was read back as the next item's, and —
 * worse — a single failed `open()` made `isTotalBlackout()` answer TRUE for every
 * subsequent refresh in that process, including the ones whose start write
 * landed perfectly. The documentation said "what THIS execution failed to
 * record"; the code could not deliver that.
 *
 * Fixing the array's ownership instead would have meant the recorder could no
 * longer report a failed `open()` — there is no handle to hang it on, and that
 * blackout is the single most important thing the family reports. So the fix is
 * the LIFETIME: bind inside the refresh, and the recorder IS the execution.
 * Pinned mechanically (no `ledgerRecorderFor(` at module scope) and behaviourally
 * (two sequential refreshes do not share a degradation) in the failure-matrix
 * suite, because the cost of getting it wrong is invisible in every single-run
 * test — which is exactly how it shipped.
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

  /**
   * The same, for a failure that was swallowed SOMEWHERE ELSE and travelled back
   * as a site rather than as an error (RLS-P-2).
   *
   * There is no error object to classify, and `classifyDbError(undefined)`
   * answering `UNKNOWN` is the honest record of that: the code was classified by
   * the authority that held the error, and inventing one here would be worse than
   * admitting the gap. The escalation still fires, so the write is monitored even
   * though its Prisma code is not readable from this side.
   */
  const degradeReported = (site: LedgerWriteSite, scope: string): void => {
    degrade(site.ledger, site.phase, scope, undefined);
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
          const row = await prepareHistoricalStageRow(client.refreshEndpointResult, executionId, args);
          if (row === null) return;
          await client.refreshEndpointResult.create({ data: row });
        } catch (err) {
          degrade("RefreshEndpointResult", "stages", executionId, err);
        }
      },

      async recordIncident(input) {
        const detail = { ...(input.detail as Record<string, unknown> | undefined), runId };
        try {
          // ⚠️ RLS-P-2 — THE RETURN VALUE IS THE REPORT, NOT THE CATCH. The
          // facade NEVER THROWS by contract, so until this slice the catch below
          // was unreachable and a failed incident write was the one degradation
          // this door could not express: `degradations` said the ledger was
          // complete while the episode had silently not been recorded.
          const failed = await recordSyncIssue({ ...input, detail });
          if (failed) degradeReported(failed, executionId);
        } catch (err) {
          // Still here: a future facade that DOES throw must not take a refresh
          // with it. Both halves are needed — one for the contract as written,
          // one for the contract as it may change.
          degrade("SyncIssue", "incident", executionId, err);
        }
      },

      async resolveIncidentsByRecovery(scope) {
        try {
          // ⚠️ RLS-P-2 — THE GAP RLS-P-1 RECORDED, CLOSED. The authority returns
          // `{resolved: 0}` for BOTH "nothing matched" and "the write was
          // refused", and those are opposite facts: the first means this item had
          // no open cursor-blocking episode, the second means it still does and
          // nobody will ever hear that it recovered. The count alone cannot tell
          // them apart — the silent-refusal defect, on the operational ledger —
          // so the authority now reports the refusal separately.
          //
          // The RESOLUTION phase, not `incident`: an unrecorded failure and an
          // unclosed recovery need different alerts.
          const { failedWrite } = await resolveCursorBlocking(scope.plaidItemId, runId);
          if (failedWrite) degradeReported(failedWrite, executionId);
        } catch (err) {
          degrade("SyncIssue", "resolution", executionId, err);
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
