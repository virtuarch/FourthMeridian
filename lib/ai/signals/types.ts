/**
 * lib/ai/signals/types.ts
 *
 * Signal type constants for the D4 Signals Engine.
 *
 * `SignalType` is an open string-constant object — not an enum — so that
 * future templates can add their own signal types (e.g. 'TRIP_BUDGET_EXCEEDED'
 * for a Travel Space) without modifying this file, following the same open
 * string pattern used for ContextDomain.
 *
 * Add new signal types here as new detectors are implemented. Every constant
 * must be unique — the registry does not enforce uniqueness at runtime so a
 * collision would silently allow two signals with the same type string.
 *
 * Implemented in D4 Slice 5:
 *   Transactions  — PENDING_CREDIT, PENDING_DEBIT, NEEDS_CLASSIFICATION (TI2-W2)
 *   Snapshot      — NET_WORTH_INCREASED, NET_WORTH_DECLINED
 *   Goals         — GOAL_COMPLETED
 *   Accounts      — STALE_CONNECTION, NEEDS_REAUTH
 */

export const SignalType = {
  // ── Transactions ─────────────────────────────────────────────────────────
  /** One or more incoming transactions are still pending settlement. */
  PENDING_CREDIT: 'PENDING_CREDIT',
  /** One or more outgoing transactions are still pending settlement. */
  PENDING_DEBIT: 'PENDING_DEBIT',
  /**
   * One or more transactions in the window genuinely need human classification
   * (TE-2B: payment-app movement of unknown purpose, or sign-default inflow with
   * no resolved source). Info by default; escalates to warning when the
   * unidentified-inflow share is material (MATERIAL_UNIDENTIFIED_INFLOW_SHARE).
   */
  NEEDS_CLASSIFICATION: 'NEEDS_CLASSIFICATION',

  // ── Snapshot ─────────────────────────────────────────────────────────────
  /** Net worth increased over the snapshot history window. */
  NET_WORTH_INCREASED: 'NET_WORTH_INCREASED',
  /** Net worth declined over the snapshot history window. */
  NET_WORTH_DECLINED: 'NET_WORTH_DECLINED',

  // ── Goals ────────────────────────────────────────────────────────────────
  /** A financial goal has been marked as completed. */
  GOAL_COMPLETED: 'GOAL_COMPLETED',

  // ── Accounts ─────────────────────────────────────────────────────────────
  /** One or more manually-entered accounts have not been updated in 30+ days. */
  STALE_CONNECTION: 'STALE_CONNECTION',
  /** One or more Plaid connections require the user to re-authenticate. */
  NEEDS_REAUTH: 'NEEDS_REAUTH',
} as const;

export type SignalType = typeof SignalType[keyof typeof SignalType];
