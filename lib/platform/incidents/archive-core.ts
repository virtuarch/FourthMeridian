/**
 * lib/platform/incidents/archive-core.ts  (PB-1 Phase 1 — the archive row builder, pure)
 *
 * The ONLY way a SyncIssueArchive row is shaped. EXPLICIT ALLOWLIST: ids,
 * registry codes, enums, timestamps and counts. `detail`, provider messages,
 * error text and any other free text are structurally unreachable — the input
 * type does not carry them, every string is re-validated against its own
 * shape, and resolutionEvidence is re-built by the typed evidence builder.
 * Pinned by archive-core.test.ts (the leak test).
 */

import { parseIncidentKey } from "./identity";
import { reshapeStoredEvidence, TIMELINE_MAX_BYTES } from "./evidence";
import { isRegistryCode } from "./codes";

/** What the prune reads — deliberately WITHOUT `detail`. */
export interface ArchivableIncident {
  id: string;
  incidentKey: string | null;
  provider: string;
  kind: string;
  plaidItemId: string | null;
  financialAccountId: string | null;
  subjectUserId: string | null;
  previousIncidentId: string | null;
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
  resolvedAt: Date | null;
  resolutionKind: string | null;
  resolutionReasonCode: string | null;
  causeStatus: string | null;
  causeCode: string | null;
  resolutionEvidence: unknown;
  occurrenceCount: number;
}

export interface ArchivableEvent {
  type: string;
  at: Date;
  fromState: string | null;
  toState: string | null;
  causeCode: string | null;
  actionCode: string | null;
  outcomeCode: string | null;
}

export interface ArchiveRow {
  incidentId: string;
  incidentKey: string | null;
  provider: string;
  kind: string;
  operation: string | null;
  plaidItemId: string | null;
  financialAccountId: string | null;
  subjectUserId: string | null;
  previousIncidentId: string | null;
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
  resolvedAt: Date | null;
  resolutionKind: string | null;
  resolutionReasonCode: string | null;
  causeStatus: string | null;
  causeCode: string | null;
  occurrenceCount: number;
  resolutionEvidence: unknown;
  eventTimeline: { events: Record<string, string>[]; truncated: boolean } | null;
}

/** An opaque id (cuid / uuid / provider item id): word characters, dashes, colons. */
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const ENUMISH = /^[A-Z][A-Z0-9_]{1,63}$/;
/** v1::PROVIDER::scope::domain::operation — every segment id-shaped. */
const KEY = /^v\d+::[A-Z_]{2,32}::[A-Za-z0-9_:.-]{1,160}::[a-z_]{2,32}::[a-z0-9:._-]{1,96}$/;

const id = (x: string | null): string | null => (x && ID.test(x) ? x : null);
const code = (x: string | null): string | null => (isRegistryCode(x) ? x : null);

/** Provider is an enum-like platform value ("PLAID", "WALLET"); anything else is not ours to keep. */
function providerOf(p: string): string {
  return ENUMISH.test(p) ? p : "UNKNOWN";
}

/** The code-only timeline: newest events kept within the cap, oldest dropped first. */
export function buildEventTimeline(events: readonly ArchivableEvent[]): ArchiveRow["eventTimeline"] {
  if (events.length === 0) return null;
  const rows = [...events].sort((a, b) => a.at.getTime() - b.at.getTime()).map((e) => {
    const r: Record<string, string> = { at: e.at.toISOString() };
    if (ENUMISH.test(e.type)) r.type = e.type;
    for (const k of ["fromState", "toState", "causeCode", "actionCode", "outcomeCode"] as const) {
      const v = code(e[k]); if (v) r[k] = v;
    }
    return r;
  });
  let truncated = false;
  // Leave headroom for the wrapper; JSON text length bounds pg_column_size from above.
  while (rows.length > 0 && Buffer.byteLength(JSON.stringify({ events: rows, truncated: true }), "utf8") > TIMELINE_MAX_BYTES - 64) {
    rows.shift(); truncated = true;
  }
  return { events: rows, truncated };
}

export function buildArchiveRow(r: ArchivableIncident, events: readonly ArchivableEvent[] = []): ArchiveRow {
  const key = r.incidentKey && KEY.test(r.incidentKey) ? r.incidentKey : null;
  const op = parseIncidentKey(key)?.operation ?? null;
  return {
    incidentId: r.id,
    incidentKey: key,
    provider: providerOf(r.provider),
    kind: ENUMISH.test(r.kind) ? r.kind : "UNKNOWN",
    operation: op && /^[a-z0-9:._-]{1,96}$/.test(op) ? op : null,
    plaidItemId: id(r.plaidItemId),
    financialAccountId: id(r.financialAccountId),
    subjectUserId: id(r.subjectUserId),
    previousIncidentId: id(r.previousIncidentId),
    firstOccurredAt: r.firstOccurredAt,
    lastOccurredAt: r.lastOccurredAt,
    resolvedAt: r.resolvedAt,
    resolutionKind: r.resolutionKind && ENUMISH.test(r.resolutionKind) ? r.resolutionKind : null,
    resolutionReasonCode: code(r.resolutionReasonCode),
    causeStatus: r.causeStatus === "HYPOTHESIS" || r.causeStatus === "CONFIRMED" ? r.causeStatus : null,
    causeCode: code(r.causeCode),
    occurrenceCount: Number.isInteger(r.occurrenceCount) && r.occurrenceCount >= 0 ? r.occurrenceCount : 0,
    resolutionEvidence: reshapeStoredEvidence(r.resolutionEvidence),
    eventTimeline: buildEventTimeline(events),
  };
}

/** The archive column set — pinned by the test so a new column is a deliberate allowlist edit. */
export const ARCHIVE_ROW_KEYS = [
  "incidentId", "incidentKey", "provider", "kind", "operation", "plaidItemId", "financialAccountId",
  "subjectUserId", "previousIncidentId", "firstOccurredAt", "lastOccurredAt", "resolvedAt", "resolutionKind",
  "resolutionReasonCode", "causeStatus", "causeCode", "occurrenceCount", "resolutionEvidence", "eventTimeline",
] as const;
