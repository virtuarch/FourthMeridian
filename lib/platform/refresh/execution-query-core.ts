/**
 * lib/platform/refresh/execution-query-core.ts  (OPS-2B — Execution Query Seam)
 *
 * The PURE half of the canonical row-level seam — the operational counterpart of
 * lib/data/transaction-query-core.ts. Cursor encoding, limit clamping, ordering,
 * DTO projection and audience redaction. No Prisma, no clock, no I/O.
 *
 * ── WHAT A SEAM IS (and is not) ───────────────────────────────────────────────
 * A seam is NOT a bypass. Exactly as `queryTransactions` composes
 * `bankingTransactionWhere` (population + visibility) rather than letting callers
 * re-decide them, this seam composes SCOPE, REDACTION and the DTO allowlist
 * rather than handing back ledger rows. It performs NO aggregation, computes NO
 * health, and derives NO projection — a caller wanting a total or a verdict is a
 * PROJECTION caller (projections.ts), not a seam caller.
 *
 * ── REDACTION: THE ALLOWLIST IS THE GUARANTEE ─────────────────────────────────
 * Every DTO is built field-by-field from an explicit allowlist. Rows are NEVER
 * spread (`...row`), so a column added to the ledger later cannot silently reach
 * a consumer. This is the structural guarantee; the audience rule below is the
 * semantic one.
 *
 * ── AUDIENCE ──────────────────────────────────────────────────────────────────
 *   "operator" — Platform Operations. Unscoped reads permitted. Sees the
 *                truncated free-text `errorSummary`.
 *   "support"  — Customer Success working ONE customer's connection. Scope is
 *                REQUIRED (an unscoped support read fails closed to an empty
 *                page — it never widens to the platform). Free-text
 *                `errorSummary` is REPLACED by `hasError` plus the structured
 *                provider codes.
 *
 * The support rule is not invented: it is the same discipline
 * lib/platform/sync-issue-semantics.ts already applies to `SyncIssue.detail` —
 * *"`detail` (the Json blob) is NEVER interpolated — only the derived
 * severity/domain/stage vocabulary, which carries no customer data"*. A free-text
 * internal error string is not a controlled vocabulary and can carry internal
 * detail; Plaid's `errorCode`/`errorCategory` are, and are safe to relay.
 *
 * There is deliberately NO "customer" audience. Customer Diagnostics consumes
 * PROJECTIONS ONLY (OPERATIONAL_TRUTH_SPINE.md §G.1) — the seam returns
 * operator-grain fields (`providerRequestId`, `httpStatus`, provider error codes)
 * that are support artifacts, not customer information. Pinned by a test.
 */

// ── Audience + scope ────────────────────────────────────────────────────────────

/** The audiences this seam serves. `customer` is deliberately absent — see header. */
export const SEAM_AUDIENCES = ["operator", "support"] as const;
export type SeamAudience = (typeof SEAM_AUDIENCES)[number];

/** Audiences that must name their connections. Support never reads platform-wide. */
export const SCOPE_REQUIRED_AUDIENCES: readonly SeamAudience[] = ["support"];

export interface ExecutionScope {
  /** Connections in scope. Required for `support`; optional for `operator`. */
  plaidItemIds?: readonly string[];
}

/**
 * Decide the effective scope, failing CLOSED.
 *
 * Returns `null` when the read must yield nothing — an unscoped support read, or
 * an explicitly empty id list. `undefined` means "platform-wide" and is reachable
 * only by `operator`.
 */
export function resolveScope(
  audience: SeamAudience,
  scope: ExecutionScope | undefined,
): { plaidItemIds: readonly string[] | undefined } | null {
  const ids = scope?.plaidItemIds;

  if (SCOPE_REQUIRED_AUDIENCES.includes(audience)) {
    // Fails closed: no ids, or an empty list, yields nothing — never everything.
    if (ids == null || ids.length === 0) return null;
    return { plaidItemIds: ids };
  }

  if (ids != null && ids.length === 0) return null;
  return { plaidItemIds: ids };
}

// ── Paging ──────────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/**
 * Keyset cursor over `(startedAt DESC, id DESC)` — the ledger's own newest-first
 * order. Opaque to callers; a malformed cursor resolves to `null` (start from the
 * top) rather than throwing, so a stale link degrades instead of erroring.
 */
export interface ExecutionCursor {
  startedAt: string;
  id: string;
}

export function encodeCursor(cursor: ExecutionCursor): string {
  return Buffer.from(`${cursor.startedAt}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): ExecutionCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const separator = decoded.indexOf("|");
    if (separator <= 0) return null;
    const startedAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!startedAt || !id || Number.isNaN(Date.parse(startedAt))) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}

// ── DTOs (explicit allowlists — never a row spread) ─────────────────────────────

export interface ExecutionRowDTO {
  id: string;
  runId: string;
  plaidItemId: string;
  trigger: string;
  profile: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  overallStatus: string;
  parentJobRunId: string | null;
  /** True when the execution recorded an error. Present for EVERY audience. */
  hasError: boolean;
  /** OPS-2C-4 — the deployment that produced this execution; null when unobserved. */
  deploymentSha: string | null;
  /** Truncated free text. `null` for `support` — see the header's redaction rule. */
  errorSummary: string | null;
}

export interface EndpointRowDTO {
  endpoint: string;
  stageKind: string;
  status: string;
  skipReason: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  recordsRead: number | null;
  recordsWritten: number | null;
  recordsChanged: number | null;
  freshnessAdvanced: boolean | null;
  hasError: boolean;
  errorSummary: string | null;
}

export interface ProviderCallRowDTO {
  endpoint: string | null;
  provider: string;
  operation: string;
  status: string;
  attempt: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  providerRequestId: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorCategory: string | null;
}

export interface CoverageRowDTO {
  endpoint: string;
  financialAccountId: string;
  status: string;
  reason: string | null;
  freshnessAdvanced: boolean;
  createdAt: string;
}

export interface ExecutionPageDTO {
  rows: readonly ExecutionRowDTO[];
  /** Opaque continuation cursor, or null when the page is the last one. */
  nextCursor: string | null;
  audience: SeamAudience;
  /** True when scope resolution failed closed and the page is empty by policy. */
  scopeDenied: boolean;
}

export interface ExecutionDetailDTO {
  execution: ExecutionRowDTO;
  endpoints: readonly EndpointRowDTO[];
  providerCalls: readonly ProviderCallRowDTO[];
  coverage: readonly CoverageRowDTO[];
  audience: SeamAudience;
}

/** The exact DTO key sets — pinned by a test so a field can never leak in silently. */
export const EXECUTION_ROW_KEYS: readonly string[] = [
  "id", "runId", "plaidItemId", "trigger", "profile", "startedAt", "completedAt",
  "durationMs", "overallStatus", "parentJobRunId", "hasError", "errorSummary",
  "deploymentSha",
];
export const ENDPOINT_ROW_KEYS: readonly string[] = [
  "endpoint", "stageKind", "status", "skipReason", "startedAt", "completedAt",
  "durationMs", "recordsRead", "recordsWritten", "recordsChanged",
  "freshnessAdvanced", "hasError", "errorSummary",
];
export const PROVIDER_CALL_ROW_KEYS: readonly string[] = [
  "endpoint", "provider", "operation", "status", "attempt", "startedAt",
  "completedAt", "durationMs", "providerRequestId", "httpStatus", "errorCode", "errorCategory",
];
export const COVERAGE_ROW_KEYS: readonly string[] = [
  "endpoint", "financialAccountId", "status", "reason", "freshnessAdvanced", "createdAt",
];

// ── Redaction + projection ──────────────────────────────────────────────────────

/** Free text reaches `operator` only. Every other audience gets the boolean. */
function redactText(audience: SeamAudience, text: string | null): string | null {
  return audience === "operator" ? text : null;
}

export function projectExecutionRow(
  row: {
    id: string; runId: string; plaidItemId: string; trigger: string; profile: string;
    startedAt: Date; completedAt: Date | null; durationMs: number | null;
    overallStatus: string; parentJobRunId: string | null; errorSummary: string | null;
    deploymentSha: string | null;
  },
  audience: SeamAudience,
): ExecutionRowDTO {
  return {
    id: row.id,
    runId: row.runId,
    plaidItemId: row.plaidItemId,
    trigger: row.trigger,
    profile: row.profile,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    durationMs: row.durationMs,
    overallStatus: row.overallStatus,
    parentJobRunId: row.parentJobRunId,
    hasError: row.errorSummary != null,
    errorSummary: redactText(audience, row.errorSummary),
    // Evidence carried on the execution. Both audiences see it: a commit sha is
    // not customer data and is already public as the Sentry release.
    deploymentSha: row.deploymentSha,
  };
}

export function projectEndpointRow(
  row: {
    endpoint: string; stageKind: string; status: string; skipReason: string | null;
    startedAt: Date; completedAt: Date | null; durationMs: number | null;
    recordsRead: number | null; recordsWritten: number | null; recordsChanged: number | null;
    freshnessAdvanced: boolean | null; errorSummary: string | null;
  },
  audience: SeamAudience,
): EndpointRowDTO {
  return {
    endpoint: row.endpoint,
    stageKind: row.stageKind,
    status: row.status,
    skipReason: row.skipReason,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    durationMs: row.durationMs,
    recordsRead: row.recordsRead,
    recordsWritten: row.recordsWritten,
    recordsChanged: row.recordsChanged,
    freshnessAdvanced: row.freshnessAdvanced,
    hasError: row.errorSummary != null,
    errorSummary: redactText(audience, row.errorSummary),
  };
}

/**
 * Provider-call rows carry no free text — `errorCode`/`errorCategory` are Plaid's
 * OWN controlled vocabulary and `providerRequestId` is the documented support /
 * incident lookup handle. Both audiences receive them unchanged.
 */
export function projectProviderCallRow(row: {
  endpoint: string | null; provider: string; operation: string; status: string;
  attempt: number; startedAt: Date; completedAt: Date; durationMs: number;
  providerRequestId: string | null; httpStatus: number | null;
  errorCode: string | null; errorCategory: string | null;
}): ProviderCallRowDTO {
  return {
    endpoint: row.endpoint,
    provider: row.provider,
    operation: row.operation,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    durationMs: row.durationMs,
    providerRequestId: row.providerRequestId,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    errorCategory: row.errorCategory,
  };
}

export function projectCoverageRow(row: {
  endpoint: string; financialAccountId: string; status: string;
  reason: string | null; freshnessAdvanced: boolean; createdAt: Date;
}): CoverageRowDTO {
  return {
    endpoint: row.endpoint,
    financialAccountId: row.financialAccountId,
    status: row.status,
    reason: row.reason,
    freshnessAdvanced: row.freshnessAdvanced,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Build the continuation cursor from a page. Returns null when the page did not
 * fill (no further rows) — the caller reads `limit + 1` rows to know.
 */
export function nextCursorFrom(
  rows: readonly ExecutionRowDTO[],
  limit: number,
  hadMore: boolean,
): string | null {
  if (!hadMore || rows.length === 0) return null;
  const last = rows[Math.min(rows.length, limit) - 1];
  return encodeCursor({ startedAt: last.startedAt, id: last.id });
}
