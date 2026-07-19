/**
 * lib/connections/intelligence.ts  (CONN-2A / CONN-2E)
 *
 * The connection INTELLIGENCE projection — a pure, derived view answering
 * "is this connection's financial intelligence built?" It is NOT a new sync
 * authority and persists nothing. It composes existing canonical truth:
 *   - SyncConnection.state  (from PlaidItem.syncIncompleteAt / Connection.*)
 *   - PLAID_HISTORY_SYNCED  AuditLog anchor (reconstruction-complete record)
 *   - MIN(non-deleted Transaction.date)  (available-history floor)
 *
 * THE CORE INSIGHT (CONN-2 doctrine): a connection can have COMPLETE transaction
 * data while DERIVED intelligence (wealth timeline, snapshots, charts) is still
 * rebuilding. `syncIncompleteAt` is cleared at the end of transaction sync —
 * BEFORE the historical-wealth reconstruction + PLAID_HISTORY_SYNCED write — so
 * there is a real interval where state reads "ready" but intelligence is still
 * REBUILDING. This module makes that interval visible instead of pretending the
 * two are the same event (CONN-2G).
 *
 * ARCHITECTURE (CONN-2E): provider truth stays boring (ACTIVE / NEEDS_REAUTH /
 * ERROR / REVOKED — unchanged). The richer UI phases (IMPORTING / RECONSTRUCTING
 * / READY / ACTION_REQUIRED / …) are DERIVED here, never a database column.
 *
 * Pure + dependency-light (only the SyncConnection type) so it is unit-testable
 * with a standalone `tsx` script, matching lib/sync/status.ts + lib/sync/lifecycle.ts.
 */

import type { SyncConnection, SyncConnectionState } from "@/lib/sync/status";

export type TransactionHistoryStatus = "READY" | "IMPORTING" | "UNKNOWN";
export type IntelligenceStatus = "READY" | "REBUILDING" | "NOT_READY";

/**
 * Derived UI phase (CONN-2E). Provider truth is NOT expanded into these — they
 * are computed. RETRYING is a client-only refinement of IMPORTING (the resume
 * bookkeeping in ConnectionsList); REMOVING is a forward slot with no signal yet
 * — neither is produced by this pure server derivation, and neither is faked.
 */
export type ConnectionLifecyclePhase =
  | "IMPORTING"
  | "RECONSTRUCTING"
  | "READY"
  | "ACTION_REQUIRED";

/** Approximate available-history span, split for display ("~2y", "1y 8m", "18m"). */
export interface AvailableHistory {
  /** Total whole days from earliest transaction to `now`. */
  days:   number;
  /** Whole months (days / 30.44), for "18 months" style display. */
  months: number;
  /** Whole years (months / 12). `months` above is the TOTAL; use `remainderMonths` for "Ny Mm". */
  years:  number;
  /** Months after subtracting whole years — for the "1 year 8 months" form. */
  remainderMonths: number;
}

export interface ConnectionIntelligenceStatus {
  transactionHistory: TransactionHistoryStatus;
  intelligence:       IntelligenceStatus;
  phase:              ConnectionLifecyclePhase;
  /** True ONLY when acquisition AND reconstruction are both complete (CONN-2G). */
  intelligenceReady:  boolean;
  /** null when the connection has no transactions yet (show "no history yet", not "0 months"). */
  availableHistory:        AvailableHistory | null;
  earliestTransactionDate: string | null; // ISO
  lastReconstructedAt:     string | null; // ISO — PLAID_HISTORY_SYNCED.createdAt (wallet: lastSyncedAt proxy)
}

/** Structural input for the pure derivation — gathered by the loader. */
export interface IntelligenceInput {
  provider: SyncConnection["provider"];
  state:    SyncConnectionState;
  /** The reconstruction-complete anchor: PLAID_HISTORY_SYNCED.createdAt for Plaid,
   *  or Connection.lastSyncedAt for wallets (reconstruction runs inline before it
   *  is set). null = no reconstruction recorded yet. */
  historySyncedAt: Date | null;
  /** MIN(non-deleted Transaction.date) across the connection's accounts, or null. */
  earliestTxDate:  Date | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Available-history span. Months are counted by the CALENDAR (not days/30.44) so
 * an exact span reads honestly — 2 full years → "2 years", not "1 year 11
 * months". `days` is the raw whole-day diff. Both floor toward the completed
 * unit and never go negative.
 */
export function computeAvailableHistory(earliest: Date | null, now: Date): AvailableHistory | null {
  if (!earliest) return null;
  const days = Math.max(0, Math.floor((now.getTime() - earliest.getTime()) / MS_PER_DAY));
  let months =
    (now.getUTCFullYear() - earliest.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - earliest.getUTCMonth());
  // Not a full final month until the day-of-month is reached.
  if (now.getUTCDate() < earliest.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  const years = Math.floor(months / 12);
  return { days, months, years, remainderMonths: months - years * 12 };
}

function deriveTransactionHistory(state: SyncConnectionState): TransactionHistoryStatus {
  switch (state) {
    case "importing": return "IMPORTING";
    case "ready":     return "READY";
    default:          return "UNKNOWN"; // needs_reauth / error
  }
}

/**
 * Intelligence status. Plaid: READY iff a PLAID_HISTORY_SYNCED anchor exists;
 * REBUILDING iff transactions are done (state ready) but no anchor yet (the
 * gap window); else NOT_READY. Wallet: reconstruction runs inline before ready,
 * so READY iff state ready. A non-null `historySyncedAt` always means READY.
 */
function deriveIntelligence(
  provider: SyncConnection["provider"],
  state: SyncConnectionState,
  historySyncedAt: Date | null,
): IntelligenceStatus {
  if (historySyncedAt !== null) return "READY";
  if (provider === "WALLET") return state === "ready" ? "READY" : "NOT_READY";
  // Plaid, no anchor yet:
  if (state === "ready") return "REBUILDING"; // transactions done, intelligence building
  return "NOT_READY";
}

function derivePhase(state: SyncConnectionState, intelligence: IntelligenceStatus): ConnectionLifecyclePhase {
  if (state === "needs_reauth" || state === "error") return "ACTION_REQUIRED";
  if (state === "importing") return "IMPORTING";
  // state === "ready":
  return intelligence === "READY" ? "READY" : "RECONSTRUCTING";
}

/** Pure derivation of the full intelligence status from gathered inputs. */
export function deriveConnectionIntelligence(
  input: IntelligenceInput,
  now: Date,
): ConnectionIntelligenceStatus {
  const transactionHistory = deriveTransactionHistory(input.state);
  const intelligence = deriveIntelligence(input.provider, input.state, input.historySyncedAt);
  const phase = derivePhase(input.state, intelligence);
  return {
    transactionHistory,
    intelligence,
    phase,
    intelligenceReady: intelligence === "READY",
    availableHistory: computeAvailableHistory(input.earliestTxDate, now),
    earliestTransactionDate: input.earliestTxDate ? input.earliestTxDate.toISOString() : null,
    lastReconstructedAt: input.historySyncedAt ? input.historySyncedAt.toISOString() : null,
  };
}

/** True iff any connection is still building intelligence (importing OR
 *  reconstructing) — the "keep polling" condition for the Connections poller,
 *  a superset of SyncStatus.building (which only covers importing). */
export function isBuildingIntelligence(statuses: ConnectionIntelligenceStatus[]): boolean {
  return statuses.some((s) => s.phase === "IMPORTING" || s.phase === "RECONSTRUCTING");
}

/**
 * Human "~N available" label from the derived span. null / zero history →
 * "No historical data yet" (never "0 months" — the CONN-2 empty-data rule).
 */
export function formatAvailableHistory(h: AvailableHistory | null): string {
  if (!h || h.months <= 0) return "No historical data yet";
  const { years, remainderMonths, months } = h;
  if (years <= 0) return `~${months} month${months === 1 ? "" : "s"}`;
  const y = `${years} year${years === 1 ? "" : "s"}`;
  if (remainderMonths <= 0) return `~${y}`;
  return `~${y} ${remainderMonths} month${remainderMonths === 1 ? "" : "s"}`;
}
