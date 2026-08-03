/**
 * lib/prices/provider-floor.core.ts
 *
 * V26-PRICE-4B — PROVIDER-FLOOR OWNERSHIP LICENSING. Pure: no Prisma, no DB, no
 * clock, no network.
 *
 * ── What this decides ────────────────────────────────────────────────────────
 * ONE question, for one (account, instrument) pair: may the provider's
 * demonstrated corpus floor serve as an `earliestPossibleISO` bound?
 *
 * It is NOT a second ownership engine. `resolveOwnershipWindow` remains the only
 * thing that turns bounds into segments; this only decides whether one more
 * POSSIBLE bound may be offered to it, and never touches the DIRECT bound.
 *
 * ── The gap it closes ────────────────────────────────────────────────────────
 * The existing POSSIBLE bound is `LEAST(FinancialAccount.createdAt, first
 * Transaction)`. For a freshly connected brokerage that is the CONNECT DATE —
 * `createdAt` is when WE learned of the account, not when it existed — and
 * investment accounts carry no Transaction rows at all. So the bound collapses
 * onto the first observation and licenses nothing, which is why a position
 * demonstrably held and later sold reads as UNKNOWN prehistory for every day
 * before connection.
 *
 * The provider's own corpus says more than our ingestion date does. When it
 * covers a span COMPLETELY (every page fetched, count reconciled) and contains
 * NO acquiring event for an instrument that was nevertheless observed as held,
 * the acquisition must predate the corpus. That makes earlier ownership
 * POSSIBLE — never KNOWN, because nothing dates the holding to those days.
 *
 * ── What it deliberately will not do ─────────────────────────────────────────
 * It never licenses a date before the floor; never upgrades POSSIBLE to KNOWN;
 * never asserts a quantity (the corrected backward replay owns that); and
 * refuses outright wherever the inference could be wrong rather than merely
 * imprecise — a real acquisition, an unresolved corporate action, an unresolved
 * transfer, a conflicted or failed reconstruction, or a cash instrument.
 */

/** Every reason the inference may be refused. Reported, never silent. */
export type ProviderFloorRefusal =
  | "CASH_INSTRUMENT"
  | "NO_PROVIDER_FLOOR"
  | "NO_POSITIVE_OBSERVATION"
  | "ACQUIRING_EVENT_PRESENT"
  | "TRANSFER_PRESENT"
  | "CORPORATE_ACTION_PRESENT"
  | "RECONSTRUCTION_FAILED"
  | "RECONSTRUCTION_CONFLICTED"
  | "NO_UNEXPLAINED_OPENING"
  | "FLOOR_NOT_EARLIER_THAN_DIRECT";

/**
 * Event types that ACQUIRE units and would therefore date the holding. Their
 * presence means the corpus already explains where the position came from, so
 * nothing may be inferred before it.
 *
 * OPENING_BALANCE is included deliberately: a stated opening anchor IS the
 * answer to "when did this begin", so an inference must defer to it.
 */
export const ACQUIRING_EVENT_TYPES: readonly string[] = [
  "BUY", "TRANSFER_IN", "REINVESTMENT", "OPENING_BALANCE",
];

/** Corporate actions whose quantity transformation is not ratified. */
export const CORPORATE_ACTION_TYPES: readonly string[] = [
  "SPLIT", "MERGER", "SPIN_OFF", "SYMBOL_CHANGE",
];

/** Transfers — real quantity effects whose SIGN CONVENTION is unresolved. */
export const TRANSFER_TYPES: readonly string[] = ["TRANSFER_IN", "TRANSFER_OUT"];

/** The evidence the predicate reads. Structural — no Prisma types. */
export interface ProviderFloorCandidate {
  financialAccountId: string;
  instrumentId:       string;
  /**
   * MIN(earliestReturnedDate) over COMPLETE, pagination-reconciled coverage rows
   * for this account AND ONE continuous provider identity. Null when the account
   * has no such coverage — which refuses the inference outright.
   */
  providerFloorISO:   string | null;
  /** Earliest DIRECT evidence (observation or event) for the instrument. */
  earliestDirectISO:  string | null;
  /** A positive OBSERVED PositionObservation exists for this pair. */
  hasPositiveObservation: boolean;
  hasAcquiringEvent:      boolean;
  hasTransfer:            boolean;
  hasCorporateAction:     boolean;
  /** From PositionReconstruction. Null when the pair was never reconstructed. */
  reconciliation:             "COMPLETE" | "PARTIAL" | "FAILED" | null;
  conflicted:                 boolean;
  unexplainedOpeningQuantity: number | null;
  /** Cash is excluded wholesale — see the header of the binding. */
  isCashEquivalent: boolean;
}

export type ProviderFloorDecision =
  | { licensed: true;  possibleFromISO: string }
  | { licensed: false; reason: ProviderFloorRefusal };

/** Sub-share noise floor: an "unexplained opening" must be materially positive. */
export const OPENING_EPSILON = 1e-6;

/**
 * May the provider floor license POSSIBLE ownership for this pair?
 *
 * Every condition is REQUIRED. Order is chosen so the reported reason is the
 * most specific true one — cheap structural exclusions first, then evidence.
 *
 * Note the last check: a floor at or after the first direct evidence adds no
 * span. It is refused rather than returned, so a caller can never widen a
 * window by zero days and record that as an inference.
 */
export function licenseProviderFloor(c: ProviderFloorCandidate): ProviderFloorDecision {
  // Cash is not a security position; "no BUY" says nothing about it.
  if (c.isCashEquivalent) return { licensed: false, reason: "CASH_INSTRUMENT" };

  // The provider must have demonstrated a floor at all.
  if (c.providerFloorISO === null) return { licensed: false, reason: "NO_PROVIDER_FLOOR" };

  // Something must actually have been held.
  if (!c.hasPositiveObservation) return { licensed: false, reason: "NO_POSITIVE_OBSERVATION" };

  // The corpus already explains where the position came from.
  if (c.hasAcquiringEvent) return { licensed: false, reason: "ACQUIRING_EVENT_PRESENT" };

  // Unresolved semantics — never guess across them.
  if (c.hasTransfer) return { licensed: false, reason: "TRANSFER_PRESENT" };
  if (c.hasCorporateAction) return { licensed: false, reason: "CORPORATE_ACTION_PRESENT" };

  // The reconstruction must have closed its own books well enough to speak.
  if (c.reconciliation === "FAILED" || c.reconciliation === null) {
    return { licensed: false, reason: "RECONSTRUCTION_FAILED" };
  }
  if (c.conflicted) return { licensed: false, reason: "RECONSTRUCTION_CONFLICTED" };

  // The corrected replay must state that units existed before its earliest
  // defensible date. A zero or negative residue states no such thing.
  if (c.unexplainedOpeningQuantity === null || c.unexplainedOpeningQuantity <= OPENING_EPSILON) {
    return { licensed: false, reason: "NO_UNEXPLAINED_OPENING" };
  }

  // A floor that is not earlier than direct evidence widens nothing.
  if (c.earliestDirectISO !== null && c.providerFloorISO >= c.earliestDirectISO) {
    return { licensed: false, reason: "FLOOR_NOT_EARLIER_THAN_DIRECT" };
  }

  return { licensed: true, possibleFromISO: c.providerFloorISO };
}

/**
 * The earliest POSSIBLE bound an instrument may take, given the existing
 * account-activity bound and every licensed provider floor across the accounts
 * that hold it.
 *
 * The provider floor can only ever make the bound EARLIER, and only as early as
 * the floor itself. It never narrows an existing bound derived from other
 * evidence (a wallet's own transaction history, say), and it never reaches past
 * any floor it was given.
 */
export function earliestPossibleBound(
  existingPossibleISO: string | null,
  licensedFloors: readonly string[],
): string | null {
  const all = [
    ...(existingPossibleISO === null ? [] : [existingPossibleISO]),
    ...licensedFloors,
  ];
  if (all.length === 0) return null;
  return all.reduce((min, d) => (d < min ? d : min));
}
