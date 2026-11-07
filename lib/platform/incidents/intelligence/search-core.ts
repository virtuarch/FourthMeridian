/**
 * lib/platform/incidents/intelligence/search-core.ts  (PB-1 Phase 2B — search, PURE + client-safe)
 *
 * The ONE parser and the ONE filter for incident search. The route validates
 * with `parseIncidentSearch`, the URL mirror (components/platform/incidents/
 * incidents-url.ts) reads with the same function, so a URL can never name a
 * search the server refuses — an unknown value is dropped, never kept.
 *
 * `searchVerdicts` filters DERIVED verdicts (the core already decided state,
 * severity, operation): a status preset is exactly one accessor's predicate
 * (types.ts IncidentStatusFilter), so "broken now" here can never drift from
 * `brokenNow`. Paging is applied after filtering; `total` is the filtered count
 * of what the scan saw — a floor when the scan was truncated (D5).
 *
 * Imports types only, plus the registry-code pattern — no server code, no I/O.
 */

import { isRegistryCode } from "../codes";
import type {
  IncidentSearchQuery,
  IncidentSearchResult,
  IncidentStatusFilter,
  IncidentTimeline,
  IncidentTimelineEvent,
  IncidentVerdict,
  Severity,
} from "./types";

/** Rows per page (fixed: the page is part of the URL, so it must mean one thing). */
export const INCIDENT_PAGE_SIZE = 25;
/** Rows one search scans (each of SyncIssue and SyncIssueArchive). Reported via `truncated`, never silent. */
export const SEARCH_SCAN_LIMIT = 500;
/** The highest page a URL may name: the scan can never fill more. */
export const MAX_INCIDENT_PAGE = Math.ceil((SEARCH_SCAN_LIMIT * 2) / INCIDENT_PAGE_SIZE);
/** SyncIssueArchive retention (jobs/data-retention.ts INCIDENT_ARCHIVE_RETENTION_DAYS; pinned equal in the test). */
export const HISTORY_RETENTION_DAYS = 396;
/** A resolved SyncIssue row is archived + pruned this many days after resolvedAt (jobs/data-retention.ts syncIssue rule). */
export const RESOLVED_ROW_RETENTION_DAYS = 90;
/** Timeline events read per incident (the archive copy is capped by bytes on write). */
export const TIMELINE_READ_CAP = 200;
/** Recurrence episodes listed per incident. */
export const RECURRENCE_CAP = 20;

export const STATUS_FILTERS: readonly IncidentStatusFilter[] = ["broken-now", "needs-verification", "history", "all"];
export const SEVERITY_FILTERS: readonly Severity[] = ["critical", "error", "warning", "info"];

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER = /^[A-Z][A-Z0-9_]{1,31}$/;
/** Registered operation keys are lower-case, dot / colon / dash separated (operation-key.ts). */
const OPERATION = /^[a-z0-9][a-z0-9:._-]{1,95}$/;

export const DEFAULT_SEARCH: IncidentSearchQuery = {
  status: "broken-now", severity: null, provider: null, operation: null, code: null, from: null, to: null, page: 1,
};

function day(v: string | null): string | null {
  if (!v || !DAY.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** The oldest day a history search may reach (the archive's retention). */
export function retentionFloorDay(nowMs: number): string {
  return new Date(nowMs - HISTORY_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * THE parser. Every value is validated; anything unknown is dropped (null /
 * default), never passed through. `from` is clamped to the retention floor;
 * `from` after `to` drops both (an empty range is not a filter anyone meant).
 */
export function parseIncidentSearch(params: URLSearchParams, nowMs: number): IncidentSearchQuery & { fromClamped: boolean } {
  const status = (STATUS_FILTERS as readonly string[]).includes(params.get("status") ?? "") ? params.get("status") as IncidentStatusFilter : "broken-now";
  const sev = params.get("severity");
  const severity = sev && (SEVERITY_FILTERS as readonly string[]).includes(sev) ? sev as Severity : null;
  const prov = params.get("provider");
  const provider = prov && PROVIDER.test(prov) ? prov : null;
  const op = params.get("operation");
  const operation = op && OPERATION.test(op) ? op : null;
  const c = params.get("code");
  const code = isRegistryCode(c) ? c : null;
  let from = day(params.get("from"));
  let to = day(params.get("to"));
  const floor = retentionFloorDay(nowMs);
  let fromClamped = false;
  if (from !== null && from < floor) { from = floor; fromClamped = true; }
  if (from !== null && to !== null && from > to) { from = null; to = null; fromClamped = false; }
  const rawPage = Number(params.get("page"));
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_INCIDENT_PAGE) : 1;
  return { status, severity, provider, operation, code, from, to, page, fromClamped };
}

/** The canonical query string for a search (defaults omitted) — the route path and the KPI share it. */
export function incidentSearchParams(q: IncidentSearchQuery): URLSearchParams {
  const p = new URLSearchParams();
  p.set("status", q.status);
  if (q.severity) p.set("severity", q.severity);
  if (q.provider) p.set("provider", q.provider);
  if (q.operation) p.set("operation", q.operation);
  if (q.code) p.set("code", q.code);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.page > 1) p.set("page", String(q.page));
  return p;
}

/** Inclusive UTC instants for the day bounds (to = the END of that day). */
export function dayBounds(q: Pick<IncidentSearchQuery, "from" | "to">): { gte: Date | null; lte: Date | null } {
  return {
    gte: q.from ? new Date(`${q.from}T00:00:00.000Z`) : null,
    lte: q.to ? new Date(`${q.to}T23:59:59.999Z`) : null,
  };
}

/** Does the status preset need closed rows / the archive at all? (Open presets read resolved=false only.) */
export function statusReadsClosed(status: IncidentStatusFilter): boolean {
  return status === "history" || status === "all";
}

/** The status preset as a predicate — each EXACTLY one accessor's filter (index.ts). */
export function matchesStatus(v: IncidentVerdict, status: IncidentStatusFilter): boolean {
  if (v.rowClass !== "incident") return false;
  switch (status) {
    case "broken-now": return v.brokenNow;
    case "needs-verification": return v.state === "stale-unverified";
    case "history": return v.state === "resolved" || v.state === "archived";
    case "all": return true;
  }
}

/** The non-status filters (exact over derived fields). */
export function matchesFilters(v: IncidentVerdict, q: IncidentSearchQuery): boolean {
  if (q.severity && v.severity !== q.severity) return false;
  if (q.provider && v.provider !== q.provider) return false;
  if (q.operation && v.operation !== q.operation) return false;
  if (q.code && v.kind !== q.code && v.causeCode !== q.code) return false;
  const { gte, lte } = dayBounds(q);
  const last = Date.parse(v.lastSeenAt);
  if (gte && last < gte.getTime()) return false;
  if (lte && last > lte.getTime()) return false;
  return true;
}

/** Filter → facets → page. `verdicts` arrive in the core's deterministic order. */
export function searchVerdicts<T extends IncidentVerdict>(
  verdicts: readonly T[],
  q: IncidentSearchQuery,
  scan: { truncated: boolean; scanned: number },
): IncidentSearchResult<T> {
  const inStatus = verdicts.filter((v) => matchesStatus(v, q.status));
  const facets = {
    providers: [...new Set(inStatus.map((v) => v.provider))].sort(),
    operations: [...new Set(inStatus.map((v) => v.operation).filter((x): x is string => x !== null))].sort(),
    codes: [...new Set(inStatus.flatMap((v) => [v.kind, v.causeCode]).filter((x): x is string => isRegistryCode(x)))].sort(),
  };
  const matched = inStatus.filter((v) => matchesFilters(v, q));
  const start = (q.page - 1) * INCIDENT_PAGE_SIZE;
  return {
    items: matched.slice(start, start + INCIDENT_PAGE_SIZE),
    total: matched.length,
    page: q.page,
    pageSize: INCIDENT_PAGE_SIZE,
    truncated: scan.truncated,
    scanned: scan.scanned,
    facets,
  };
}

// ── Timeline ────────────────────────────────────────────────────────────────

const OPAQUE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const idOrNull = (x: unknown): string | null => (typeof x === "string" && OPAQUE_ID.test(x) ? x : null);
const codeOrNull = (x: unknown): string | null => (isRegistryCode(x) ? x : null);
const actorOf = (x: unknown): IncidentTimelineEvent["actorKind"] => (x === "SYSTEM" || x === "OPERATOR" ? x : null);

/** One SyncIssueEvent row as selected (index.ts EVENT_SELECT) → the emitted event. Field-for-field; nothing merged or reordered. */
export function timelineEventOf(e: {
  id: string; at: Date; type: string; actorKind: string; auditId: string | null;
  fromState: string | null; toState: string | null; causeCode: string | null; actionCode: string | null; outcomeCode: string | null;
  refEventId: string | null; refreshExecutionId: string | null; jobRunId: string | null;
}): IncidentTimelineEvent {
  return {
    id: e.id, at: e.at.toISOString(), type: codeOrNull(e.type) ?? "UNKNOWN", actorKind: actorOf(e.actorKind), audited: e.auditId !== null,
    fromState: codeOrNull(e.fromState), toState: codeOrNull(e.toState), causeCode: codeOrNull(e.causeCode),
    actionCode: codeOrNull(e.actionCode), outcomeCode: codeOrNull(e.outcomeCode),
    refEventId: idOrNull(e.refEventId), refreshExecutionId: idOrNull(e.refreshExecutionId), jobRunId: idOrNull(e.jobRunId),
  };
}

/** The archive's capped code-only copy (archive-core.ts buildEventTimeline) → events, in stored order. Malformed ⇒ none. */
export function archivedTimelineOf(stored: unknown): IncidentTimeline {
  const o = stored as { events?: unknown; truncated?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.events)) return { source: "none", events: [], truncated: false };
  const events: IncidentTimelineEvent[] = [];
  for (const raw of o.events) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) continue;
    events.push({
      id: null, at: new Date(Date.parse(r.at)).toISOString(), type: codeOrNull(r.type) ?? "UNKNOWN", actorKind: null, audited: false,
      fromState: codeOrNull(r.fromState), toState: codeOrNull(r.toState), causeCode: codeOrNull(r.causeCode),
      actionCode: codeOrNull(r.actionCode), outcomeCode: codeOrNull(r.outcomeCode),
      refEventId: null, refreshExecutionId: null, jobRunId: null,
    });
  }
  return { source: events.length ? "archive" : "none", events, truncated: o.truncated === true };
}

/** When a live resolved row leaves SyncIssue for the archive; when the archive record is pruned. */
export function archiveDates(a: { resolvedAt: string | null; archivedAt: string | null }): { archiveDueAt: string | null; retainedUntil: string | null } {
  const plus = (iso: string | null, days: number) => (iso ? new Date(Date.parse(iso) + days * DAY_MS).toISOString() : null);
  return {
    archiveDueAt: a.archivedAt ? null : plus(a.resolvedAt, RESOLVED_ROW_RETENTION_DAYS),
    retainedUntil: plus(a.archivedAt, HISTORY_RETENTION_DAYS),
  };
}
