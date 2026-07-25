/**
 * lib/platform/refresh/types.ts  (OPS-2B — Operational Projection Layer)
 *
 * THE contracts of the canonical operational read model over the DF-2 refresh
 * ledger. Two seams, and only two (OPERATIONAL_TRUTH_SPINE.md §G.1):
 *
 *   Immutable facts → Operational Projections  (aggregates / summaries / timeline)
 *                   → Execution Query Seam     (bounded rows for forensics)
 *                   → Consumers
 *
 * No consumer reads `RefreshExecution` / `RefreshEndpointResult` / `ProviderCall` /
 * `RefreshEndpointAccountCoverage` directly. The permitted direct readers are the
 * WRITER (lib/plaid/refresh-execution.ts), MIGRATIONS, operator-run SCRIPTS, and
 * the seam itself.
 *
 * NOTHING HERE OWNS TRUTH. Every projection is a read-time reduction over
 * immutable facts; none is persisted, none is cached, none becomes an input to a
 * stored health state.
 *
 * ── THE FACT SHAPES ────────────────────────────────────────────────────────────
 * The `*Fact` interfaces below are the ONLY shapes the pure cores see. They are
 * structurally assignable from the Prisma rows but are declared independently so
 * the cores stay Prisma-free and unit-testable with in-memory fakes (the house
 * pattern shared with history/convergence/cost). Ledger columns are Strings by
 * the JobRun idiom, so the facts carry `string`, not TS unions — a value the
 * vocabulary does not yet know must degrade, never crash.
 */

import type { OperationalTier } from "@/lib/platform/history/types";

// ── Immutable fact shapes (as READ — never as written) ──────────────────────────

/** One `RefreshExecution` row. `plaidItemId` / `parentJobRunId` are SOFT refs. */
export interface ExecutionFact {
  id: string;
  runId: string;
  plaidItemId: string;
  trigger: string;
  profile: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  overallStatus: string;
  parentJobRunId: string | null;
  errorSummary: string | null;
  /**
   * OPS-2B′/2C-4 — the deployment that PRODUCED this execution, or null when it
   * was not observable when the row was written (local dev, self-hosted,
   * pre-OPS-2B′ history). EVIDENCE ATTACHED TO THE EXECUTION, never a subject of
   * its own: nothing groups, counts, or rolls up by it, and null is a permanent
   * honest answer rather than a gap to be filled.
   */
  deploymentSha: string | null;
}

/** One `RefreshEndpointResult` row — stage facts within one execution. */
export interface EndpointFact {
  refreshExecutionId: string;
  endpoint: string;
  stageKind: string;
  status: string;
  skipReason: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  recordsRead: number | null;
  recordsWritten: number | null;
  recordsChanged: number | null;
  freshnessAdvanced: boolean | null;
  errorSummary: string | null;
}

/** One `ProviderCall` row — ONE external provider request ATTEMPT. */
export interface ProviderCallFact {
  refreshExecutionId: string;
  endpoint: string | null;
  provider: string;
  operation: string;
  status: string;
  attempt: number;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  providerRequestId: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorCategory: string | null;
}

/** One `RefreshEndpointAccountCoverage` row — (execution, endpoint, account). */
export interface CoverageFact {
  refreshExecutionId: string;
  endpoint: string;
  financialAccountId: string;
  status: string;
  reason: string | null;
  freshnessAdvanced: boolean;
  createdAt: Date;
}

// ── The projection envelope ─────────────────────────────────────────────────────

/**
 * The trust + determinism envelope every projection carries.
 *
 * DETERMINISM (OPERATIONAL_TRUTH_SPINE.md §E.1) is TWO conditions, both required:
 *   1. the observation window is CLOSED (`to` strictly before today, UTC), AND
 *   2. no execution in the window is still open (`overallStatus = "RUNNING"`).
 *
 * Condition 2 is the one that is easy to miss: a past window still containing a
 * RUNNING execution is NOT reproducible, because that row will be closed later
 * and its duration/status will change. `deterministic` is therefore derived from
 * the FACTS, never assumed from the dates alone.
 *
 * `checkedAt` is observational metadata — WHEN the read happened. It is
 * deliberately NOT part of the projected value: the pure cores never produce it,
 * so "same facts in ⇒ identical bytes out" is provable at the core boundary.
 */
export interface ProjectionEnvelope {
  window: { from: string; to: string };
  /** True iff the window is closed AND no execution in it is still RUNNING. */
  deterministic: boolean;
  /** Why `deterministic` is false, or null when it is true. */
  indeterminacyReason: string | null;
  /** ISO instant of THIS read. Metadata — never part of the projected value. */
  checkedAt: string;
}

// ── Refresh Summary (executions + endpoint roll-up) ─────────────────────────────

/**
 * Per-stage roll-up across the window. `attempted` counts stage ROWS, not
 * accounts and not provider calls — a stage can SUCCEED after failed provider
 * attempts (`ProviderCall.status` ≠ `RefreshEndpointResult.status`).
 */
export interface EndpointRollup {
  endpoint: string;
  /** "PROVIDER" | "DERIVED" — mixed vocabulary stays disambiguated. */
  stageKinds: readonly string[];
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** SKIPPED reason counts, by the ledger's own vocabulary. */
  skipReasons: Readonly<Record<string, number>>;
  /** Stages reporting `freshnessAdvanced = true`. Never inferred from success. */
  freshnessAdvanced: number;
  /** Sum of `recordsChanged`; null when NO row reported one (≠ zero). */
  recordsChanged: number | null;
  meanDurationMs: number | null;
  maxDurationMs: number | null;
}

export interface RefreshSummary extends ProjectionEnvelope {
  executions: number;
  /** Counts by `overallStatus` — the DERIVED execution status, never re-derived here. */
  byStatus: Readonly<Record<string, number>>;
  byTrigger: Readonly<Record<string, number>>;
  byProfile: Readonly<Record<string, number>>;
  /** Executions still RUNNING — the determinism blocker, surfaced not hidden. */
  openExecutions: number;
  /** Executions correlated to a batch parent. Cron correlation is DF-2B.1. */
  withParentJob: number;
  meanDurationMs: number | null;
  maxDurationMs: number | null;
  /** Stable order: by endpoint name. */
  endpoints: readonly EndpointRollup[];
  tier: OperationalTier;
}

// ── Provider Operation Summary ──────────────────────────────────────────────────

/**
 * Per (provider, operation) attempt facts.
 *
 * ── NO RETRY RATE, DELIBERATELY ────────────────────────────────────────────────
 * `ProviderCall.attempt` counts the ordinal external request of an operation
 * within an execution — and at the Proxy chokepoint a RETRY and a PAGE are
 * indistinguishable (REFRESH_EXECUTION_DOCTRINE.md §M). A paginated
 * `transactionsSync` yields one row per page, so "attempt 4" may mean "the 4th
 * page", not "the 3rd retry". Publishing a retry rate over that would be a
 * confident wrong number. This projection therefore reports the ATTEMPT
 * DISTRIBUTION and flags `paginationConfounded`; it never derives a retry rate,
 * a retry count, or a "failures before success" statistic.
 */
export interface ProviderOperationRollup {
  provider: string;
  operation: string;
  /** Total attempt rows — NOT a count of logical operations. */
  calls: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  meanDurationMs: number | null;
  maxDurationMs: number | null;
  /** Ordinal histogram, ascending by attempt. Stable order. */
  attemptDistribution: readonly { attempt: number; calls: number }[];
  maxAttempt: number;
  /** True when attempt ordinals conflate retries with pagination for this operation. */
  paginationConfounded: boolean;
  /** One honest sentence stating what `attempt` means for THIS operation. */
  attemptSemantics: string;
}

export interface ProviderOperationSummary extends ProjectionEnvelope {
  /** Stable order: by provider, then operation. */
  operations: readonly ProviderOperationRollup[];
  totalCalls: number;
  tier: OperationalTier;
}

// ── Coverage Summary ────────────────────────────────────────────────────────────

/** Per-endpoint coverage roll-up across the window. */
export interface CoverageEndpointRollup {
  endpoint: string;
  covered: number;
  skipped: number;
  failed: number;
  /** Rows with `freshnessAdvanced = true`. A successful EMPTY response still advances. */
  freshnessAdvanced: number;
  distinctAccounts: number;
  /** SKIPPED/FAILED reason counts, by DF-2E's own vocabulary. */
  reasons: Readonly<Record<string, number>>;
}

/**
 * Per (account, endpoint) evidence. This is the FACTS half of the staleness
 * question — "when was this account last freshly observed for this endpoint".
 * The staleness VERDICT is deliberately not produced here (see the module doc on
 * projections-core: no per-endpoint cadence authority exists yet).
 */
export interface AccountCoverageRollup {
  financialAccountId: string;
  endpoint: string;
  observations: number;
  covered: number;
  skipped: number;
  failed: number;
  /** Newest COVERED observation, or null when never covered in this window. */
  lastCoveredAt: string | null;
  /** Newest observation whose `freshnessAdvanced` was true, or null. */
  lastFreshnessAdvancedAt: string | null;
  /** The newest row's reason (SKIPPED/FAILED), or null. */
  lastReason: string | null;
}

export interface CoverageSummary extends ProjectionEnvelope {
  /** Stable order: by endpoint. */
  endpoints: readonly CoverageEndpointRollup[];
  /** Stable order: by (financialAccountId, endpoint). */
  accounts: readonly AccountCoverageRollup[];
  distinctAccounts: number;
  tier: OperationalTier;
}

// ── Failure Summary ─────────────────────────────────────────────────────────────

/**
 * Failures grouped ONLY by taxonomies that already exist — the execution's
 * derived `overallStatus`, the stage `endpoint`, and Plaid's OWN
 * `errorCode`/`errorCategory`. No new failure taxonomy is invented here, and
 * free-text `errorSummary` is never grouped (it is not a controlled vocabulary).
 */
export interface FailureSummary extends ProjectionEnvelope {
  /** Executions by non-success status. Stable order: by status. */
  executions: readonly { status: string; count: number }[];
  /** Failed stages by endpoint. Stable order: by endpoint. */
  endpoints: readonly { endpoint: string; failed: number }[];
  /** Failed/rate-limited provider attempts by the PROVIDER's own code. */
  providerCalls: readonly {
    provider: string;
    operation: string;
    status: string;
    errorCode: string | null;
    errorCategory: string | null;
    count: number;
  }[];
  totalFailedExecutions: number;
  totalFailedStages: number;
  totalFailedCalls: number;
  tier: OperationalTier;
}

// ── Execution Timeline ──────────────────────────────────────────────────────────

/** One ordered event in a single execution's story. Timeline DTOs only — no health. */
export interface TimelineEntry {
  at: string;
  kind:
    | "execution-started"
    | "stage-started"
    | "stage-ended"
    | "provider-call"
    | "account-coverage"
    | "execution-completed";
  label: string;
  endpoint: string | null;
  status: string | null;
  durationMs: number | null;
  /** System-generated context. Never free-text error bodies, never customer data. */
  detail: string | null;
}

export interface ExecutionTimeline {
  executionId: string;
  runId: string;
  /** False while the execution is still RUNNING — the timeline is not yet whole. */
  complete: boolean;
  /** Chronological, with a stable tiebreak so equal timestamps never reorder. */
  entries: readonly TimelineEntry[];
  tier: OperationalTier;
}
