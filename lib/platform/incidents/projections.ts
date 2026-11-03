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
  type SyncIssueState,
  type SyncIssueClassification,
} from "@/lib/platform/sync-issue-semantics";
import { episodeStateOf, incidentEpisodes, type EpisodeInstant } from "./episodes-core";
import { incidentAccessors, type CsToken, type OpsToken } from "./intelligence";
import type { IncidentVerdict } from "./intelligence/types";
import { loadSubjectFacts } from "./subjects";
import { isSubjectRemoved, subjectVerdict } from "./subjects-core";

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
type ReferentRow = Pick<Row, "id" | "financialAccountId" | "plaidItemId">;

async function referentExistence(rows: readonly ReferentRow[], client: typeof db): Promise<Map<string, boolean>> {
  // PB-1 R4 (D2 / D2b) — THE one referent rule (subjects-core.ts), the same one the
  // intelligence module applies: a soft-deleted account, a REVOKED item or a missing
  // row is REMOVED. Replaces the account-else-item existence check, which honoured
  // neither deletedAt nor REVOKED.
  const facts = await loadSubjectFacts(rows, client);
  const out = new Map<string, boolean>();
  for (const r of rows) out.set(r.id, !isSubjectRemoved(subjectVerdict(r, facts)));
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
    // PB-4 — the ONE row → state call (episodes-core.ts), shared with the CS trend.
    state: episodeStateOf(r, referentExists),
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
  const [referents, correlated] = await Promise.all([referentExistence(rows, db), correlatedCounts(rows)]);
  return rows.map((r) => toView(r, referents.get(r.id) ?? true, correlated.get(r.id) ?? 0));
}

/**
 * PB-1 R4 — one module verdict → the projection's IncidentView (shape unchanged
 * for every consumer). Identity-free whatever the tier: no field below carries a
 * customer id. `state` is "active" for every broken-now verdict (active,
 * acknowledged, recovering); the projection never returns anything else.
 */
export function incidentViewOf(v: IncidentVerdict): IncidentView {
  const incidentKey = v.episodeKey.startsWith("legacy:") ? null : v.episodeKey;
  return {
    id: v.id, kind: v.kind, provider: v.provider,
    plaidItemId: v.plaidItemId, financialAccountId: v.financialAccountId,
    incidentKey,
    state: "active",
    classification: {
      domain: v.domain as SyncIssueClassification["domain"], severity: v.severity,
      nature: v.rowClass === "incident" ? "condition" : "event",
      customerActionable: v.customerActionable, cursorBlocking: v.cursorBlocking,
    },
    firstOccurredAt: v.firstSeenAt, lastOccurredAt: v.lastSeenAt,
    occurrenceCount: v.occurrenceCount, correlatedOccurrenceCount: v.correlatedOccurrenceCount,
    resolvedAt: v.resolvedAt, resolutionKind: null, resolvingExecutionId: null,
    previousIncidentId: v.recurrence.previousIncidentId,
    legacyUncorrelated: incidentKey === null && v.occurrenceCount === 0,
  };
}

/**
 * Incidents an operator should act on now — the intelligence module's verdicts,
 * read through the caller's token (minted from ITS OWN guard result).
 */
export async function getActiveIncidents(token: IncidentPageToken, limit = 200): Promise<IncidentView[]> {
  return (await getActiveIncidentPage(token, limit)).incidents;
}

/** Which tier may read the page: a CS / Ops token minted by the route from its own guard result. */
export type IncidentPageToken = CsToken | OpsToken;

/**
 * PB-1 R4 — the active-incident page, through the ONE intelligence module. No
 * raw `resolved = false` filter and no referent rule of its own: D1 (derived
 * state), D2 / D2b (removed subjects closed), D10 (a stale-unverified row is not
 * broken now) are the module's.
 *
 * Reads `brokenNow` (active + acknowledged + recovering). The alert engine does
 * NOT read this page: it reads the module's `alertable` set with the SYSTEM
 * token, from lib/alerts only (pinned), and maps it through incidentViewOf.
 *
 * `scanTruncated` is the module's D5 flag: the scan hit its cap, so the page is a floor.
 */
export async function getActiveIncidentPage(
  token: IncidentPageToken,
  limit = 200,
): Promise<{ incidents: IncidentView[]; scanTruncated: boolean }> {
  const page = await incidentAccessors.brokenNow(token, { limit });
  return { incidents: page.items.map(incidentViewOf), scanTruncated: page.truncated };
}

/**
 * PB-4 — the canonical incident EPISODES touching a window, for an opened /
 * resolved trend (lib/platform/customer/incidents-daily.ts).
 *
 * The same state derivation as getActiveIncidentPage (`episodeStateOf`, the
 * same referent check), so the trend's still-open episodes are exactly the
 * active incidents above and an EVENT row (a REMOVED_TOMBSTONE, say) is never
 * "opened". Returns only ids, states and instants — `detail` is read to
 * classify and never leaves this function.
 */
export async function getIncidentEpisodeTimeline(
  since: Date,
  cap: number,
  client: typeof db,
): Promise<{ episodes: EpisodeInstant[]; scanTruncated: boolean }> {
  const rows = await client.syncIssue.findMany({
    where: { OR: [{ createdAt: { gte: since } }, { firstOccurredAt: { gte: since } }, { resolvedAt: { gte: since } }] },
    select: {
      id: true, kind: true, provider: true, plaidItemId: true, financialAccountId: true, plaidTransactionId: true,
      detail: true, resolved: true, firstOccurredAt: true, resolvedAt: true, createdAt: true,
    },
    take: cap,
  });
  const referents = await referentExistence(rows, client);
  return {
    episodes: incidentEpisodes(rows.map((r) => ({ ...r, kind: String(r.kind), provider: String(r.provider) })), (id) => referents.get(id) ?? true),
    scanTruncated: rows.length >= cap,
  };
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
