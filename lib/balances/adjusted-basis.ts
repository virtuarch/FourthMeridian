/**
 * lib/balances/adjusted-basis.ts   (v2.7-P0 — adjusted cash balance)
 *
 * The basis boundary of the adjusted-cash contract, and the ONE wording that
 * discloses it. Pure: no DB, no React, no clock — safe for client and server.
 *
 * Snapshot rows written BEFORE the release stored total cash / assets / net
 * worth on the provider-REPORTED ledger basis (they may count a pending
 * internal transfer in two accounts). Rows written from the release onward use
 * the ADJUSTED basis (lib/balances/account-balances.ts#adjustedDepositoryBalance).
 * Observed rows are immutable (frozen-row invariant) and no schema stamp is
 * authorised, so this date constant is the only marker of where the basis
 * changes. A chart window that spans it says so; nothing is rewritten.
 */

/**
 * The first UTC calendar day whose live snapshot row is written on the ADJUSTED
 * basis. Marks the RELEASE of the basis — set to the merge date (2026-10-27,
 * the owner-approval date; adjust in the merge commit if it lands later).
 */
export const ADJUSTED_CASH_BASIS_SINCE = "2026-10-27";

/** True when [fromISO, toISO] contains days on BOTH sides of the basis change. */
export function spansAdjustedCashBasis(fromISO: string | null | undefined, toISO: string | null | undefined): boolean {
  if (!fromISO || !toISO) return false;
  return fromISO.slice(0, 10) < ADJUSTED_CASH_BASIS_SINCE && toISO.slice(0, 10) >= ADJUSTED_CASH_BASIS_SINCE;
}

/** The disclosure sentence, or null when the window does not span the change. */
export function adjustedCashBasisNote(fromISO: string | null | undefined, toISO: string | null | undefined): string | null {
  if (!spansAdjustedCashBasis(fromISO, toISO)) return null;
  const since = new Date(`${ADJUSTED_CASH_BASIS_SINCE}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  return `From ${since}, cash is net of pending bank activity not yet deducted from the bank's balance; earlier points use bank-reported balances.`;
}
