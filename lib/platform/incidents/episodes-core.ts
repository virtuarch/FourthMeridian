/**
 * lib/platform/incidents/episodes-core.ts  (PB-4 — canonical incident episodes, pure)
 *
 * THE ONE legacy ROW → STATE CALL outside the intelligence module, from
 * `syncIssueState` in lib/platform/sync-issue-semantics.ts (the sole classifier).
 *
 * PB-1 Phase 3 — its only remaining caller is projections.ts's IncidentView
 * mapping for getIncidentDetail, whose one consumer (Ops attention) reads the
 * occurrences and IGNORES the state (S2 ruling: "execution evidence only; state
 * ignored"). The Customer Success trend no longer reads it: it folds module
 * verdicts (lib/platform/customer/incident-trend-core.ts). The episode fold that
 * lived here is gone.
 *
 * (History, owner 2026-11-02: the trend once counted every row, so routine
 * REMOVED_TOMBSTONE events read as "opened". The module's D1 — evidence is never
 * an incident — now carries that rule, in incident-trend-core.ts.)
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

/** A row's legacy derived state — getIncidentDetail's view only (its consumer ignores it). */
export function episodeStateOf(r: EpisodeStateRow, referentExists: boolean): SyncIssueState {
  return syncIssueState(
    { kind: r.kind, provider: r.provider, detail: r.detail, plaidTransactionId: r.plaidTransactionId },
    { referentExists, resolved: r.resolved },
  );
}
