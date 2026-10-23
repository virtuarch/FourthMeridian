/**
 * lib/snapshots/price-completeness.core.ts
 *
 * V26-PRICE-5 — how good is a day's number, and why. Pure: no Prisma, no
 * network, no clock.
 *
 * ── Three axes, kept independent ─────────────────────────────────────────────
 * A snapshot can be wrong for three unrelated reasons, and collapsing them to a
 * single tier at the point of measurement destroys the only information that
 * says what to FIX:
 *
 *   PRICE COVERAGE       did we have a price for every expected date?      (PRICE-2)
 *   OWNERSHIP CONFIDENCE was the holding evidenced, or merely possible?    (PRICE-4)
 *   QUANTITY CONFIDENCE  was the quantity reconstructed, or today's held constant?
 *
 * They are recorded separately per instrument, aggregated separately, and only
 * THEN reduced to one `CompletenessTier`. A day whose prices are perfect and
 * whose quantities are projected backwards is not "mostly observed" — it is
 * estimated for a reason that buying more prices will never fix.
 *
 * ── The rule that matters ────────────────────────────────────────────────────
 * A day is `observed` only when ALL THREE axes are clean. Complete price
 * coverage alone can never promote a snapshot to observed while quantities are
 * back-projected or ownership is inferred. This is the guard against a correct
 * price series making a wrong number look trustworthy — the specific failure
 * this arc must not produce on its way to fixing the investment table.
 *
 * The reduction is one-way and late: `axes` survives on the result, so a caller
 * that needs to know WHICH holding degraded a day still can.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import { worstTier } from "@/lib/perspective-engine/completeness";

// ── The three axes ───────────────────────────────────────────────────────────

/** Price evidence for one instrument over the day's requirement. */
export type PriceCoverageAxis =
  /** Every expected date is archived. */
  | "COMPLETE"
  /** Some expected dates are missing but obtainable. */
  | "PARTIAL"
  /** Missing dates lie below provider depth — no run can close them. */
  | "UNREACHABLE"
  /** No price evidence at all for this instrument. */
  | "NONE";

/** How well the HOLDING itself is evidenced (V26-PRICE-4 segments). */
export type OwnershipConfidenceAxis =
  /** Directly evidenced by a position or event on/before this date. */
  | "KNOWN"
  /** The account was active; ownership is inferred, not evidenced. */
  | "POSSIBLE"
  /** No evidence either way. */
  | "UNKNOWN";

/** How the quantity used for this date was obtained. */
export type QuantityConfidenceAxis =
  /** Reconstructed from events/observations dated on or before this date. */
  | "RECONSTRUCTED"
  /**
   * Today's quantity held constant backwards. Honest for a holdings-only
   * provider, and NEVER observed truth — the open dependency on QUANTITY-1.
   */
  | "BACK_PROJECTED"
  /** No quantity evidence. */
  | "UNKNOWN";

export interface InstrumentEvidenceAxes {
  instrumentId:        string;
  priceCoverage:       PriceCoverageAxis;
  ownershipConfidence: OwnershipConfidenceAxis;
  quantityConfidence:  QuantityConfidenceAxis;
}

/** Coded, stable, emitted in declaration order — never discovery order. */
export const EVIDENCE_REASONS = [
  "NO_INSTRUMENT_EVIDENCE",
  "PRICE_COVERAGE_NONE",
  "PRICE_COVERAGE_UNREACHABLE",
  "PRICE_COVERAGE_PARTIAL",
  "OWNERSHIP_INFERRED",
  "OWNERSHIP_UNKNOWN",
  "QUANTITY_BACK_PROJECTED",
  "QUANTITY_UNKNOWN",
] as const;
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];

export interface SnapshotEvidenceSummary {
  /** Worst price coverage across contributing instruments. */
  priceCoverage:       PriceCoverageAxis;
  /** Worst ownership confidence across contributing instruments. */
  ownershipConfidence: OwnershipConfidenceAxis;
  /** Worst quantity confidence across contributing instruments. */
  quantityConfidence:  QuantityConfidenceAxis;
  /** Derived from all three, never from one. */
  tier:                CompletenessTier;
  /** True unless every axis is clean. Mirrors SpaceSnapshot.isEstimated. */
  isEstimated:         boolean;
  reasons:             EvidenceReason[];
}

export interface SnapshotEvidence {
  dateISO: string;
  /** PRESERVED per instrument — the summary never replaces it. */
  axes:    InstrumentEvidenceAxes[];
  summary: SnapshotEvidenceSummary;
}

// ── Axis ordering (worst wins) ───────────────────────────────────────────────

const PRICE_RANK: Record<PriceCoverageAxis, number> = {
  COMPLETE: 0, PARTIAL: 1, UNREACHABLE: 2, NONE: 3,
};
const OWNERSHIP_RANK: Record<OwnershipConfidenceAxis, number> = {
  KNOWN: 0, POSSIBLE: 1, UNKNOWN: 2,
};
const QUANTITY_RANK: Record<QuantityConfidenceAxis, number> = {
  RECONSTRUCTED: 0, BACK_PROJECTED: 1, UNKNOWN: 2,
};

function worstBy<T extends string>(values: readonly T[], rank: Record<T, number>, fallback: T): T {
  let out = fallback;
  for (const v of values) if (rank[v] > rank[out]) out = v;
  return out;
}

/** The tier this axis alone would justify. Reduced only after all three exist. */
function priceTier(a: PriceCoverageAxis): CompletenessTier {
  return a === "COMPLETE" ? "observed" : a === "NONE" ? "incomplete" : "estimated";
}
function ownershipTier(a: OwnershipConfidenceAxis): CompletenessTier {
  return a === "KNOWN" ? "observed" : a === "POSSIBLE" ? "estimated" : "unknown";
}
function quantityTier(a: QuantityConfidenceAxis): CompletenessTier {
  return a === "RECONSTRUCTED" ? "observed" : a === "BACK_PROJECTED" ? "estimated" : "unknown";
}

/**
 * Reduce per-instrument axes to a day's evidence summary.
 *
 * Deterministic: axes are aggregated by declared rank (never array order),
 * reasons are emitted by filtering EVIDENCE_REASONS, and the returned object is
 * a single literal with every key present.
 *
 * With NO contributing instruments the day is `unknown`, not `observed` — an
 * empty set is an absence of evidence, never a clean bill of health.
 */
export function summariseSnapshotEvidence(
  dateISO: string,
  axes:    readonly InstrumentEvidenceAxes[],
): SnapshotEvidence {
  const reasons = new Set<EvidenceReason>();

  if (axes.length === 0) {
    reasons.add("NO_INSTRUMENT_EVIDENCE");
    return {
      dateISO,
      axes: [],
      summary: {
        priceCoverage:       "NONE",
        ownershipConfidence: "UNKNOWN",
        quantityConfidence:  "UNKNOWN",
        tier:                "unknown",
        isEstimated:         true,
        reasons:             EVIDENCE_REASONS.filter((r) => reasons.has(r)),
      },
    };
  }

  const priceCoverage       = worstBy(axes.map((a) => a.priceCoverage), PRICE_RANK, "COMPLETE");
  const ownershipConfidence = worstBy(axes.map((a) => a.ownershipConfidence), OWNERSHIP_RANK, "KNOWN");
  const quantityConfidence  = worstBy(axes.map((a) => a.quantityConfidence), QUANTITY_RANK, "RECONSTRUCTED");

  if (priceCoverage === "NONE")            reasons.add("PRICE_COVERAGE_NONE");
  if (priceCoverage === "UNREACHABLE")     reasons.add("PRICE_COVERAGE_UNREACHABLE");
  if (priceCoverage === "PARTIAL")         reasons.add("PRICE_COVERAGE_PARTIAL");
  if (ownershipConfidence === "POSSIBLE")  reasons.add("OWNERSHIP_INFERRED");
  if (ownershipConfidence === "UNKNOWN")   reasons.add("OWNERSHIP_UNKNOWN");
  if (quantityConfidence === "BACK_PROJECTED") reasons.add("QUANTITY_BACK_PROJECTED");
  if (quantityConfidence === "UNKNOWN")    reasons.add("QUANTITY_UNKNOWN");

  // The reduction happens HERE and only here — after all three axes exist and
  // remain available on `axes` for any caller that needs the detail.
  const tier = worstTier([
    priceTier(priceCoverage),
    ownershipTier(ownershipConfidence),
    quantityTier(quantityConfidence),
  ]);

  return {
    dateISO,
    axes: [...axes].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)),
    summary: {
      priceCoverage,
      ownershipConfidence,
      quantityConfidence,
      tier,
      isEstimated: tier !== "observed",
      reasons:     EVIDENCE_REASONS.filter((r) => reasons.has(r)),
    },
  };
}

/**
 * Whether this day may be presented as fully observed truth.
 *
 * Exported as its own predicate because the temptation it guards against is
 * specific and recurring: complete price coverage feels like completeness. It is
 * one axis of three, and a snapshot built on back-projected quantities is not
 * observed no matter how perfect its prices are.
 */
export function mayClaimObserved(summary: SnapshotEvidenceSummary): boolean {
  return summary.priceCoverage === "COMPLETE"
    && summary.ownershipConfidence === "KNOWN"
    && summary.quantityConfidence === "RECONSTRUCTED";
}
