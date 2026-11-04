/**
 * lib/platform/incidents/episodes-core.ts  (PB-4 — canonical incident episodes, pure)
 *
 * THE ONE ROW → STATE CALL every incident read shares. The active / historical
 * projections (projections.ts) and the Customer Success opened / resolved trend
 * (lib/platform/customer/incidents-daily.ts) both derive a SyncIssue row's state
 * here, from `syncIssueState` in lib/platform/sync-issue-semantics.ts — which
 * stays the sole classifier; this module only names the row shape and the
 * EPISODE predicate the trend counts.
 *
 * WHY THE TREND NEEDS IT (owner, 2026-11-02). The trend once counted every
 * SyncIssue row, so 64 REMOVED_TOMBSTONE rows — routine Plaid removed-
 * transaction EVENTS (pending → posted), stored `resolved = true · resolvedAt
 * = null · incidentKey = null` by the lifecycle invariant
 * (lib/platform/incidents/invariant.ts) — read as "64 opened · 0 resolved".
 * An event is evidence, never an incident: it is never opened and never
 * resolved. Superseded and orphaned rows are not incidents either.
 *
 * An EPISODE is a CONDITION on a subject that still exists: state `active`
 * (open now — exactly what getActiveIncidentPage returns) or `recovered`
 * (resolved, and the invariant guarantees `resolvedAt` is set). Opened = its
 * first occurrence (else created); resolved = its `resolvedAt`.
 *
 * Pure: no I/O, no clock.
 */

import { syncIssueState, type SyncIssueState } from "@/lib/platform/sync-issue-semantics";

/** The SyncIssue fields state derivation reads. `detail` is classified, never re-exposed. */
export interface EpisodeStateRow {
  kind: string;
  provider: string;
  detail: unknown;
  plaidTransactionId: string | null;
  resolved: boolean;
}

/** A row's derived state — the single call both the projections and the trend make. */
export function episodeStateOf(r: EpisodeStateRow, referentExists: boolean): SyncIssueState {
  return syncIssueState(
    { kind: r.kind, provider: r.provider, detail: r.detail, plaidTransactionId: r.plaidTransactionId },
    { referentExists, resolved: r.resolved },
  );
}

export type EpisodeState = Extract<SyncIssueState, "active" | "recovered">;

/** True for a canonical incident episode (open or recovered); false for evidence, superseded and orphaned rows. */
export function isIncidentEpisodeState(s: SyncIssueState): s is EpisodeState {
  return s === "active" || s === "recovered";
}

export interface EpisodeTimelineRow extends EpisodeStateRow {
  id: string;
  firstOccurredAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface EpisodeInstant {
  id: string;
  state: EpisodeState;
  openedAt: Date;
  /** Set only for a `recovered` episode (an active one has not resolved). */
  resolvedAt: Date | null;
}

/** The canonical episodes among `rows`, each with its opened / resolved instants. */
export function incidentEpisodes(rows: readonly EpisodeTimelineRow[], referentExists: (id: string) => boolean): EpisodeInstant[] {
  const out: EpisodeInstant[] = [];
  for (const r of rows) {
    const state = episodeStateOf(r, referentExists(r.id));
    if (!isIncidentEpisodeState(state)) continue;
    out.push({ id: r.id, state, openedAt: r.firstOccurredAt ?? r.createdAt, resolvedAt: state === "recovered" ? r.resolvedAt : null });
  }
  return out;
}
