/**
 * lib/platform/refresh/projections-core.ts  (OPS-2B)
 *
 * The PURE reductions behind every refresh projection. No Prisma, no clock, no
 * I/O, no `server-only` — every function is a total function of the immutable
 * facts it is handed.
 *
 * ── WHY THE CORE PRODUCES NO `checkedAt` AND NO `deterministic` ────────────────
 * Both are properties of the READ, not of the value. Keeping them out of the core
 * makes determinism provable at this boundary: identical facts in ⇒ byte-identical
 * output out, with nothing to strip before comparing. The authority
 * (projections.ts) wraps these results in the `ProjectionEnvelope`.
 *
 * ── STABLE ORDERING IS PART OF THE CONTRACT ───────────────────────────────────
 * Every array is sorted by an explicit, total key before being returned, and
 * every record is rebuilt in sorted key order. A projection whose output depends
 * on database row order is not reproducible, so ordering is never left to the
 * input. `Object.keys` order is likewise never relied upon.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DERIVE ─────────────────────────────
 *   • A RETRY RATE — retries and pages are indistinguishable at the Proxy
 *     chokepoint (REFRESH_EXECUTION_DOCTRINE.md §M). See `types.ts`.
 *   • A REFRESH HEALTH VERDICT — "is refresh working" needs a per-connection
 *     cadence expectation, and the only cadence authority that exists
 *     (`PLAID_STALE_MS` in lib/connections/health.ts) already owns that decision.
 *     Re-deciding it here would be the forbidden second authority
 *     (OPERATIONAL_TRUTH_SPINE.md §D.4).
 *   • AN ACCOUNT STALENESS VERDICT — same reason: DF-2E ships the coverage FACTS
 *     and the reason vocabulary; "stale now" needs a per-ENDPOINT cadence
 *     authority that does not exist yet. This module reports `lastCoveredAt` /
 *     `lastFreshnessAdvancedAt` (facts) and stops there.
 *   • CUSTOMER IMPACT — needs connection status transitions, which are still
 *     homeless inside AuditLog (OPERATIONAL_TRUTH_SPINE.md §H.3, slice OPS-2D).
 *
 * Each omission is a validated rejection, not an oversight.
 */

import type {
  AccountCoverageRollup,
  CoverageEndpointRollup,
  CoverageFact,
  EndpointFact,
  EndpointRollup,
  ExecutionFact,
  ProviderCallFact,
  ProviderOperationRollup,
  TimelineEntry,
} from "@/lib/platform/refresh/types";
import type { OperationalTier } from "@/lib/platform/history/types";

// ── Shared helpers (pure) ───────────────────────────────────────────────────────

/** Sum of defined numbers, or null when NOTHING reported one. `null` ≠ `0`. */
function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let seen = false;
  for (const v of values) {
    if (v == null) continue;
    total += v;
    seen = true;
  }
  return seen ? total : null;
}

/** Arithmetic mean, rounded to a whole ms, or null when there is nothing to average. */
function meanOrNull(values: readonly (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return Math.round(present.reduce((a, b) => a + b, 0) / present.length);
}

function maxOrNull(values: readonly (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? Math.max(...present) : null;
}

/** Count occurrences into a record whose keys are rebuilt in sorted order. */
function tally(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) sorted[key] = counts.get(key)!;
  return sorted;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = groups.get(k);
    if (bucket) bucket.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/** Counts are `observed` (a row exists); anything averaged/derived is `derived`. */
function tierFor(rowCount: number, hasDerivedStat: boolean): OperationalTier {
  if (rowCount === 0) return "unknown";
  return hasDerivedStat ? "derived" : "observed";
}

/** Executions still open — the determinism blocker. Derived from FACTS, not dates. */
export function countOpenExecutions(executions: readonly ExecutionFact[]): number {
  return executions.filter((e) => e.overallStatus === "RUNNING" || e.completedAt == null).length;
}

// ── Refresh Summary ─────────────────────────────────────────────────────────────

export interface RefreshSummaryCore {
  executions: number;
  byStatus: Record<string, number>;
  byTrigger: Record<string, number>;
  byProfile: Record<string, number>;
  openExecutions: number;
  withParentJob: number;
  meanDurationMs: number | null;
  maxDurationMs: number | null;
  endpoints: EndpointRollup[];
  tier: OperationalTier;
}

/**
 * Roll executions + their stage rows into one summary.
 *
 * `overallStatus` is READ, never recomputed — `deriveOverallStatus()` in the
 * writer is its sole authority (REFRESH_EXECUTION_DOCTRINE.md §G). A projection
 * that re-derived it would be a second completion authority.
 */
export function buildRefreshSummary(
  executions: readonly ExecutionFact[],
  endpoints: readonly EndpointFact[],
): RefreshSummaryCore {
  const durations = executions.map((e) => e.durationMs);

  const byEndpoint = groupBy(endpoints, (r) => r.endpoint);
  const endpointRollups: EndpointRollup[] = [...byEndpoint.keys()]
    .sort()
    .map((endpoint) => {
      const rows = byEndpoint.get(endpoint)!;
      const skipped = rows.filter((r) => r.status === "SKIPPED");
      return {
        endpoint,
        stageKinds: [...new Set(rows.map((r) => r.stageKind))].sort(),
        attempted: rows.length,
        succeeded: rows.filter((r) => r.status === "SUCCEEDED").length,
        failed: rows.filter((r) => r.status === "FAILED").length,
        skipped: skipped.length,
        skipReasons: tally(skipped.map((r) => r.skipReason ?? "UNSPECIFIED")),
        // Read the recorded flag only. Success does NOT imply freshness advanced
        // — that is the false-green rule (OPERATIONAL_TRUTH_SPINE.md §D.2).
        freshnessAdvanced: rows.filter((r) => r.freshnessAdvanced === true).length,
        recordsChanged: sumOrNull(rows.map((r) => r.recordsChanged)),
        meanDurationMs: meanOrNull(rows.map((r) => r.durationMs)),
        maxDurationMs: maxOrNull(rows.map((r) => r.durationMs)),
      };
    });

  return {
    executions: executions.length,
    byStatus: tally(executions.map((e) => e.overallStatus)),
    byTrigger: tally(executions.map((e) => e.trigger)),
    byProfile: tally(executions.map((e) => e.profile)),
    openExecutions: countOpenExecutions(executions),
    withParentJob: executions.filter((e) => e.parentJobRunId != null).length,
    meanDurationMs: meanOrNull(durations),
    maxDurationMs: maxOrNull(durations),
    endpoints: endpointRollups,
    tier: tierFor(executions.length, true),
  };
}

// ── Provider Operation Summary ──────────────────────────────────────────────────

/**
 * Operations whose `attempt` ordinal counts PAGES as well as retries, because the
 * Proxy cannot distinguish them. Named explicitly rather than guessed from the
 * data: a paginated operation that happened to run once in a window would
 * otherwise be silently reported as un-confounded.
 */
export const PAGINATION_CONFOUNDED_OPERATIONS: readonly string[] = ["transactionsSync"];

const CONFOUNDED_SEMANTICS =
  "attempt counts every external request, including pagination pages — retries and pages are not distinguishable";
const PLAIN_SEMANTICS = "attempt counts every external request of this operation within one execution";

export interface ProviderOperationSummaryCore {
  operations: ProviderOperationRollup[];
  totalCalls: number;
  tier: OperationalTier;
}

export function buildProviderOperationSummary(
  calls: readonly ProviderCallFact[],
): ProviderOperationSummaryCore {
  const byOperation = groupBy(calls, (c) => `${c.provider} ${c.operation}`);

  const operations: ProviderOperationRollup[] = [...byOperation.keys()]
    .sort()
    .map((key) => {
      const rows = byOperation.get(key)!;
      const [provider, operation] = key.split(" ");
      const confounded = PAGINATION_CONFOUNDED_OPERATIONS.includes(operation);

      const attempts = tally(rows.map((r) => String(r.attempt)));
      const attemptDistribution = Object.keys(attempts)
        .map((a) => ({ attempt: Number(a), calls: attempts[a] }))
        .sort((a, b) => a.attempt - b.attempt);

      return {
        provider,
        operation,
        calls: rows.length,
        succeeded: rows.filter((r) => r.status === "SUCCEEDED").length,
        failed: rows.filter((r) => r.status === "FAILED").length,
        rateLimited: rows.filter((r) => r.status === "RATE_LIMITED").length,
        meanDurationMs: meanOrNull(rows.map((r) => r.durationMs)),
        maxDurationMs: maxOrNull(rows.map((r) => r.durationMs)),
        attemptDistribution,
        maxAttempt: rows.reduce((m, r) => Math.max(m, r.attempt), 0),
        paginationConfounded: confounded,
        attemptSemantics: confounded ? CONFOUNDED_SEMANTICS : PLAIN_SEMANTICS,
      };
    });

  return {
    operations,
    totalCalls: calls.length,
    tier: tierFor(calls.length, true),
  };
}

// ── Coverage Summary ────────────────────────────────────────────────────────────

export interface CoverageSummaryCore {
  endpoints: CoverageEndpointRollup[];
  accounts: AccountCoverageRollup[];
  distinctAccounts: number;
  tier: OperationalTier;
}

/**
 * ABSENCE IS NOT UNCOVERED, AND ABSENCE IS NOT FRESH. An account with no row for
 * an endpoint was simply not evaluated per-account by these executions — it must
 * never be rendered as covered, stale, or fresh on that basis
 * (REFRESH_COVERAGE_DOCTRINE.md §C/§D). This projection reports only accounts
 * that actually appear in the facts.
 */
export function buildCoverageSummary(coverage: readonly CoverageFact[]): CoverageSummaryCore {
  const byEndpoint = groupBy(coverage, (c) => c.endpoint);
  const endpoints: CoverageEndpointRollup[] = [...byEndpoint.keys()]
    .sort()
    .map((endpoint) => {
      const rows = byEndpoint.get(endpoint)!;
      const reasoned = rows.filter((r) => r.reason != null).map((r) => r.reason!);
      return {
        endpoint,
        covered: rows.filter((r) => r.status === "COVERED").length,
        skipped: rows.filter((r) => r.status === "SKIPPED").length,
        failed: rows.filter((r) => r.status === "FAILED").length,
        freshnessAdvanced: rows.filter((r) => r.freshnessAdvanced).length,
        distinctAccounts: new Set(rows.map((r) => r.financialAccountId)).size,
        reasons: tally(reasoned),
      };
    });

  const byPair = groupBy(coverage, (c) => `${c.financialAccountId} ${c.endpoint}`);
  const accounts: AccountCoverageRollup[] = [...byPair.keys()]
    .sort()
    .map((key) => {
      const rows = [...byPair.get(key)!].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const [financialAccountId, endpoint] = key.split(" ");

      const lastCovered = [...rows].reverse().find((r) => r.status === "COVERED");
      const lastAdvanced = [...rows].reverse().find((r) => r.freshnessAdvanced);
      const newest = rows[rows.length - 1];

      return {
        financialAccountId,
        endpoint,
        observations: rows.length,
        covered: rows.filter((r) => r.status === "COVERED").length,
        skipped: rows.filter((r) => r.status === "SKIPPED").length,
        failed: rows.filter((r) => r.status === "FAILED").length,
        lastCoveredAt: lastCovered ? lastCovered.createdAt.toISOString() : null,
        lastFreshnessAdvancedAt: lastAdvanced ? lastAdvanced.createdAt.toISOString() : null,
        lastReason: newest.reason,
      };
    });

  return {
    endpoints,
    accounts,
    distinctAccounts: new Set(coverage.map((c) => c.financialAccountId)).size,
    tier: tierFor(coverage.length, false),
  };
}

// ── Failure Summary ─────────────────────────────────────────────────────────────

export interface FailureSummaryCore {
  executions: { status: string; count: number }[];
  endpoints: { endpoint: string; failed: number }[];
  providerCalls: {
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

/** Execution statuses that represent a non-clean outcome. RUNNING is not a failure. */
const NON_SUCCESS_STATUSES = new Set(["FAILED", "PARTIAL"]);

/**
 * Group failures ONLY by taxonomies that already exist. Free-text `errorSummary`
 * is never grouped — it is not a controlled vocabulary, and grouping it would
 * mint a failure taxonomy this projection has no authority to own.
 */
export function buildFailureSummary(
  executions: readonly ExecutionFact[],
  endpoints: readonly EndpointFact[],
  calls: readonly ProviderCallFact[],
): FailureSummaryCore {
  const failedExecutions = executions.filter((e) => NON_SUCCESS_STATUSES.has(e.overallStatus));
  const executionCounts = tally(failedExecutions.map((e) => e.overallStatus));

  const failedStages = endpoints.filter((r) => r.status === "FAILED");
  const stageCounts = tally(failedStages.map((r) => r.endpoint));

  const failedCalls = calls.filter((c) => c.status === "FAILED" || c.status === "RATE_LIMITED");
  const callGroups = groupBy(
    failedCalls,
    (c) => [c.provider, c.operation, c.status, c.errorCode ?? "", c.errorCategory ?? ""].join(" "),
  );

  return {
    executions: Object.keys(executionCounts).map((status) => ({
      status,
      count: executionCounts[status],
    })),
    endpoints: Object.keys(stageCounts).map((endpoint) => ({
      endpoint,
      failed: stageCounts[endpoint],
    })),
    providerCalls: [...callGroups.keys()].sort().map((key) => {
      const rows = callGroups.get(key)!;
      const [provider, operation, status, errorCode, errorCategory] = key.split(" ");
      return {
        provider,
        operation,
        status,
        errorCode: errorCode === "" ? null : errorCode,
        errorCategory: errorCategory === "" ? null : errorCategory,
        count: rows.length,
      };
    }),
    totalFailedExecutions: failedExecutions.length,
    totalFailedStages: failedStages.length,
    totalFailedCalls: failedCalls.length,
    tier: tierFor(executions.length + endpoints.length + calls.length, false),
  };
}

// ── Execution Timeline ──────────────────────────────────────────────────────────

/** Deterministic tiebreak when two entries share an instant. */
const KIND_ORDER: Record<TimelineEntry["kind"], number> = {
  "execution-started": 0,
  "stage-started": 1,
  "provider-call": 2,
  "account-coverage": 3,
  "stage-ended": 4,
  "execution-completed": 5,
};

/**
 * Merge one execution's stage, provider-call and coverage facts into one ordered
 * story. TIMELINE DTOs ONLY — no health, no verdict, no aggregation beyond
 * per-entry counts that the facts already carry.
 *
 * Equal timestamps are broken by (kind order, label, endpoint) so the output is
 * byte-stable regardless of input order — a timeline that reshuffles on re-read
 * is not citable in an incident record.
 */
export function buildExecutionTimeline(
  execution: ExecutionFact,
  endpoints: readonly EndpointFact[],
  calls: readonly ProviderCallFact[],
  coverage: readonly CoverageFact[],
): { entries: TimelineEntry[]; complete: boolean; tier: OperationalTier } {
  const entries: TimelineEntry[] = [];

  entries.push({
    at: execution.startedAt.toISOString(),
    kind: "execution-started",
    label: `${execution.trigger} · ${execution.profile}`,
    endpoint: null,
    status: null,
    durationMs: null,
    detail: `run ${execution.runId}`,
  });

  for (const stage of endpoints) {
    entries.push({
      at: stage.startedAt.toISOString(),
      kind: "stage-started",
      label: stage.endpoint,
      endpoint: stage.endpoint,
      status: null,
      durationMs: null,
      detail: stage.stageKind,
    });
    if (stage.completedAt) {
      const records = sumOrNull([stage.recordsChanged]);
      entries.push({
        at: stage.completedAt.toISOString(),
        kind: "stage-ended",
        label: stage.endpoint,
        endpoint: stage.endpoint,
        status: stage.status,
        durationMs: stage.durationMs,
        // Structured facts only — the free-text errorSummary is never echoed here.
        detail: stage.skipReason
          ? `skipped: ${stage.skipReason}`
          : records != null
            ? `${records} changed`
            : null,
      });
    }
  }

  for (const call of calls) {
    entries.push({
      at: call.startedAt.toISOString(),
      kind: "provider-call",
      label: `${call.provider}.${call.operation}`,
      endpoint: call.endpoint,
      status: call.status,
      durationMs: call.durationMs,
      detail: call.errorCode ? `attempt ${call.attempt} · ${call.errorCode}` : `attempt ${call.attempt}`,
    });
  }

  for (const row of coverage) {
    entries.push({
      at: row.createdAt.toISOString(),
      kind: "account-coverage",
      label: row.endpoint,
      endpoint: row.endpoint,
      status: row.status,
      durationMs: null,
      detail: row.reason
        ? `${row.reason}${row.freshnessAdvanced ? " · freshness advanced" : ""}`
        : row.freshnessAdvanced
          ? "freshness advanced"
          : null,
    });
  }

  if (execution.completedAt) {
    entries.push({
      at: execution.completedAt.toISOString(),
      kind: "execution-completed",
      label: execution.overallStatus,
      endpoint: null,
      status: execution.overallStatus,
      durationMs: execution.durationMs,
      detail: null,
    });
  }

  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return (a.endpoint ?? "").localeCompare(b.endpoint ?? "");
  });

  const complete = execution.completedAt != null && execution.overallStatus !== "RUNNING";
  return { entries, complete, tier: complete ? "observed" : "incomplete" };
}
