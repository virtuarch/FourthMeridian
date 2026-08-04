/**
 * lib/transactions/lifecycle.ts   (V27-L4A — LIFECYCLE AUTHORITY)
 *
 * THE canonical answer to "what lifecycle state is this economic event in?"
 * Pure: no DB, no React, no clock. A caller supplies the row's evidence; this
 * module decides. Nothing here mutates anything — `pending`, `settlementState`
 * and `deletedAt` are all read as evidence and none is rewritten.
 *
 * ── The measured evidence (corpus 2026-08-04, ALL rows) ─────────────────────
 *
 *   settlementState  pending  deleted   n
 *   POSTED           false    false    4036
 *   null             false    false     348
 *   PENDING          true     TRUE       44     ← tombstoned pending rows
 *   PENDING          true     false       6
 *   null             true     false       4
 *
 * Two corrections to the picture the investigation left:
 *
 *   1. **The 352 null-state rows are NOT contradictions.** Every one of them is
 *      a seed/manual row — no `plaidTransactionId`, no `externalTransactionId`.
 *      They come from a source that never populated the column. Active direct
 *      contradictions (`PENDING`+`pending=false`, or `POSTED`+`pending=true`)
 *      number **0**. So this is a POPULATION gap, not a repair problem, and this
 *      slice deliberately mutates none of them.
 *
 *   2. **Tombstoned rows split.** Of the 44, **37 have a live posted successor**
 *      (a real PENDING→POSTED transition) and **7 do not** — removed with no
 *      replacement, which is the only observable evidence of a withdrawal.
 *
 * ── Why the vocabulary stops where it does ──────────────────────────────────
 *
 * `SettlementState` in the schema is only `PENDING | POSTED`. WITHDRAWN is
 * DERIVED here from tombstone-without-successor; it is never stored, and no
 * schema change is needed to express it.
 *
 * SETTLED is absent on purpose: no provider on these rails attests settlement,
 * and modelling a state nobody reports is the mistake the historical engine
 * spent four slices removing. CANCELLED and EXPIRED are likewise absent —
 * `removed`-with-no-replacement cannot tell them apart, so they collapse into
 * the one honest state, WITHDRAWN.
 *
 * REVERSED is declared but **never returned by this resolver**, and that is a
 * statement about the evidence rather than an oversight: a reversal arrives as a
 * NEW offsetting row, not as a state change on the original, so no row in this
 * corpus can be observed to be reversed. It exists in the type so that a future
 * provider that DOES attest it has somewhere honest to land, and the exhaustive
 * switches below will force every consumer to handle it on the day it appears.
 */

/** Observable lifecycle states. See the header for what is deliberately absent. */
export type LifecycleState =
  /** The provider has authorized but not posted this movement. */
  | "PENDING"
  /** The provider has posted it. */
  | "POSTED"
  /** A pending movement the provider removed WITHOUT a replacement. Covers both
   *  cancellation and expiry, which the evidence cannot distinguish. */
  | "WITHDRAWN"
  /** Declared, never returned — see the header. */
  | "REVERSED"
  /** The evidence does not support any of the above. */
  | "UNKNOWN";

/** Which evidence decided the state. */
export type LifecycleBasis =
  /** `settlementState`, the canonical column. */
  | "SETTLEMENT_STATE"
  /** The legacy `pending` boolean, used only where the column is unpopulated. */
  | "COMPATIBILITY_FLAG"
  /** Tombstone + successor evidence (a transition or a withdrawal). */
  | "TOMBSTONE_EVIDENCE"
  /** Nothing decisive. */
  | "NO_EVIDENCE";

/** The evidence one row carries. Field names mirror the Transaction columns. */
export interface LifecycleEvidence {
  /** Transaction.settlementState — "PENDING" | "POSTED" | null. */
  settlementState: string | null | undefined;
  /** Transaction.pending — the legacy boolean. Compatibility evidence only. */
  pending: boolean;
  /** Transaction.deletedAt — non-null means the row was removed/tombstoned. */
  deletedAt: Date | string | null | undefined;
  /**
   * True when a LIVE row carries `pendingTransactionRef = this.plaidTransactionId`
   * — i.e. this pending observation was superseded by a posted one. Caller
   * establishes it; absence is not evidence of absence, so `undefined` means
   * "not looked up" and is treated as unknown rather than false.
   */
  hasLivePostedSuccessor?: boolean;
}

export interface LifecycleResolution {
  state: LifecycleState;
  basis: LifecycleBasis;
  /**
   * True when this row is a SUPERSEDED observation of an event another live row
   * already represents. Such a row must never contribute to current state — that
   * is the whole double-count guard, expressed once, here.
   */
  superseded: boolean;
  /**
   * True when `settlementState` and the `pending` boolean actively disagree.
   * Zero rows in the corpus. The resolver prefers `settlementState` and says so.
   */
  columnsDisagree: boolean;
  /** One deterministic sentence. Never contains an amount or an account name. */
  explanation: string;
}

/**
 * Resolve one row's lifecycle. `settlementState` is the authority; the `pending`
 * boolean is consulted ONLY where the column is unpopulated, and the result says
 * which was used.
 */
export function resolveLifecycle(e: LifecycleEvidence): LifecycleResolution {
  const removed = e.deletedAt != null;
  const ss = e.settlementState ?? null;
  const columnsDisagree =
    (ss === "PENDING" && e.pending === false) || (ss === "POSTED" && e.pending === true);

  // ── Removed rows: the tombstone plus its successor IS the evidence ────────
  if (removed) {
    if (e.hasLivePostedSuccessor === true) {
      return {
        state: "POSTED",
        basis: "TOMBSTONE_EVIDENCE",
        // The EVENT posted; THIS row is the superseded pending observation of it.
        superseded: true,
        columnsDisagree,
        explanation: "This pending observation was replaced by a posted one; the event has posted.",
      };
    }
    if (e.hasLivePostedSuccessor === false) {
      return {
        state: "WITHDRAWN",
        basis: "TOMBSTONE_EVIDENCE",
        superseded: true,
        columnsDisagree,
        explanation: "The provider removed this pending movement without posting a replacement.",
      };
    }
    // Nobody looked for a successor — we decline to guess which it was.
    return {
      state: "UNKNOWN",
      basis: "NO_EVIDENCE",
      superseded: true,
      columnsDisagree,
      explanation: "This observation was removed; whether it posted or was withdrawn was not established.",
    };
  }

  // ── Live rows: the settlement column first ───────────────────────────────
  if (ss === "PENDING" || ss === "POSTED") {
    return {
      state: ss,
      basis: "SETTLEMENT_STATE",
      superseded: false,
      columnsDisagree,
      explanation: ss === "PENDING"
        ? "The provider reports this movement as pending."
        : "The provider reports this movement as posted.",
    };
  }

  // ── Unpopulated column: fall back to the legacy boolean, and SAY so ──────
  // Every such row in the corpus is a seed/manual import, not a provider row.
  return {
    state: e.pending ? "PENDING" : "POSTED",
    basis: "COMPATIBILITY_FLAG",
    superseded: false,
    columnsDisagree,
    explanation: e.pending
      ? "No settlement state was recorded; the legacy pending flag reports this movement as pending."
      : "No settlement state was recorded; the legacy pending flag reports this movement as posted.",
  };
}

/**
 * Does this row's lifecycle admit it to CURRENT-STATE pending evidence?
 *
 * PENDING and not superseded — nothing else. A posted row's effect is already
 * inside the provider's observed balance; a superseded row's effect is carried
 * by its successor; a withdrawn row's movement never happened. This is the one
 * predicate `loadPendingEvidence` consults, so "pending and posted cannot both
 * contribute" is enforced in exactly one place.
 */
export function contributesPendingEvidence(r: LifecycleResolution): boolean {
  return r.state === "PENDING" && !r.superseded;
}

/** User-facing wording. One place, so two surfaces cannot disagree. */
export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  PENDING:   "Pending",
  POSTED:    "Posted",
  WITHDRAWN: "Withdrawn",
  REVERSED:  "Reversed",
  UNKNOWN:   "Unknown",
};
