/**
 * lib/balances/reconciliation-labels.ts   (v2.6-L3)
 *
 * The user-facing wording for each reconciliation state. Kept in the authority,
 * not in components, so two surfaces cannot describe the same state differently.
 *
 * The wording deliberately does NOT dress a residual up as an error. An
 * unexplained hold is a normal, temporary fact about how banks work — the Amex
 * HYSA's $4,000 is real, the money is genuinely unavailable, and no transaction
 * has arrived to say why yet. Calling that "wrong" would train users to ignore a
 * signal that is usually benign; hiding it would be the defect this slice exists
 * to remove.
 */

import type { ReconciliationState } from "./account-balances";

export const RECONCILIATION_LABEL: Record<ReconciliationState, string> = {
  EXACT:                "Fully accounted for",
  PARTIALLY_ATTRIBUTED: "Partly unexplained",
  UNAVAILABLE:          "Cannot be checked",
  CONTRADICTORY:        "Provider disagrees",
};

/** One sentence per state, for a tooltip or a detail line. */
export const RECONCILIATION_DETAIL: Record<ReconciliationState, string> = {
  EXACT:
    "The observed balance and the institution's reported pending activity fully account for what is available.",
  PARTIALLY_ATTRIBUTED:
    "Some of this balance is unavailable and no transaction explains it yet. It is shown separately rather than folded into the total.",
  UNAVAILABLE:
    "The institution reported no figure to check against, so no reconciliation was attempted.",
  CONTRADICTORY:
    "The institution reports more available than the observed balance and pending activity support. The two disagree; neither has been adjusted to match the other.",
};
