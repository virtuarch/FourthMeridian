/**
 * lib/plaid/refresh-execution-types.ts  (DF-2A — Canonical Refresh Execution Authority)
 *
 * The vocabulary + the observational recorder SEAM for the per-item refresh
 * execution ledger. Deliberately dependency-free (imports nothing from
 * refresh.ts or refresh-execution.ts) so the stage recorder can be threaded
 * into refreshPlaidItem (lib/plaid/refresh.ts) without an import cycle with the
 * orchestrator that consumes it (lib/plaid/refresh-execution.ts).
 *
 * STRINGS, NOT DB ENUMS (the JobRun idiom, prisma/schema.prisma JobRun): these
 * are TypeScript string-union types over plain String columns — TS keeps
 * exhaustiveness in the derivation switch, while the DB needs no migration to
 * gain a new trigger/profile/stage/skip-reason later (DF-2B..2F).
 */

/**
 * How a per-item refresh was initiated. Only currently-meaningful triggers.
 *
 * DF-2C TRIGGER DOCTRINE: the trigger names the INITIATING BUSINESS EVENT, NOT
 * the stage sequence executed. MANUAL / CRON / RECONNECT / WEBHOOK all share the
 * one execution LIFECYCLE (open → record → derive → close) while legitimately
 * running DIFFERENT endpoint subsets (manual runs holdings/reconciliation; cron
 * runs its transaction+balance+snapshot set; reconnect/webhook run the deferred
 * HISTORY_BACKFILL pipeline). A future entrypoint extends this authority by
 * supplying its own trigger + orchestration profile — it never forks the ledger.
 */
export type RefreshTrigger =
  | "MANUAL"      // the owning customer asked (refresh, sync, investments-enable)
  | "CRON"        // the scheduled batch
  | "RECONNECT"   // token exchange completed
  | "WEBHOOK"     // Plaid told us something changed
  | "ADMIN"       // reserved; no producer today
  // OPS-2D-1 — an OPERATOR acting on a customer's connection. A distinct
  // initiating event: not the owner, not the schedule, not the provider.
  // Attribution of WHO is the AuditLog's job; this only names the event.
  | "OPERATOR"
  // OPS-2D-1 — machine-driven continuation of an incomplete first-run import,
  // whether driven by the client poller or the server-side backstop. Distinct
  // from WEBHOOK: nothing was pushed to us, and from RECONNECT: no token
  // changed hands.
  | "RESUME";

/**
 * The caller-owned WORKFLOW an execution ran. Trigger says why it began;
 * profile says what shape of work it performed — the two are orthogonal
 * (REFRESH_EXECUTION_DOCTRINE.md §D/§E).
 *
 * OPS-2D-1 added the two below because the existing pair could not describe the
 * paths being converged without lying. A transactions-only sync recorded as
 * FULL_REFRESH would claim balances and holdings were refreshed when they were
 * not, and an import continuation recorded as RECONNECT would claim a token
 * exchange that never happened. A profile that misdescribes its own workflow is
 * exactly the unenforceable claim the enforceability doctrine forbids.
 */
export type RefreshProfile =
  | "FULL_REFRESH"      // balances → holdings → transactions → reconciliation → snapshot
  | "RECONNECT"         // the deferred post-connect / webhook historical pipeline
  | "TRANSACTIONS_ONLY" // the cursor-based transaction sync alone — no balances, no holdings
  | "IMPORT_RECOVERY";  // continuation of an INCOMPLETE first-run import from its cursor

/** Execution-level status, DERIVED from child stage results — never a stored success boolean. */
export type RefreshOverallStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED";

/**
 * One refresh stage. PROVIDER endpoints are live Plaid reads; DERIVED stages are
 * projections/reconciliation that run after them. `stageKind` (below) keeps the
 * mixed vocabulary unambiguous for consumers and the status derivation.
 */
export type RefreshEndpoint =
  | "TRANSACTIONS"
  | "BALANCES"
  | "HOLDINGS"
  | "INVESTMENT_ACTIVITY"
  | "SNAPSHOT"
  | "RECONCILIATION"
  // DF-2C — the connect/webhook deferred historical layer (reconstruction +
  // price backfill + MAX-window wealth history + historical snapshots) recorded
  // as ONE DERIVED stage. It is the reconnect/webhook-defining work; manual/cron
  // never run it (empty ≠ uncovered).
  | "HISTORY_BACKFILL";

export type RefreshStageKind = "PROVIDER" | "DERIVED";

export type RefreshStageStatus = "SUCCEEDED" | "FAILED" | "SKIPPED";

/**
 * Why a stage did not run. NOT_APPLICABLE (e.g. no investment accounts) must
 * NOT degrade an otherwise-successful refresh; BUDGET/IN_FLIGHT/COOLDOWN are
 * deferrals, also non-failures. Kept distinct so later consumers can tell a
 * structural "nothing to do" from a "we chose not to now".
 */
export type RefreshSkipReason = "NOT_APPLICABLE" | "BUDGET" | "IN_FLIGHT" | "COOLDOWN";

/** DF-2E — per-account coverage outcome, reported by stages that iterate accounts. */
export type AccountCoverageStatus = "COVERED" | "SKIPPED" | "FAILED";

/**
 * DF-2E — canonical reason a covered account was NOT freshly evaluated. Only
 * SKIPPED/FAILED carry one. ACCOUNT_DISCONNECTED (soft-deleted account under an
 * active item), NO_HOLDINGS (holdings stage, account held nothing), NOT_APPLICABLE
 * (endpoint N/A for the account), PROVIDER_FAILURE (reserved — per-account
 * provider failure; whole-stage failures record no per-account row).
 */
export type AccountCoverageReason = "ACCOUNT_DISCONNECTED" | "NO_HOLDINGS" | "NOT_APPLICABLE" | "PROVIDER_FAILURE";

/** One account's outcome within a stage — the atom of RefreshEndpointAccountCoverage. */
export interface AccountCoverageFact {
  financialAccountId: string;
  status: AccountCoverageStatus;
  reason?: AccountCoverageReason;
  /** Did THIS execution freshly observe/write the account for this endpoint (execution freshness). */
  freshnessAdvanced: boolean;
}

/** Facts a stage reports on success. All optional — a stage records only what it truthfully knows. */
export interface RefreshStageFacts {
  recordsRead?: number;
  recordsWritten?: number;
  recordsChanged?: number;
  /**
   * DF-2E — per-account coverage the stage genuinely evaluated (BALANCES,
   * HOLDINGS). Persisted as RefreshEndpointAccountCoverage rows. Omitted by
   * stages that do not iterate accounts (TRANSACTIONS is item-level; derived
   * stages carry none) — absence means "not evaluated per-account", never "not
   * covered". Never fabricate accounts a stage did not truly touch.
   */
  accounts?: AccountCoverageFact[];
  /**
   * DF-2B COVERAGE DOCTRINE: a COARSE evidence set of canonical FinancialAccount
   * ids DIRECTLY PROCESSED BY, or MATERIALLY USED AS INPUTS TO, this stage. Soft
   * references (ids only, no FK). NOT a per-account freshness/success/outcome
   * authority — empty ≠ uncovered, present ≠ updated, present ≠ freshness-advanced.
   * Populate only with accounts the stage genuinely touched; never invent or infer.
   */
  coveredAccountIds?: string[];
}

/** One finalized stage record, collected by the recorder and persisted as a RefreshEndpointResult. */
export interface RefreshStageRecord {
  endpoint: RefreshEndpoint;
  stageKind: RefreshStageKind;
  status: RefreshStageStatus;
  skipReason?: RefreshSkipReason;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  recordsRead?: number;
  recordsWritten?: number;
  recordsChanged?: number;
  coveredAccountIds: string[];
  freshnessAdvanced?: boolean;
  errorSummary?: string;
  /** DF-2E — per-account coverage carried from the stage facts, persisted at close. */
  accounts: AccountCoverageFact[];
}

/**
 * The observational SEAM threaded into refreshPlaidItem. Optional-chained at
 * every call site, so when no recorder is passed (the cron/bulk/webhook paths
 * today) refreshPlaidItem's behavior is byte-identical. The recorder NEVER
 * changes control flow — it only observes, exactly like runJob().
 */
export interface RefreshStageRecorder {
  /** Mark a stage started. */
  begin(endpoint: RefreshEndpoint, stageKind: RefreshStageKind): void;
  /** Finalize the open stage as SUCCEEDED with the facts it produced. */
  succeed(endpoint: RefreshEndpoint, facts?: RefreshStageFacts): void;
  /**
   * Finalize the open stage as FAILED WITHOUT throwing — for a best-effort stage
   * that caught its own error and continues (e.g. the cron balance/snapshot
   * freshness step). Distinct from a stage whose throw propagates (that is
   * finalized by the orchestrator). `endpoint` names the stage being failed.
   */
  fail(endpoint: RefreshEndpoint, err: unknown): void;
  /** Record a stage that did not run (may be called without a preceding begin). */
  skip(endpoint: RefreshEndpoint, stageKind: RefreshStageKind, reason: RefreshSkipReason): void;
  /**
   * Finalize WHATEVER stage is currently open as FAILED — for a never-throws
   * caller (runDeferredHistorySync) whose own catch handles the error without
   * re-throwing, so the orchestrator's catch never sees it. No-op if nothing is
   * open. Distinct from fail(endpoint): the caller need not know which stage.
   */
  failOpen(err: unknown): void;
}
