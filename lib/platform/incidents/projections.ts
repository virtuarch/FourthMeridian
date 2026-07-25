/**
 * lib/platform/incidents/projections.ts  (OPS-2D-5A-1)
 *
 * Active / historical / detail read models for sync incidents.
 *
 * COMBINES, NEVER DUPLICATES. The persisted lifecycle facts live on the row;
 * domain, severity, nature and the active/recovered/evidence/superseded/orphaned
 * state come from `lib/platform/sync-issue-semantics.ts`, which has been the
 * shipped authority since PRE-V26-PLAID-CLOSE Phase 4. This module calls it —
 * it does not re-derive a single field, because a second classifier is exactly
 * what that authority exists to prevent.
 *
 * The split it rests on: `resolved`/`resolvedAt` are FACTS about the episode;
 * "is this active?" is a JUDGEMENT that also weighs nature and whether the
 * subject still exists. An orphaned row is unresolved and still not active.
 */

import "server-only";
import { db } from "@/lib/db";
import {
  classifySyncIssue,
  syncIssueState,
  type SyncIssueState,
  type SyncIssueClassification,
} from "@/lib/platform/sync-issue-semantics";

export interface IncidentOccurrenceView {
  id: string;
  observedAt: string;
  /** The execution FK — present only when the correlator named a real run. */
  refreshExecutionId: string | null;
  /** Diagnostic correlator as the producer knew it. Never the relationship. */
  runId: string | null;
  /**
   * True when this occurrence has no execution relation. Rendered honestly
   * rather than hidden: several producers have no envelope at all, and that gap
   * is the subject of OPS-2D-5A-2.
   */
  correlationUnavailable: boolean;
}

export interface IncidentView {
  id: string;
  kind: string;
  provider: string;
  plaidItemId: string | null;
  financialAccountId: string | null;
  incidentKey: string | null;
  /** Derived — never stored. */
  state: SyncIssueState;
  classification: SyncIssueClassification;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  occurrenceCount: number;
  /**
   * How many of those occurrences carry a real RefreshExecution FK (OPS-2D-5D-1).
   *
   * Counted, not assumed. Several producers still have no execution envelope, so
   * "0 of 3 correlated" is a genuine and common answer; a consumer renders that
   * as correlation UNAVAILABLE and never as "no execution failed".
   */
  correlatedOccurrenceCount: number;
  resolvedAt: string | null;
  resolutionKind: string | null;
  resolvingExecutionId: string | null;
  previousIncidentId: string | null;
  /**
   * True for rows written before OPS-2D-5A-1: no identity, no occurrences, and
   * no recoverable execution correlation. Historically unknown, stated as such.
   */
  legacyUncorrelated: boolean;
}

type Row = {
  id: string; kind: string; provider: string;
  plaidItemId: string | null; financialAccountId: string | null;
  plaidTransactionId: string | null; detail: unknown;
  resolved: boolean; incidentKey: string | null;
  firstOccurredAt: Date | null; lastOccurredAt: Date | null;
  resolvedAt: Date | null; resolutionKind: string | null;
  resolvingExecutionId: string | null; previousIncidentId: string | null;
  createdAt: Date;
  _count?: { occurrences: number };
};

const SELECT = {
  id: true, kind: true, provider: true, plaidItemId: true, financialAccountId: true,
  plaidTransactionId: true, detail: true, resolved: true, incidentKey: true,
  firstOccurredAt: true, lastOccurredAt: true, resolvedAt: true, resolutionKind: true,
  resolvingExecutionId: true, previousIncidentId: true, createdAt: true,
  _count: { select: { occurrences: true } },
} as const;

/**
 * Referent existence, batched. An incident naming an account or item that no
 * longer exists describes nothing and is `orphaned` — which is also how the
 * known test-pollution rows are handled, WITHOUT mutating them.
 */
async function referentExistence(rows: Row[]): Promise<Map<string, boolean>> {
  const accountIds = [...new Set(rows.map((r) => r.financialAccountId).filter((x): x is string => !!x))];
  const itemIds = [...new Set(rows.map((r) => r.plaidItemId).filter((x): x is string => !!x))];
  const [accounts, items] = await Promise.all([
    accountIds.length ? db.financialAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true } }) : [],
    itemIds.length ? db.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } }) : [],
  ]);
  const liveAccounts = new Set(accounts.map((a) => a.id));
  const liveItems = new Set(items.map((i) => i.id));
  const out = new Map<string, boolean>();
  for (const r of rows) {
    const exists =
      r.financialAccountId ? liveAccounts.has(r.financialAccountId)
      : r.plaidItemId ? liveItems.has(r.plaidItemId)
      : true;
    out.set(r.id, exists);
  }
  return out;
}

/**
 * Occurrences carrying an execution FK, batched by episode. One grouped query
 * for the whole page rather than a per-incident lookup.
 */
async function correlatedCounts(rows: Row[]): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const grouped = await db.syncIssueOccurrence.groupBy({
    by: ["syncIssueId"],
    where: { syncIssueId: { in: rows.map((r) => r.id) }, refreshExecutionId: { not: null } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.syncIssueId, g._count._all]));
}

function toView(r: Row, referentExists: boolean, correlated: number): IncidentView {
  const classifiable = {
    kind: r.kind, provider: r.provider, detail: r.detail,
    plaidTransactionId: r.plaidTransactionId,
  };
  return {
    id: r.id, kind: r.kind, provider: r.provider,
    plaidItemId: r.plaidItemId, financialAccountId: r.financialAccountId,
    incidentKey: r.incidentKey,
    state: syncIssueState(classifiable, { referentExists, resolved: r.resolved }),
    classification: classifySyncIssue(classifiable),
    firstOccurredAt: (r.firstOccurredAt ?? r.createdAt).toISOString(),
    lastOccurredAt: (r.lastOccurredAt ?? r.createdAt).toISOString(),
    occurrenceCount: r._count?.occurrences ?? 0,
    correlatedOccurrenceCount: correlated,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolutionKind: r.resolutionKind,
    resolvingExecutionId: r.resolvingExecutionId,
    previousIncidentId: r.previousIncidentId,
    legacyUncorrelated: r.incidentKey === null && (r._count?.occurrences ?? 0) === 0,
  };
}

async function build(rows: Row[]): Promise<IncidentView[]> {
  const [referents, correlated] = await Promise.all([referentExistence(rows), correlatedCounts(rows)]);
  return rows.map((r) => toView(r, referents.get(r.id) ?? true, correlated.get(r.id) ?? 0));
}

/**
 * Incidents an operator should act on now.
 *
 * Filtered by DERIVED state, not by `resolved = false`. That matters: an
 * unresolved EVENT is evidence, and an unresolved row whose account was deleted
 * is orphaned — neither is actionable, and a Boolean filter would show both.
 */
export async function getActiveIncidents(limit = 200): Promise<IncidentView[]> {
  return (await getActiveIncidentPage(limit)).incidents;
}

/**
 * The same read, plus whether the underlying scan hit its ceiling.
 *
 * `incidents.length` cannot answer that: the scan takes `limit` UNRESOLVED rows
 * and only then filters to derived-active, so a truncated scan routinely yields
 * far fewer than `limit` incidents. A consumer that inferred completeness from
 * the returned length would silently present a floor as a total — so the fact is
 * reported by the module that actually knows it.
 */
export async function getActiveIncidentPage(
  limit = 200,
): Promise<{ incidents: IncidentView[]; scanTruncated: boolean }> {
  const rows = await db.syncIssue.findMany({
    where: { resolved: false },
    orderBy: { lastOccurredAt: "desc" },
    take: limit,
    select: SELECT,
  });
  const incidents = (await build(rows as Row[])).filter((v) => v.state === "active");
  return { incidents, scanTruncated: rows.length === limit };
}

/** Everything that is no longer active — resolved conditions and evidence alike. */
export async function getHistoricalIncidents(limit = 200): Promise<IncidentView[]> {
  const rows = await db.syncIssue.findMany({
    orderBy: { lastOccurredAt: "desc" },
    take: limit,
    select: SELECT,
  });
  return (await build(rows as Row[])).filter((v) => v.state !== "active");
}

/** One episode with its occurrences, for drill-down into execution evidence. */
export async function getIncidentDetail(
  id: string,
): Promise<{ incident: IncidentView; occurrences: IncidentOccurrenceView[] } | null> {
  const row = await db.syncIssue.findUnique({ where: { id }, select: SELECT });
  if (!row) return null;
  const [incident] = await build([row as Row]);
  const occ = await db.syncIssueOccurrence.findMany({
    where: { syncIssueId: id },
    orderBy: { observedAt: "desc" },
    select: { id: true, observedAt: true, refreshExecutionId: true, runId: true },
  });
  return {
    incident,
    occurrences: occ.map((o) => ({
      id: o.id,
      observedAt: o.observedAt.toISOString(),
      refreshExecutionId: o.refreshExecutionId,
      runId: o.runId,
      correlationUnavailable: o.refreshExecutionId === null,
    })),
  };
}
