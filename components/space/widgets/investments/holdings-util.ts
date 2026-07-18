/**
 * components/space/widgets/investments/holdings-util.ts
 *
 * Shared, pure helpers for the Holdings domain components (HoldingsLedger /
 * HoldingsConcentration / HoldingDetail) so there is ONE definition of a holding's
 * identity key, its native cost basis access, and its trust-mark presentation. No
 * React, no I/O.
 */

import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/** Stable per-row identity across grid ↔ detail navigation (instrument × account). */
export function rowKey(row: ValuedHoldingRow): string {
  return `${row.instrumentId}:${row.accountId}`;
}

/** Native-currency aggregate cost basis — present only on current-view rows (Plaid). */
export function costBasisOf(row: ValuedHoldingRow): number | null {
  const cb = (row as { costBasis?: number | null }).costBasis;
  return cb == null ? null : cb;
}

export const TIER_LABEL: Record<CompletenessTier, string> = {
  observed: "Observed", derived: "Derived", estimated: "Estimated", incomplete: "Incomplete", unknown: "Unknown",
};

/** Dot colour for a non-observed overall tier. Observed rows render no dot. */
export function tierDotColor(tier: CompletenessTier): string {
  switch (tier) {
    case "derived":   return "var(--accent-info, #60a5fa)";
    case "estimated": return "var(--accent-warning, #f59e0b)";
    case "incomplete":
    case "unknown":   return "var(--accent-danger, #ef4444)";
    default:          return "var(--text-faint)";
  }
}

export function isInstitutionBasis(basis: ValuedHoldingRow["basisUsed"]): boolean {
  return basis === "institution-value" || basis === "institution-price";
}

/** Display label for a row (symbol → name → id). */
export function rowLabel(row: ValuedHoldingRow): string {
  return row.symbol ?? row.name ?? row.instrumentId;
}
