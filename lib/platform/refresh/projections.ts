/**
 * lib/platform/refresh/projections.ts  (OPS-2B — the refresh projection authority)
 *
 * THE canonical aggregate read model over the DF-2 refresh ledger. It closes
 * DF-2F: four immutable authorities (RefreshExecution · RefreshEndpointResult ·
 * ProviderCall · RefreshEndpointAccountCoverage) that shipped with no reader now
 * have exactly one.
 *
 * PURE CORE + INJECTED I/O (the house pattern shared with history/convergence/
 * cost): the real db-backed readers are built here and replaced by in-memory
 * fakes in tests. Every reduction lives in projections-core.ts.
 *
 * ── THIS MODULE OWNS NO TRUTH ─────────────────────────────────────────────────
 * It re-derives nothing. `overallStatus` is READ (the writer's
 * `deriveOverallStatus` is its sole authority); `freshnessAdvanced` is READ (a
 * successful empty response still advances freshness — that is DF-2E's call, not
 * ours); provider error codes stay Plaid's own vocabulary. No health state is
 * computed, nothing is persisted, and — per the slice contract — NOTHING IS
 * CACHED.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────────
 * Each result carries `deterministic`, true iff BOTH the window is closed
 * (`to` strictly before today, UTC) AND no execution in it is still RUNNING.
 * The second condition is derived from the facts: a past window still holding an
 * open execution is not reproducible, because that row will be closed later.
 * `checkedAt` is added here, never by the core, so "same facts ⇒ identical bytes"
 * stays provable at the core boundary.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────────
 * These are PLATFORM-GRAIN projections. Authorization stays at the route
 * boundary (`requirePlatformAccess`), exactly as every other platform read
 * model. An optional `plaidItemIds` scope narrows a projection to specific
 * connections for support work; an EMPTY array fails closed to an empty window
 * rather than silently widening to everything.
 */

import "server-only";
import { todayUTCISO } from "@/lib/time/clock";
import { deriveIngestionActivity, deriveIngestionDeferral, type IngestionActivity, type IngestionDeferral } from "@/lib/sync/deferred-ingestion";
import { importExecutionFact, type ImportEvidence, type ImportExecutionFact } from "@/lib/platform/onboarding/import-status-core";

// ⚠️ RLS-P-3a — fm_system, NOT the migration principal. Every `db.` in this file
// read one of the four DF-2 refresh tables and NOTHING else, all four of which
// fm_app is revoked from outright (…_rls_roles_and_policies §4). On the
// migration principal these reads were exempt from every policy by accident of
// which client the module happened to import; on fm_system they are exempt by a
// role-scoped policy that is visible in pg_policies and reviewable in source
// control. The REACH is identical — fm_system's policy on this family is
// USING(true) — so no projection changes, and that is the point: this is the
// authority becoming explicit, not widening.
import { systemDb } from "@/lib/db";
import {
  buildCoverageSummary,
  buildExecutionTimeline,
  buildProviderOperationSummary,
  buildRefreshDailySeries,
  buildRefreshSummary,
  countOpenExecutions,
  buildPipelineStatus,
  utcDaysBetween,
} from "@/lib/platform/refresh/projections-core";
import type {
  CoverageFact,
  CoverageSummary,
  EndpointFact,
  ExecutionFact,
  ExecutionTimeline,
  ProjectionEnvelope,
  ProviderCallFact,
  ProviderOperationSummary,
  RefreshDailySeries,
  RefreshSummary,
  PipelineStatus,
} from "@/lib/platform/refresh/types";

const DEFAULT_WINDOW_DAYS = 14;
/** Bounds one projection read. Operational windows are small; this is a tripwire. */
export const MAX_FACT_ROWS = 20_000;
/** UX-P1 · D8 — the day series never projects more than this many UTC days. */
export const DAILY_SERIES_MAX_WINDOW_DAYS = 30;

// ── Arguments + injected reads ──────────────────────────────────────────────────

export interface RefreshProjectionArgs {
  /** Window end (YYYY-MM-DD, UTC). Defaults to today. */
  to?: string;
  /** Window start (YYYY-MM-DD, UTC). Defaults to `to` − 14d. */
  from?: string;
  /**
   * Narrow to specific connections. `undefined` = platform-wide.
   * An EMPTY array is honoured as "nothing in scope" (fails closed).
   */
  plaidItemIds?: readonly string[];
}

/** The ONLY I/O boundary. Real impls below; tests inject fakes. */
export interface RefreshProjectionReaders {
  now: Date;
  executions(from: Date, to: Date, plaidItemIds?: readonly string[]): Promise<ExecutionFact[]>;
  endpoints(executionIds: readonly string[]): Promise<EndpointFact[]>;
  providerCalls(executionIds: readonly string[]): Promise<ProviderCallFact[]>;
  coverage(executionIds: readonly string[]): Promise<CoverageFact[]>;
  /** One execution by id, or null. Used by the timeline projection. */
  execution(id: string): Promise<ExecutionFact | null>;
  /**
   * PLATFORM OPS OBSERVABILITY — the newest SUCCEEDED execution of one source
   * kind, ANY window (one indexed row). The pipeline status reads it beside the
   * window so a quiet day still shows when each kind last worked.
   */
  lastSucceededByKind(kind: string): Promise<ExecutionFact | null>;
}

export interface RefreshProjectionDeps {
  readers?: RefreshProjectionReaders;
}

// ── Window + envelope ───────────────────────────────────────────────────────────

// REVIEW-3 B-6 — the day formatter is THE clock seam's (lib/time/clock.ts).
const todayISO = (now: Date): string => todayUTCISO(now);
function minusDaysISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00.000Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function startOfDay(dateISO: string): Date {
  return new Date(`${dateISO}T00:00:00.000Z`);
}
function endOfDay(dateISO: string): Date {
  return new Date(`${dateISO}T23:59:59.999Z`);
}

function resolveWindow(args: RefreshProjectionArgs, now: Date): { from: string; to: string } {
  const to = args.to ?? todayISO(now);
  const from = args.from ?? minusDaysISO(to, DEFAULT_WINDOW_DAYS);
  return { from, to };
}

/**
 * Build the trust/determinism envelope. `openExecutions` comes from the facts —
 * a closed date range containing a RUNNING execution is NOT deterministic.
 */
function envelope(
  window: { from: string; to: string },
  now: Date,
  openExecutions: number,
): ProjectionEnvelope {
  const windowClosed = window.to < todayISO(now);
  const deterministic = windowClosed && openExecutions === 0;

  let indeterminacyReason: string | null = null;
  if (!windowClosed && openExecutions > 0) {
    indeterminacyReason = `window is open (ends ${window.to}) and ${openExecutions} execution(s) are still RUNNING`;
  } else if (!windowClosed) {
    indeterminacyReason = `window is open — it ends ${window.to}, which is not before today`;
  } else if (openExecutions > 0) {
    indeterminacyReason = `${openExecutions} execution(s) in this closed window are still RUNNING and will be finalized later`;
  }

  return { window, deterministic, indeterminacyReason, checkedAt: now.toISOString() };
}

// ── Real db-backed readers (the ONLY I/O; a fake replaces this in tests) ─────────

/**
 * Explicit `select` allowlists everywhere — never a bare `findMany`. The ledger
 * carries no secrets today, but an allowlist is what keeps that true when a
 * column is added later.
 */
function realReaders(now: Date): RefreshProjectionReaders {
  return {
    now,
    async executions(from, to, plaidItemIds) {
      return systemDb.refreshExecution.findMany({
        where: {
          startedAt: { gte: from, lte: to },
          ...(plaidItemIds ? { plaidItemId: { in: [...plaidItemIds] } } : {}),
        },
        select: {
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
        },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: MAX_FACT_ROWS,
      });
    },
    async endpoints(executionIds) {
      if (executionIds.length === 0) return [];
      return systemDb.refreshEndpointResult.findMany({
        where: { refreshExecutionId: { in: [...executionIds] } },
        select: {
          refreshExecutionId: true,
          endpoint: true,
          stageKind: true,
          status: true,
          skipReason: true,
          startedAt: true,
          completedAt: true,
          durationMs: true,
          recordsRead: true,
          recordsWritten: true,
          recordsChanged: true,
          freshnessAdvanced: true,
          errorSummary: true,
        },
        orderBy: [{ startedAt: "asc" }],
        take: MAX_FACT_ROWS,
      });
    },
    async providerCalls(executionIds) {
      if (executionIds.length === 0) return [];
      return systemDb.providerCall.findMany({
        where: { refreshExecutionId: { in: [...executionIds] } },
        select: {
          refreshExecutionId: true,
          endpoint: true,
          provider: true,
          operation: true,
          status: true,
          attempt: true,
          startedAt: true,
          completedAt: true,
          durationMs: true,
          providerRequestId: true,
          httpStatus: true,
          errorCode: true,
          errorCategory: true,
        },
        orderBy: [{ startedAt: "asc" }],
        take: MAX_FACT_ROWS,
      });
    },
    async coverage(executionIds) {
      if (executionIds.length === 0) return [];
      return systemDb.refreshEndpointAccountCoverage.findMany({
        where: { refreshExecutionId: { in: [...executionIds] } },
        select: {
          refreshExecutionId: true,
          endpoint: true,
          financialAccountId: true,
          status: true,
          reason: true,
          freshnessAdvanced: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }],
        take: MAX_FACT_ROWS,
      });
    },
    async lastSucceededByKind(kind) {
      return systemDb.refreshExecution.findFirst({
        where: { sourceKind: kind, overallStatus: "SUCCEEDED" },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: EXECUTION_FACT_SELECT,
      });
    },
    async execution(id) {
      return systemDb.refreshExecution.findUnique({
        where: { id },
        select: {
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
        },
      });
    },
  };
}

function resolveReaders(deps?: RefreshProjectionDeps): RefreshProjectionReaders {
  return deps?.readers ?? realReaders(new Date());
}

/** The execution select shared by the two single-row readers below. */
const EXECUTION_FACT_SELECT = {
  id: true, runId: true, plaidItemId: true, trigger: true, profile: true,
  startedAt: true, completedAt: true, durationMs: true, overallStatus: true,
  parentJobRunId: true, errorSummary: true, deploymentSha: true, admissionReason: true,
  sourceKind: true, sourceRef: true, network: true, failureStage: true,
  failureCategory: true, outcome: true,
} as const;

/** True when the caller explicitly scoped to nothing — fail closed, never widen. */
function scopedToNothing(args: RefreshProjectionArgs): boolean {
  return args.plaidItemIds != null && args.plaidItemIds.length === 0;
}

/**
 * The loaded fact window every projection starts from.
 *
 * ONE OWNERSHIP POINT (OPS-2B′ Part VII). Window resolution, scope enforcement
 * and the execution read live here exactly once. Before this existed, three
 * projections counted open executions inline as
 * `overallStatus === "RUNNING"` while `buildRefreshSummary` used
 * `countOpenExecutions` (which ALSO treats a null `completedAt` as open) — so an
 * execution with a completion write that never landed was "open" in Refresh
 * Summary and "closed" in the other three, and the SAME window could report two
 * different `deterministic` verdicts. One rule, one place.
 */
interface FactWindow {
  readers: RefreshProjectionReaders;
  window: { from: string; to: string };
  executions: ExecutionFact[];
  /** The window's execution ids — the join key for every child fact read. */
  ids: string[];
}

async function loadExecutionWindow(
  args: RefreshProjectionArgs,
  deps: RefreshProjectionDeps | undefined,
): Promise<FactWindow> {
  const readers = resolveReaders(deps);
  const window = resolveWindow(args, readers.now);

  // Fails closed: an explicitly empty scope reads nothing and never widens.
  if (scopedToNothing(args)) return { readers, window, executions: [], ids: [] };

  const executions = await readers.executions(
    startOfDay(window.from),
    endOfDay(window.to),
    args.plaidItemIds,
  );
  return { readers, window, executions, ids: executions.map((e) => e.id) };
}

/**
 * Child-fact reads, guarded in ONE place.
 *
 * No executions ⇒ no child facts, without consulting a reader at all. The guard
 * lives here rather than inside each reader so the guarantee holds for ANY
 * reader implementation (a test fake included) instead of depending on each one
 * to short-circuit an empty id list.
 */
const endpointsOf = (w: FactWindow): Promise<EndpointFact[]> =>
  w.ids.length ? w.readers.endpoints(w.ids) : Promise.resolve([]);
const providerCallsOf = (w: FactWindow): Promise<ProviderCallFact[]> =>
  w.ids.length ? w.readers.providerCalls(w.ids) : Promise.resolve([]);
const coverageOf = (w: FactWindow): Promise<CoverageFact[]> =>
  w.ids.length ? w.readers.coverage(w.ids) : Promise.resolve([]);

/** THE determinism verdict — one rule, derived from the facts, for every projection. */
function envelopeFor(loaded: FactWindow): ProjectionEnvelope {
  return envelope(loaded.window, loaded.readers.now, countOpenExecutions(loaded.executions));
}

// ── The projections ─────────────────────────────────────────────────────────────

/**
 * Refresh Summary — execution outcomes, durations, and the per-endpoint stage
 * roll-up over a window. The endpoint roll-up is an OUTPUT of this projection,
 * not a separate authority.
 */
export async function getRefreshSummary(
  args: RefreshProjectionArgs = {},
  deps?: RefreshProjectionDeps,
): Promise<RefreshSummary> {
  const loaded = await loadExecutionWindow(args, deps);
  const endpoints = await endpointsOf(loaded);
  return { ...buildRefreshSummary(loaded.executions, endpoints), ...envelopeFor(loaded) };
}

/**
 * Provider Operation Summary — per (provider, operation) attempt facts, latency
 * and the attempt distribution. Deliberately publishes NO retry rate: retries and
 * pagination are confounded at the Proxy chokepoint.
 */
export async function getProviderOperationSummary(
  args: RefreshProjectionArgs = {},
  deps?: RefreshProjectionDeps,
): Promise<ProviderOperationSummary> {
  const loaded = await loadExecutionWindow(args, deps);
  const calls = await providerCallsOf(loaded);
  return { ...buildProviderOperationSummary(calls), ...envelopeFor(loaded) };
}

/**
 * Coverage Summary — per-endpoint and per-(account, endpoint) coverage evidence.
 *
 * Reports FACTS only: covered / skipped / failed counts, the DF-2E reason
 * vocabulary, and when each account was last covered or last had its freshness
 * advanced. It does NOT decide staleness — that verdict needs a per-endpoint
 * cadence authority which does not exist yet (see projections-core's header).
 */
export async function getCoverageSummary(
  args: RefreshProjectionArgs = {},
  deps?: RefreshProjectionDeps,
): Promise<CoverageSummary> {
  const loaded = await loadExecutionWindow(args, deps);
  const coverage = await coverageOf(loaded);
  return { ...buildCoverageSummary(coverage), ...envelopeFor(loaded) };
}


/**
 * Execution Timeline — ONE execution's ordered story (stages, provider calls,
 * account coverage). Timeline DTOs only; no health, no verdict.
 *
 * Returns null when the execution does not exist — never a fabricated shell.
 */
/**
 * PLATFORM OPS OBSERVABILITY — Pipeline Status: what the data pipeline did in
 * the window, by source kind and network, plus the last successful execution
 * per kind. Read by the operations overview. Same window loader, same
 * envelope, same determinism rule as every other projection.
 */
export const PIPELINE_SOURCE_KINDS: readonly string[] = ["PLAID_ITEM", "WALLET"];

export async function getPipelineStatus(
  args: RefreshProjectionArgs = {},
  deps?: RefreshProjectionDeps,
): Promise<PipelineStatus> {
  const loaded = await loadExecutionWindow(args, deps);
  const lastByKind: Record<string, ExecutionFact | null> = {};
  await Promise.all(PIPELINE_SOURCE_KINDS.map(async (kind) => {
    lastByKind[kind] = await loaded.readers.lastSucceededByKind(kind);
  }));
  return { ...envelopeFor(loaded), ...buildPipelineStatus(loaded.executions, lastByKind) };
}

/**
 * UX-P1 · D8 — Refresh Daily Series: executions per UTC day of `startedAt`,
 * by status and source kind, with the admission-denied count, over a window of
 * at most DAILY_SERIES_MAX_WINDOW_DAYS (default: the shared projection window).
 *
 * Same window loader, same fail-closed scope, same envelope rule as every
 * other projection — plus the ONE rule the others leave implicit: the reader
 * loads at most MAX_FACT_ROWS rows, newest first. When that cap is reached the
 * series is a FLOOR (older days are missing, the oldest loaded day is partial),
 * so the envelope reports `deterministic: false` with the cap as its reason.
 *
 * A window wider than the ceiling is clamped at its OLD end (the newest days
 * are the operational ones) and the clamp is stated in `notes` rather than
 * silently applied or refused.
 */
export async function getRefreshDailySeries(
  args: RefreshProjectionArgs = {},
  deps?: RefreshProjectionDeps,
): Promise<RefreshDailySeries> {
  const readers = resolveReaders(deps);
  const requested = resolveWindow(args, readers.now);
  const notes: string[] = [];

  let from = requested.from;
  if (from > requested.to) {
    from = requested.to;
    notes.push(`window start ${requested.from} is after its end ${requested.to}; projected the single day ${requested.to}`);
  }
  if (utcDaysBetween(from, requested.to).length > DAILY_SERIES_MAX_WINDOW_DAYS) {
    from = minusDaysISO(requested.to, DAILY_SERIES_MAX_WINDOW_DAYS - 1);
    notes.push(`window clamped to ${DAILY_SERIES_MAX_WINDOW_DAYS} days (requested from ${requested.from})`);
  }

  const loaded = await loadExecutionWindow({ ...args, from, to: requested.to }, deps);
  const capHit = loaded.executions.length >= MAX_FACT_ROWS;
  const today = todayISO(loaded.readers.now);
  const core = buildRefreshDailySeries(loaded.executions, loaded.window, { todayISO: today, capHit });

  const base = envelopeFor(loaded);
  const env: ProjectionEnvelope = capHit
    ? {
        ...base,
        deterministic: false,
        indeterminacyReason:
          `fact cap of ${MAX_FACT_ROWS} rows reached — older days are missing and every count is a floor` +
          (base.indeterminacyReason ? `; ${base.indeterminacyReason}` : ""),
      }
    : base;

  notes.push(
    "Buckets are UTC days of each execution's startedAt.",
    "A settled day with no rows is a true zero: the ledger is the authority and holds no execution for that day.",
    "Executions refused by the admission authority are ledgered as SKIPPED with a typed reason and counted in admissionDenied.",
    "Customer-facing cooldown refusals (HTTP 429) write no execution row and cannot appear in this series.",
  );

  return {
    envelope: env,
    days: core.days,
    windowDays: core.days.length,
    maxWindowDays: DAILY_SERIES_MAX_WINDOW_DAYS,
    executions: core.executions,
    floor: core.floor,
    notes,
    tier: core.tier,
  };
}

export async function getExecutionTimeline(
  executionId: string,
  deps?: RefreshProjectionDeps,
): Promise<ExecutionTimeline | null> {
  const readers = resolveReaders(deps);
  const execution = await readers.execution(executionId);
  if (!execution) return null;

  const [endpoints, calls, coverage] = await Promise.all([
    readers.endpoints([execution.id]),
    readers.providerCalls([execution.id]),
    readers.coverage([execution.id]),
  ]);

  const built = buildExecutionTimeline(execution, endpoints, calls, coverage);
  return {
    executionId: execution.id,
    runId: execution.runId,
    complete: built.complete,
    entries: built.entries,
    tier: built.tier,
  };
}

// ── Ingestion deferral (OPS-2D-4A follow-up) ─────────────────────────────────

/**
 * "Which of these connections are currently held by platform policy?"
 *
 * A projection, and therefore here. This was first written in lib/sync/ beside
 * its pure rule, which read the ledger directly — a third path. The read-boundary
 * ratchet caught it, and the fix was to move the read to the aggregate seam
 * rather than widen the allowlist: an allowlist entry is a doctrine decision,
 * and the doctrine already had a home for this.
 *
 * The RULE stays pure in lib/sync/deferred-ingestion.ts (`deriveIngestionDeferral`);
 * this contributes only the read — the same split every projection here uses.
 *
 * ONE query, newest-first, first row per item: "most recent execution" is the
 * whole contract, and a per-item query would be N round-trips for a page that
 * renders every connection at once. Only deferred items get an entry, so a
 * missing key means "not deferred" and callers never distinguish absent from null.
 */
export async function getIngestionDeferrals(
  items: { id: string; syncLockedAt: Date | null }[],
): Promise<Map<string, IngestionDeferral>> {
  return (await getIngestionEvidence(items, new Date())).deferrals;
}

/**
 * The same ONE newest-first read, answering both questions the Connections
 * surface asks of the ledger: is this item held by policy (deferrals — only
 * deferred items get an entry), and is anything actually running for it
 * (activity — every item gets an entry). Both rules stay pure in
 * lib/sync/deferred-ingestion.ts.
 */
export async function getIngestionEvidence(
  items: { id: string; syncLockedAt: Date | null }[],
  now: Date,
): Promise<{ deferrals: Map<string, IngestionDeferral>; activity: Map<string, IngestionActivity> }> {
  const deferrals = new Map<string, IngestionDeferral>();
  const activity  = new Map<string, IngestionActivity>();
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return { deferrals, activity };

  const rows = await systemDb.refreshExecution.findMany({
    where:   { plaidItemId: { in: ids } },
    orderBy: { startedAt: "desc" },
    select:  { plaidItemId: true, overallStatus: true, admissionReason: true, startedAt: true },
  });

  const latest = new Map<string, { overallStatus: string; admissionReason: string | null; startedAt: Date }>();
  for (const r of rows) {
    if (r.plaidItemId !== null && !latest.has(r.plaidItemId)) {
      latest.set(r.plaidItemId, { overallStatus: r.overallStatus, admissionReason: r.admissionReason, startedAt: r.startedAt });
    }
  }

  for (const item of items) {
    const latestExecution = latest.get(item.id) ?? null;
    const d = deriveIngestionDeferral({ syncLockedAt: item.syncLockedAt, latestExecution });
    if (d !== null) deferrals.set(item.id, d);
    activity.set(item.id, deriveIngestionActivity({ syncLockedAt: item.syncLockedAt, latestExecution }, now));
  }
  return { deferrals, activity };
}

// ── PB-7 — onboarding import evidence ────────────────────────────────────────

/** Bound on the rows one evidence read loads (a window holds a handful of executions per item). */
const IMPORT_EVIDENCE_MAX_ROWS = 5_000;

/**
 * PB-7 — the evidence behind "how did this connection's first import go?"
 * (lib/platform/onboarding/import-status-core.ts): each item's RefreshExecution
 * rows in its first `windowMs` after linking, and when its wealth history was
 * first rebuilt (the first SUCCEEDED REGENERATION stage). Per-item, like
 * getIngestionEvidence: it carries NO owner — the caller (Customer Success, or
 * the identity-free Platform Ops tile) decides who the items belong to.
 *
 * Statuses, triggers, timestamps and a failure CATEGORY only; errorSummary is
 * read solely to recognise a reaped row and is never returned.
 */
export async function getImportEvidence(
  items: readonly { id: string; createdAt: Date }[],
  windowMs: number,
): Promise<{ evidence: Map<string, ImportEvidence>; floor: boolean }> {
  const evidence = new Map<string, ImportEvidence>();
  if (items.length === 0) return { evidence, floor: false };

  const rows = await systemDb.refreshExecution.findMany({
    where: {
      OR: items.map((i) => ({
        plaidItemId: i.id,
        startedAt: { gte: new Date(i.createdAt.getTime() - 60_000), lte: new Date(i.createdAt.getTime() + windowMs) },
      })),
    },
    select: {
      id: true, plaidItemId: true, trigger: true, profile: true, startedAt: true, completedAt: true,
      overallStatus: true, failureCategory: true, errorSummary: true,
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take: IMPORT_EVIDENCE_MAX_ROWS,
  });
  const regen = rows.length === 0 ? [] : await systemDb.refreshEndpointResult.findMany({
    where: { refreshExecutionId: { in: rows.map((r) => r.id) }, endpoint: "REGENERATION", status: "SUCCEEDED" },
    select: { refreshExecutionId: true, startedAt: true, completedAt: true },
    take: IMPORT_EVIDENCE_MAX_ROWS,
  });

  const itemOf = new Map(rows.map((r) => [r.id, r.plaidItemId] as const));
  const firstRegen = new Map<string, Date>();
  for (const s of regen) {
    const item = itemOf.get(s.refreshExecutionId);
    const at = s.completedAt ?? s.startedAt;
    if (!item) continue;
    const cur = firstRegen.get(item);
    if (!cur || at < cur) firstRegen.set(item, at);
  }
  const byItem = new Map<string, ImportExecutionFact[]>();
  for (const r of rows) {
    if (!r.plaidItemId) continue;
    byItem.set(r.plaidItemId, [...(byItem.get(r.plaidItemId) ?? []), importExecutionFact(r)]);
  }
  for (const i of items) {
    evidence.set(i.id, { executions: byItem.get(i.id) ?? [], firstWealthRegenAt: firstRegen.get(i.id) ?? null });
  }
  return { evidence, floor: rows.length >= IMPORT_EVIDENCE_MAX_ROWS };
}
