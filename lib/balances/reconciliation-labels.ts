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
