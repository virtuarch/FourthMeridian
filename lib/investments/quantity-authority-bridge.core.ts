/**
 * lib/investments/quantity-authority-bridge.core.ts
 *
 * V26-QUANTITY-1G — the pure decision that stands between the quantity
 * authority and historical valuation. No Prisma, no network, no clock.
 *
 * ── The only question this module answers ───────────────────────────────────
 *
 * "On this date, for this position, does the authority know the quantity well
 * enough to value money with it?"
 *
 * The bar is deliberately higher than "the authority said something". A
 * QuantityTimeline reports several grades of knowledge — an interval it
 * replayed, a point it observed, movement without a level, an interval it
 * refuses to speak for — and only the first two are quantities. The rest are
 * descriptions of ignorance, and valuing them would reintroduce exactly the
 * fabrication the arc removed.
 *
 * Everything else falls back to the legacy resolver, WITH A REASON. A silent
 * fallback would make the comparison report a measure of nothing: "the numbers
 * agree" is only meaningful alongside "and here is how often the authority was
 * allowed to speak at all".
 */

import type { QuantityTimeline, QuantityTimelineSegment } from "./quantity-replay.core";

/** Why the legacy resolver was used on a given date. Declaration order = report order. */
export const FALLBACK_REASONS = [
  "AUTHORITY_DISABLED",
  "NO_TIMELINE_FOR_PAIR",
  "DATE_OUTSIDE_TIMELINE_WINDOW",
  "TIMELINE_UNREPLAYABLE",
  "DATE_UNCOVERED",
  "DATE_UNRESOLVED",
  "DATE_RELATIVE_ONLY",
  "NO_ABSOLUTE_SEGMENT_COVERS_DATE",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface AuthorityQuantity {
  source:          "AUTHORITY";
  quantity:        number;
  basis:           "OBSERVED_ANCHOR" | "REPLAYED" | "REPLAYED_BACKWARD";
  segmentFromISO:  string;
  segmentToISO:    string;
  /** Point evidence proves ONE date; an interval claim was licensed by coverage. */
  shape:           "POINT" | "INTERVAL";
  /**
   * Carried through for inspection, NOT used as a gate — see `decideQuantity`.
   * `TIE_BROKEN` here means the sequence came from a deterministic key rather
   * than a timestamp, on a day where the sequence was proven not to matter.
   */
  orderCertainty:  "KNOWN" | "TIE_BROKEN";
  derivedFrom:     string[];
}

export interface LegacyFallback {
  source: "LEGACY";
  reason: FallbackReason;
  detail: string;
}

export type QuantityDecision = AuthorityQuantity | LegacyFallback;

/**
 * Decide for one (pair, date).
 *
 * "Sufficiently supported" means ALL of:
 *   1. a timeline exists for the pair;
 *   2. the date lies inside the timeline's requested window;
 *   3. the date is not in an uncovered interval;
 *   4. no UNRESOLVED segment covers the date;
 *   5. an ABSOLUTE segment covers the date.
 *
 * `orderCertainty` is deliberately NOT a gate, and that took a fixture to get
 * right. The first draft required `KNOWN`, reasoning that a tie-broken order is
 * reproducible rather than correct. But QUANTITY-1B marks certainty from
 * PROVENANCE — a real datetime — and Plaid's investment transactions are
 * date-only, so essentially every replayed segment is `TIE_BROKEN`. The gate
 * would have silenced the authority on every Plaid-sourced position while
 * buying no correctness, because order-sensitivity is already caught upstream:
 * a day mixing a ratio with a delta and no timestamps becomes
 * ORDER_SENSITIVE_UNRESOLVED and yields an UNRESOLVED segment, never an
 * absolute one. By the time an ABSOLUTE segment exists, its quantity has been
 * proven independent of the tie-break — either the day was evidenced, or it was
 * commutative, or replay stopped.
 */
export function decideQuantity(
  timeline: QuantityTimeline | null | undefined,
  dateISO: string,
): QuantityDecision {
  if (!timeline) {
    return { source: "LEGACY", reason: "NO_TIMELINE_FOR_PAIR",
      detail: "the authority holds no timeline for this account/instrument" };
  }
  if (dateISO < timeline.windowFromISO || dateISO > timeline.windowToISO) {
    return { source: "LEGACY", reason: "DATE_OUTSIDE_TIMELINE_WINDOW",
      detail: `date is outside ${timeline.windowFromISO}→${timeline.windowToISO}` };
  }
  if (timeline.summary === "UNREPLAYABLE") {
    return { source: "LEGACY", reason: "TIMELINE_UNREPLAYABLE",
      detail: "no segment of any kind was produced" };
  }

  const uncovered = timeline.uncovered.find((u) => u.fromISO <= dateISO && u.toISO >= dateISO);
  if (uncovered) {
    return { source: "LEGACY", reason: "DATE_UNCOVERED",
      detail: `no segment speaks for ${uncovered.fromISO}→${uncovered.toISO} (${uncovered.reason})` };
  }

  const covering = timeline.segments.filter((s) => s.fromISO <= dateISO && s.toISO >= dateISO);
  const unresolved = covering.find((s) => s.kind === "UNRESOLVED");
  if (unresolved && unresolved.kind === "UNRESOLVED") {
    return { source: "LEGACY", reason: "DATE_UNRESOLVED",
      detail: `exact replay is blocked here (${unresolved.reason})` };
  }

  const absolute = covering.find((s): s is Extract<QuantityTimelineSegment, { kind: "ABSOLUTE" }> =>
    s.kind === "ABSOLUTE");
  if (!absolute) {
    const relative = covering.find((s) => s.kind === "RELATIVE");
    if (relative) {
      return { source: "LEGACY", reason: "DATE_RELATIVE_ONLY",
        detail: "movement is known here, but no level — a delta is not a holding" };
    }
    return { source: "LEGACY", reason: "NO_ABSOLUTE_SEGMENT_COVERS_DATE",
      detail: "the date is inside the window but no absolute claim reaches it" };
  }

  return {
    source: "AUTHORITY",
    quantity: absolute.quantity,
    basis: absolute.basis,
    segmentFromISO: absolute.fromISO,
    segmentToISO: absolute.toISO,
    shape: absolute.fromISO === absolute.toISO ? "POINT" : "INTERVAL",
    orderCertainty: absolute.orderCertainty,
    derivedFrom: absolute.derivedFrom,
  };
}

// ── Comparison ───────────────────────────────────────────────────────────────

export type ComparisonVerdict =
  /** Both produced a quantity and they match within tolerance. */
  | "AGREE"
  /** Both produced a quantity and they differ. */
  | "DISAGREE"
  /** The authority is confident where the legacy resolver held nothing. */
  | "AUTHORITY_ONLY"
  /** The legacy resolver produced a quantity the authority will not support. */
  | "LEGACY_ONLY"
  /** Neither holds a position here. */
  | "BOTH_ABSENT"
  /** The authority declined; the legacy value stands unexamined. */
  | "NOT_COMPARED";

export interface ComparisonRow {
  dateISO:            string;
  financialAccountId: string;
  instrumentId:       string;
  legacyQuantity:     number | null;
  authorityQuantity:  number | null;
  /** Present whenever the authority declined. */
  fallbackReason:     FallbackReason | null;
  shape:              "POINT" | "INTERVAL" | null;
  verdict:            ComparisonVerdict;
  delta:              number | null;
}

const DEFAULT_TOLERANCE = 1e-9;

/**
 * Classify one comparison.
 *
 * `LEGACY_ONLY` is the row type that matters most: it is the legacy resolver
 * asserting a holding the authority declines to support, which is precisely the
 * surface the arc set out to measure. It is reported, never suppressed.
 */
export function compareQuantities(args: {
  dateISO: string;
  financialAccountId: string;
  instrumentId: string;
  legacyQuantity: number | null;
  decision: QuantityDecision;
  tolerance?: number;
}): ComparisonRow {
  const tol = args.tolerance ?? DEFAULT_TOLERANCE;
  const legacy = args.legacyQuantity;
  const authority = args.decision.source === "AUTHORITY" ? args.decision.quantity : null;
  const fallbackReason = args.decision.source === "LEGACY" ? args.decision.reason : null;
  const shape = args.decision.source === "AUTHORITY" ? args.decision.shape : null;

  let verdict: ComparisonVerdict;
  let delta: number | null = null;
  if (authority !== null && legacy !== null) {
    delta = authority - legacy;
    verdict = Math.abs(delta) <= tol ? "AGREE" : "DISAGREE";
  } else if (authority !== null) {
    verdict = "AUTHORITY_ONLY";
  } else if (legacy !== null && fallbackReason !== null) {
    verdict = "LEGACY_ONLY";
  } else if (legacy === null && fallbackReason !== null) {
    verdict = "NOT_COMPARED";
  } else {
    verdict = "BOTH_ABSENT";
  }

  return {
    dateISO: args.dateISO, financialAccountId: args.financialAccountId,
    instrumentId: args.instrumentId, legacyQuantity: legacy, authorityQuantity: authority,
    fallbackReason, shape, verdict, delta,
  };
}

/**
 * Which quantity valuation should USE, given the mode.
 *
 * `compare` deliberately returns the legacy value: a comparison that changes
 * the thing it measures is not a comparison. Only `adopt` lets the authority
 * move money, and even then only where `decideQuantity` said yes.
 */
export type QuantityAuthorityMode = "off" | "compare" | "adopt";

export function quantityToUse(
  mode: QuantityAuthorityMode,
  legacyQuantity: number | null,
  decision: QuantityDecision,
): { quantity: number | null; usedAuthority: boolean; excluded: boolean } {
  if (mode !== "adopt") {
    return { quantity: legacyQuantity, usedAuthority: false, excluded: false };
  }
  if (decision.source === "AUTHORITY") {
    return { quantity: decision.quantity, usedAuthority: true, excluded: false };
  }
  // V26-INVESTMENTS-HISTORY — `adopt` EXCLUDES rather than falling back.
  //
  // Falling back looked conservative and was not: it let TQQQ contribute −20
  // shares and −$1,054.40 of fabricated short to an asserted portfolio total,
  // purely because its split carries a null ratio. A quantity the authority
  // will not support must leave the total and be declared, not be quietly
  // replaced by the legacy carry-forward the arc exists to retire.
  //
  // The legacy value stays in the decision ledger for comparison tooling; it
  // just no longer reaches a user-visible number.
  return { quantity: null, usedAuthority: false, excluded: true };
}
