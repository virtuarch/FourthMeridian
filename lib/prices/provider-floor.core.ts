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
 * covers a span COMPLETELY (every page fetched, count reconciled) and the
 * corrected backward replay STILL lands on a positive unexplained opening —
 * units that existed before anything the corpus can explain — that opening must
 * predate the corpus. That makes earlier ownership POSSIBLE, never KNOWN,
 * because nothing dates the holding to those days.
 *
 * ── V26-PRICE-4C — a later BUY is not a disproof ─────────────────────────────
 * The first version refused any instrument carrying an acquiring event. That was
 * too strict: a BUY does not contradict an already-positive opening, it changes
 * the quantity from its own date forward. INTC (opening 4, BUY 1, observed 5)
 * and NVDA (opening 2.0001, fractional BUYs, observed 2.003) both reconcile
 * exactly against observations the walk never consumed.
 *
 * The blanket refusal is replaced by a STRONGER requirement — that the licensed
 * interval actually RESOLVE to the opening. See the anchor check below.
 *
 * ── What it deliberately will not do ─────────────────────────────────────────
 * It never licenses a date before the floor; never upgrades POSSIBLE to KNOWN;
 * never asserts a quantity (the corrected backward replay owns that); and
 * refuses outright wherever the inference could be wrong rather than merely
 * imprecise — a zero or negative opening, an unresolved corporate action, an
 * unresolved transfer, a conflicted or failed reconstruction, an opening that is
 * known but not yet readable, or a cash instrument.
 */

/** Every reason the inference may be refused. Reported, never silent. */
export type ProviderFloorRefusal =
  | "CASH_INSTRUMENT"
  | "NO_PROVIDER_FLOOR"
  | "NO_POSITIVE_OBSERVATION"
  | "TRANSFER_PRESENT"
  | "CORPORATE_ACTION_PRESENT"
  | "RECONSTRUCTION_FAILED"
  | "RECONSTRUCTION_CONFLICTED"
  | "NO_POSITIVE_OPENING"
  | "OPENING_ANCHOR_MISSING"
  | "FLOOR_NOT_EARLIER_THAN_DIRECT";

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
  hasTransfer:            boolean;
  hasCorporateAction:     boolean;
  /** From PositionReconstruction. Null when the pair was never reconstructed. */
  reconciliation:             "COMPLETE" | "PARTIAL" | "FAILED" | null;
  conflicted:                 boolean;
  openingQuantity:            number | null;
  unexplainedOpeningQuantity: number | null;
  /**
   * V26-PRICE-4C — the date an OPENING ANCHOR would occupy: the day before the
   * reconstruction's `earliestDefensibleDate`. Null when the pair was never
   * reconstructed. Supplied by the binding so this module stays free of date
   * arithmetic and of any reconstruction import.
   */
  openingAnchorDateISO: string | null;
  /** Whether that anchor row actually EXISTS (a DERIVED reconstruction row). */
  hasOpeningAnchor:     boolean;
  /**
   * Routed events behind this reconstruction. ZERO means there is no "before the
   * first event" interval at all: the walk is anchored directly on the observed
   * quantity, so `openingQuantity === anchorQuantity` BY CONSTRUCTION and
   * hold-constant from that observation already resolves the opening. No anchor
   * can be emitted, and none is needed. Null when never reconstructed.
   */
  eventCount: number | null;
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

  // Unresolved semantics — never guess across them.
  if (c.hasTransfer) return { licensed: false, reason: "TRANSFER_PRESENT" };
  if (c.hasCorporateAction) return { licensed: false, reason: "CORPORATE_ACTION_PRESENT" };

  // The reconstruction must have closed its own books well enough to speak.
  if (c.reconciliation === "FAILED" || c.reconciliation === null) {
    return { licensed: false, reason: "RECONSTRUCTION_FAILED" };
  }
  if (c.conflicted) return { licensed: false, reason: "RECONSTRUCTION_CONFLICTED" };

  // The corrected replay must state that units existed before its earliest
  // defensible date. A zero or negative opening states no such thing, and BOTH
  // the opening and its unexplained residue must say so — Group A reconstructs
  // COMPLETE with openingQuantity 0, which is a proven absence, not a gap.
  const opening = c.openingQuantity;
  const unexplained = c.unexplainedOpeningQuantity;
  if (
    opening === null || !Number.isFinite(opening) || opening <= OPENING_EPSILON ||
    unexplained === null || !Number.isFinite(unexplained) || unexplained <= OPENING_EPSILON
  ) {
    return { licensed: false, reason: "NO_POSITIVE_OPENING" };
  }

  // V26-PRICE-4C — THE OPENING MUST BE READABLE, NOT MERELY KNOWN.
  //
  // A later acquiring event does not disprove an already-positive opening; it
  // changes the quantity from its own date forward. So a BUY is no longer a
  // blanket refusal. What replaces it is a stronger test: the licensed interval
  // must actually RESOLVE to the opening quantity.
  //
  // It only does so when the reconstruction has published its opening anchor.
  // Without one, `holdConstantBeforeEarliest` carries the earliest existing row
  // backward — the POST-event quantity. Measured on the corpus, exactly the two
  // instruments this relaxation admits are the two where that differs: INTC
  // (opening 4 vs earliest row 5) and NVDA (2.0001 vs 2.0002). Licensing them
  // without the anchor would import a 25% over-statement for 91 days.
  //
  // So: where an anchor can legally exist (its date is on or after the floor),
  // it must exist. This makes the relaxation safe BY CONSTRUCTION rather than
  // safe-if-reconstruction-was-regenerated-first, and it self-heals — the
  // moment reconstruction runs, the anchor appears and licensing follows.
  //
  // Where an anchor CANNOT legally exist, the first supported event sits on the
  // floor itself. Then direct evidence is the floor, so the POSSIBLE interval is
  // empty and the refusal below fires anyway — no quantity earlier than the
  // floor event is ever required inside a licensed interval. JPM is that shape.
  //
  // An instrument with NO events is exempt: the walk anchors on the observation
  // itself, so the opening IS that observed quantity and hold-constant already
  // resolves it correctly. Requiring an anchor there would refuse a position
  // that was never at risk (SIRI, TTWO).
  const anchorCanExist =
    (c.eventCount ?? 0) > 0 &&
    c.openingAnchorDateISO !== null &&
    c.openingAnchorDateISO >= c.providerFloorISO;
  if (anchorCanExist && !c.hasOpeningAnchor) {
    return { licensed: false, reason: "OPENING_ANCHOR_MISSING" };
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
