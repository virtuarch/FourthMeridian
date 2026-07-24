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

/** How a per-item refresh was initiated. Only currently-meaningful triggers. */
export type RefreshTrigger = "MANUAL" | "CRON" | "RECONNECT" | "WEBHOOK" | "ADMIN";

/** The two canonical refresh operations (DF-2 taxonomy). No LIGHT/REALTIME/tier profiles. */
export type RefreshProfile = "FULL_REFRESH" | "RECONNECT";

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
  | "RECONCILIATION";

export type RefreshStageKind = "PROVIDER" | "DERIVED";

export type RefreshStageStatus = "SUCCEEDED" | "FAILED" | "SKIPPED";

/**
 * Why a stage did not run. NOT_APPLICABLE (e.g. no investment accounts) must
 * NOT degrade an otherwise-successful refresh; BUDGET/IN_FLIGHT/COOLDOWN are
 * deferrals, also non-failures. Kept distinct so later consumers can tell a
 * structural "nothing to do" from a "we chose not to now".
 */
export type RefreshSkipReason = "NOT_APPLICABLE" | "BUDGET" | "IN_FLIGHT" | "COOLDOWN";

/** Facts a stage reports on success. All optional — a stage records only what it truthfully knows. */
export interface RefreshStageFacts {
  recordsRead?: number;
  recordsWritten?: number;
  recordsChanged?: number;
  /** Stable canonical FinancialAccount ids this stage covered (endpoint-grained). */
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
  /** Record a stage that did not run (may be called without a preceding begin). */
  skip(endpoint: RefreshEndpoint, stageKind: RefreshStageKind, reason: RefreshSkipReason): void;
}
