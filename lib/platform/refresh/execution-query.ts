/**
 * lib/platform/refresh/execution-query.ts  (OPS-2B — Execution Query Seam)
 *
 * THE canonical row-level read API over the DF-2 refresh ledger — the operational
 * counterpart of `queryTransactions()`. It exists for execution forensics,
 * operator investigation, support investigation, and future drill panels.
 *
 * IT COMPOSES: scope · redaction · DTO projection · keyset paging.
 * IT DOES NOT:  aggregate · compute health · derive projections · bypass
 *               security · expose raw persistence.
 *
 * A caller that wants a count, a rate, a roll-up or a verdict is a PROJECTION
 * caller (lib/platform/refresh/projections.ts). This module returns bounded rows
 * and a cursor, nothing more — the same division `queryTransactions` keeps from
 * `DayFacts`.
 *
 * ── AUTHORIZATION ─────────────────────────────────────────────────────────────
 * Authorization stays at the ROUTE boundary (`requirePlatformAccess`), exactly as
 * every other platform read model — this seam is not a session-aware adapter. What
 * it DOES own is scope: a `support` caller that names no connection gets an empty
 * page, never a platform-wide one. The audience a route passes must be derived
 * from the caller's grant, never from a request parameter.
 *
 * ── THE ONLY DIRECT LEDGER READ PATH FOR CONSUMERS ────────────────────────────
 * Permitted direct readers of `RefreshExecution` / `RefreshEndpointResult` /
 * `ProviderCall` / `RefreshEndpointAccountCoverage` are: the WRITER
 * (lib/plaid/refresh-execution.ts), MIGRATIONS, operator-run SCRIPTS, the
 * PROJECTION authority, and this seam. Pinned by read-boundary.test.ts.
 *
 * PURE CORE + INJECTED I/O: every decision lives in execution-query-core.ts; the
 * db-backed readers below are replaced by fakes in tests.
 */

import "server-only";

import { db } from "@/lib/db";
import {
  clampLimit,
  decodeCursor,
  nextCursorFrom,
  projectCoverageRow,
  projectEndpointRow,
  projectExecutionRow,
  projectProviderCallRow,
  resolveScope,
  type ExecutionDetailDTO,
  type ExecutionPageDTO,
  type ExecutionRowDTO,
  type ExecutionScope,
  type SeamAudience,
} from "@/lib/platform/refresh/execution-query-core";
import type {
  CoverageFact,
  EndpointFact,
  ExecutionFact,
  ProviderCallFact,
} from "@/lib/platform/refresh/types";

// ── Arguments ───────────────────────────────────────────────────────────────────

export interface ExecutionQueryArgs {
  /** Derived from the caller's platform grant — NEVER from a request parameter. */
  audience: SeamAudience;
  scope?: ExecutionScope;
  /** Optional filters over the ledger's own vocabulary. */
  filter?: {
    overallStatus?: readonly string[];
    trigger?: readonly string[];
    /** PLATFORM OPS OBSERVABILITY — source kind ("PLAID_ITEM" | "WALLET") and network ("BTC", …). */
    sourceKind?: readonly string[];
    network?: readonly string[];
    /** One source's own id (a wallet's FinancialAccount.id, or a Plaid item id) — "this source's refreshes". */
    sourceRef?: string;
    /** ISO instant lower bound (inclusive) on `startedAt`. */
    since?: Date;
    /** ISO instant upper bound (inclusive) on `startedAt`. */
    until?: Date;
  };
  limit?: number;
  cursor?: string | null;
}

export interface ExecutionDetailArgs {
  audience: SeamAudience;
  scope?: ExecutionScope;
  executionId: string;
}

/** The ONLY I/O boundary. Real impls below; tests inject fakes. */
export interface ExecutionQueryReaders {
  executions(params: {
    plaidItemIds: readonly string[] | undefined;
    overallStatus: readonly string[] | undefined;
    trigger: readonly string[] | undefined;
    sourceKind: readonly string[] | undefined;
    network: readonly string[] | undefined;
    sourceRef: string | undefined;
    since: Date | undefined;
    until: Date | undefined;
    cursor: { startedAt: Date; id: string } | null;
    take: number;
  }): Promise<ExecutionFact[]>;
  execution(id: string): Promise<ExecutionFact | null>;
  /**
   * PLATFORM OPS OBSERVABILITY — the newest SUCCEEDED execution for one source
   * (the "last successful refresh" beside a failed one), or null when none is
   * recorded. Bounded: one indexed row.
   */
  lastSucceeded(source: { plaidItemId: string | null; sourceRef: string | null; before: Date; excludeId: string }): Promise<ExecutionFact | null>;
  endpoints(executionId: string): Promise<EndpointFact[]>;
  providerCalls(executionId: string): Promise<ProviderCallFact[]>;
  coverage(executionId: string): Promise<CoverageFact[]>;
}

export interface ExecutionQueryDeps {
  readers?: ExecutionQueryReaders;
}

// ── Real db-backed readers (explicit select allowlists — never a bare findMany) ──

const EXECUTION_SELECT = {
  id: true,
  runId: true,
  plaidItemId: true,
  trigger: true,
  profile: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  overallStatus: true,
  parentJobRunId: true,
  errorSummary: true,
  deploymentSha: true,
  admissionReason: true,
  sourceKind: true,
  sourceRef: true,
  network: true,
  failureStage: true,
  failureCategory: true,
  outcome: true,
} as const;

function realReaders(): ExecutionQueryReaders {
  return {
    async executions(params) {
      return db.refreshExecution.findMany({
        where: {
          ...(params.plaidItemIds ? { plaidItemId: { in: [...params.plaidItemIds] } } : {}),
          ...(params.overallStatus ? { overallStatus: { in: [...params.overallStatus] } } : {}),
          ...(params.trigger ? { trigger: { in: [...params.trigger] } } : {}),
          ...(params.sourceKind ? { sourceKind: { in: [...params.sourceKind] } } : {}),
          ...(params.network ? { network: { in: [...params.network] } } : {}),
          ...(params.sourceRef ? { OR: [{ sourceRef: params.sourceRef }, { plaidItemId: params.sourceRef }] } : {}),
          ...(params.since || params.until
            ? {
                startedAt: {
                  ...(params.since ? { gte: params.since } : {}),
                  ...(params.until ? { lte: params.until } : {}),
                },
              }
            : {}),
          // Keyset over (startedAt DESC, id DESC): strictly older, or same instant
          // with a strictly smaller id. Stable across inserts, unlike OFFSET.
          ...(params.cursor
            ? {
                OR: [
                  { startedAt: { lt: params.cursor.startedAt } },
                  { startedAt: params.cursor.startedAt, id: { lt: params.cursor.id } },
                ],
              }
            : {}),
        },
        select: EXECUTION_SELECT,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: params.take,
      });
    },
    async execution(id) {
      return db.refreshExecution.findUnique({ where: { id }, select: EXECUTION_SELECT });
    },
    async lastSucceeded(source) {
      if (!source.plaidItemId && !source.sourceRef) return null;
      return db.refreshExecution.findFirst({
        where: {
          overallStatus: "SUCCEEDED",
          startedAt: { lt: source.before },
          id: { not: source.excludeId },
          ...(source.plaidItemId ? { plaidItemId: source.plaidItemId } : { sourceRef: source.sourceRef }),
        },
        select: EXECUTION_SELECT,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      });
    },
    async endpoints(executionId) {
      return db.refreshEndpointResult.findMany({
        where: { refreshExecutionId: executionId },
        select: {
          refreshExecutionId: true, endpoint: true, stageKind: true, status: true,
          skipReason: true, startedAt: true, completedAt: true, durationMs: true,
          recordsRead: true, recordsWritten: true, recordsChanged: true,
          freshnessAdvanced: true, errorSummary: true,
        },
        orderBy: [{ startedAt: "asc" }],
      });
    },
    async providerCalls(executionId) {
      return db.providerCall.findMany({
        where: { refreshExecutionId: executionId },
        select: {
          refreshExecutionId: true, endpoint: true, provider: true, operation: true,
          status: true, attempt: true, startedAt: true, completedAt: true,
          durationMs: true, providerRequestId: true, httpStatus: true,
          errorCode: true, errorCategory: true,
        },
        orderBy: [{ startedAt: "asc" }],
      });
    },
    async coverage(executionId) {
      return db.refreshEndpointAccountCoverage.findMany({
        where: { refreshExecutionId: executionId },
        select: {
          refreshExecutionId: true, endpoint: true, financialAccountId: true,
          status: true, reason: true, freshnessAdvanced: true, createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }],
      });
    },
  };
}

function resolveReaders(deps?: ExecutionQueryDeps): ExecutionQueryReaders {
  return deps?.readers ?? realReaders();
}

/** An empty page, returned whenever scope resolution fails closed. */
function deniedPage(audience: SeamAudience): ExecutionPageDTO {
  return { rows: [], nextCursor: null, audience, scopeDenied: true };
}

// ── The seam ────────────────────────────────────────────────────────────────────

/**
 * A bounded, newest-first page of refresh executions.
 *
 * Reads `limit + 1` rows to learn whether a further page exists without a second
 * COUNT query — a count would be an aggregation, which this seam does not do.
 */
export async function queryRefreshExecutions(
  args: ExecutionQueryArgs,
  deps?: ExecutionQueryDeps,
): Promise<ExecutionPageDTO> {
  const scope = resolveScope(args.audience, args.scope);
  if (scope === null) return deniedPage(args.audience);

  const readers = resolveReaders(deps);
  const limit = clampLimit(args.limit);
  const decoded = decodeCursor(args.cursor);

  const rows = await readers.executions({
    plaidItemIds: scope.plaidItemIds,
    overallStatus: args.filter?.overallStatus,
    trigger: args.filter?.trigger,
    sourceKind: args.filter?.sourceKind,
    network: args.filter?.network,
    sourceRef: args.filter?.sourceRef,
    since: args.filter?.since,
    until: args.filter?.until,
    cursor: decoded ? { startedAt: new Date(decoded.startedAt), id: decoded.id } : null,
    take: limit + 1,
  });

  const hadMore = rows.length > limit;
  const page = rows.slice(0, limit).map((row) => projectExecutionRow(row, args.audience));

  return {
    rows: page,
    nextCursor: nextCursorFrom(page, limit, hadMore),
    audience: args.audience,
    scopeDenied: false,
  };
}

/**
 * One execution's full row-level detail: its stages, provider-call attempts and
 * per-account coverage.
 *
 * Scope is enforced AFTER the fetch as well as before: an execution outside the
 * caller's scope returns `null` (never a 404-vs-403 disclosure difference, and
 * never a partial row), mirroring the platform authorize adapter's never-404 rule.
 */
export async function getRefreshExecutionDetail(
  args: ExecutionDetailArgs,
  deps?: ExecutionQueryDeps,
): Promise<ExecutionDetailDTO | null> {
  const scope = resolveScope(args.audience, args.scope);
  if (scope === null) return null;

  const readers = resolveReaders(deps);
  const execution = await readers.execution(args.executionId);
  if (!execution) return null;

  // Scope re-check on the resolved row — a direct id lookup must never let a
  // scoped caller read outside its connections.
  if (scope.plaidItemIds && (execution.plaidItemId === null || !scope.plaidItemIds.includes(execution.plaidItemId))) return null;

  const [endpoints, providerCalls, coverage] = await Promise.all([
    readers.endpoints(execution.id),
    readers.providerCalls(execution.id),
    readers.coverage(execution.id),
  ]);

  return {
    execution: projectExecutionRow(execution, args.audience),
    endpoints: endpoints.map((row) => projectEndpointRow(row, args.audience)),
    providerCalls: providerCalls.map(projectProviderCallRow),
    coverage: coverage.map(projectCoverageRow),
    audience: args.audience,
  };
}

/**
 * Resolve a run correlator to a RefreshExecution.id, or null. (OPS-2D-5A-1)
 *
 * Lives at the row seam because it is a ledger read, and the two-seam doctrine
 * allows exactly two ways in. The incident lifecycle needs it to turn a
 * `runId` — which is sometimes a real correlator and sometimes a UUID
 * syncTransactionsForItem minted for itself — into a relation it can trust. It
 * is a LOOKUP: null means the correlator named no execution, which is the honest
 * and common answer, not a reason to fabricate a link.
 */
/**
 * PLATFORM OPS OBSERVABILITY — the operator's CONTEXT for one execution: the
 * source's last successful execution, so a failed run can be read beside the
 * last time the same source worked. Operator audience only (it is composed by
 * the platform detail route, never by a customer surface). Null when the
 * execution is unknown.
 */
export async function getExecutionContext(
  executionId: string,
  deps?: ExecutionQueryDeps,
): Promise<{ lastSucceeded: ExecutionRowDTO | null } | null> {
  const readers = resolveReaders(deps);
  const execution = await readers.execution(executionId);
  if (!execution) return null;
  // Strictly BEFORE this execution: "the last time this source worked before
  // this run", so a successful execution never reports itself as its own context.
  const last = await readers.lastSucceeded({
    plaidItemId: execution.plaidItemId, sourceRef: execution.sourceRef,
    before: execution.startedAt, excludeId: execution.id,
  });
  return { lastSucceeded: last ? projectExecutionRow(last, "operator") : null };
}

export async function getExecutionIdByRunId(runId: string): Promise<string | null> {
  try {
    const row = await db.refreshExecution.findUnique({ where: { runId }, select: { id: true } });
    return row?.id ?? null;
  } catch {
    return null;
  }
}
