/**
 * lib/snapshots/ownership-eligibility.core.ts
 *
 * V26-PRICE-5A — UNKNOWN OWNERSHIP PREHISTORY MUST NOT BE VALUED. Pure: no
 * Prisma, no network, no clock, no provider.
 *
 * ── The asymmetry this closes ────────────────────────────────────────────────
 * V26-PRICE-4 refuses to ACQUIRE prices for dates with no evidence of ownership:
 * "never fetch blind history". Regeneration nevertheless VALUED those same
 * dates, because A8 is invoked with `holdConstantBeforeEarliest: true`, which
 * projects an instrument's quantity backwards past its own earliest observation.
 *
 * The delta-attribution report measured the consequence: 402 of 705 updated days
 * were valued entirely before ANY ownership evidence, and all 705 had at least
 * one holding valued outside its own ownership window. The arithmetic was sound
 * every time — that was never the problem. The problem is that a portfolio was
 * being reported for periods with no reason to believe it was held.
 *
 * Both halves now obey one rule:
 *
 *   KNOWN     include normally
 *   POSSIBLE  include, and carry the inferred confidence forward — never silently
 *   UNKNOWN   EXCLUDE from valuation for that date
 *
 * ── The empty-portfolio trap ─────────────────────────────────────────────────
 * When every holding is excluded, the day must NOT become a zero-valued
 * portfolio. Zero is a claim — "you held nothing worth anything" — and it is a
 * fabrication when the truth is "we cannot say". `hasEligibleHoldings: false`
 * routes the day into the EXISTING no-fabrication guard in
 * regenerate-history.core.ts, which preserves the stored flat estimate and skips
 * the day rather than overwriting it with a number nobody can defend. No new
 * outcome is invented; an existing product semantic is reused.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { OwnershipResolution, OwnershipSegment } from "@/lib/prices/ownership-window.core";
import type { OwnershipConfidenceAxis } from "./price-completeness.core";

/**
 * One holding's contribution, reduced to what eligibility needs. Deliberately
 * structural rather than importing InstrumentValuation: this module must stay
 * usable from a fixture without constructing a full A8 view.
 */
export interface ValuedHolding {
  instrumentId:   string;
  /** Reporting-currency value, or null when A8 could not value it. */
  reportingValue: number | null;
}

export interface EligibilityResult {
  dateISO:             string;
  /** Ascending instrument ids included in the valuation. */
  includedInstrumentIds: string[];
  /** Ascending instrument ids excluded as UNKNOWN prehistory. */
  excludedInstrumentIds: string[];
  /** Σ reportingValue over INCLUDED holdings only. */
  valuedSubtotal:      number;
  /** Worst ownership confidence among INCLUDED holdings; UNKNOWN when none. */
  ownershipConfidence: OwnershipConfidenceAxis;
  /**
   * False when no holding survived. The caller MUST treat this as "no investment
   * evidence" and never as a zero-valued portfolio.
   */
  hasEligibleHoldings: boolean;
}

/**
 * Where `dateISO` falls relative to one instrument's ownership segments.
 *
 * A date inside a KNOWN segment is KNOWN; inside a POSSIBLE segment, POSSIBLE;
 * outside every segment — before the earliest evidence or after the ceiling —
 * UNKNOWN. An unresolved instrument (no evidence at all) is UNKNOWN everywhere.
 */
export function ownershipOn(
  dateISO:    string,
  resolution: OwnershipResolution | undefined,
): OwnershipConfidenceAxis {
  if (!resolution || resolution.kind !== "resolved") return "UNKNOWN";
  const within = (s: OwnershipSegment): boolean => dateISO >= s.fromISO && dateISO <= s.toISO;
  if (resolution.segments.some((s) => s.confidence === "KNOWN" && within(s))) return "KNOWN";
  if (resolution.segments.some((s) => s.confidence === "POSSIBLE" && within(s))) return "POSSIBLE";
  return "UNKNOWN";
}

/** The tier an ownership confidence alone justifies. */
export function ownershipTier(c: OwnershipConfidenceAxis): CompletenessTier {
  return c === "KNOWN" ? "observed" : c === "POSSIBLE" ? "estimated" : "unknown";
}

const CONFIDENCE_RANK: Record<OwnershipConfidenceAxis, number> = { KNOWN: 0, POSSIBLE: 1, UNKNOWN: 2 };

/**
 * Filter a date's holdings by ownership eligibility and recompute the subtotal.
 *
 * Deterministic: included and excluded ids are sorted, the subtotal is summed in
 * that sorted order, and the confidence is a rank maximum — never array order.
 *
 * A holding A8 could not value (`reportingValue === null`) contributes nothing
 * to the subtotal either way, but it is still classified: an unvalued holding in
 * UNKNOWN prehistory is excluded, so it cannot make the day look "covered".
 */
export function applyOwnershipEligibility(
  dateISO:     string,
  holdings:    readonly ValuedHolding[],
  ownershipBy: ReadonlyMap<string, OwnershipResolution>,
): EligibilityResult {
  const included: ValuedHolding[] = [];
  const excluded: string[] = [];
  let confidence: OwnershipConfidenceAxis = "KNOWN";
  let sawIncluded = false;

  for (const h of holdings) {
    const own = ownershipOn(dateISO, ownershipBy.get(h.instrumentId));
    if (own === "UNKNOWN") {
      // The whole point: no projection into prehistory, whatever quantity A8
      // resolved by holding constant before the earliest observation.
      excluded.push(h.instrumentId);
      continue;
    }
    included.push(h);
    if (!sawIncluded || CONFIDENCE_RANK[own] > CONFIDENCE_RANK[confidence]) {
      confidence = own;
      sawIncluded = true;
    }
  }

  const includedSorted = [...included].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));

  return {
    dateISO,
    includedInstrumentIds: includedSorted.map((h) => h.instrumentId),
    excludedInstrumentIds: [...excluded].sort(),
    valuedSubtotal:        includedSorted.reduce((n, h) => n + (h.reportingValue ?? 0), 0),
    ownershipConfidence:   sawIncluded ? confidence : "UNKNOWN",
    hasEligibleHoldings:   includedSorted.length > 0,
  };
}
