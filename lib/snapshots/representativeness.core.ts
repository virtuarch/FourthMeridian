/**
 * lib/snapshots/representativeness.core.ts
 *
 * V26-PRICE-5B — is a regenerated snapshot REPRESENTATIVE of the portfolio it
 * claims to describe? Pure: no Prisma, no network, no clock.
 *
 * ── Why coverage, not magnitude ──────────────────────────────────────────────
 * The V26-PRICE-5A doctrine excludes holdings with UNKNOWN ownership, which left
 * days valuing one evidenced position while excluding a dozen others. The
 * tempting fix is a materiality floor — "skip the day if the eligible value is a
 * negligible fraction of the excluded value". That is the wrong instrument.
 *
 * A value threshold answers "is this number big enough to bother with", which is
 * not the question. The question is "does the set we valued REPRESENT the set we
 * believe existed". A day valuing one holding out of fourteen is unrepresentative
 * whether that holding is worth $11 or $11,000, and a day valuing all fourteen is
 * representative even if the portfolio is tiny. Magnitude and representativeness
 * are independent, and conflating them would make the assessment move when prices
 * move — a classification that changes because the market changed is describing
 * the market, not the evidence.
 *
 * So this module counts EVIDENCE and never reads a value. It is derived entirely
 * from axes that already exist (ownership eligibility from PRICE-5A, price
 * coverage from PRICE-2), invents no new heuristic, and introduces no threshold
 * on money.
 *
 * ── It must not alter arithmetic ─────────────────────────────────────────────
 * This is an ASSESSMENT. It changes no valuation, no total, no write decision.
 * It exists to inform regeneration policy and future reporting surfaces — a
 * NON_REPRESENTATIVE day is still computed exactly as the doctrine says; the
 * label simply says how much of the portfolio that computation actually saw.
 */

/** Ratios are reported as integer numerator/denominator — never a formatted float. */
export interface EvidenceRatio {
  covered: number;
  total:   number;
}

export type Representativeness = "REPRESENTATIVE" | "PARTIAL" | "NON_REPRESENTATIVE";

/** Declaration order IS emission order. */
export const REPRESENTATIVENESS_REASONS = [
  "NO_HOLDINGS_SURFACED",
  "NO_ELIGIBLE_HOLDINGS",
  "NO_MARKET_HOLDINGS",
  "HOLDINGS_EXCLUDED",
  "PRICE_GAP",
  "OWNERSHIP_INFERRED",
] as const;
export type RepresentativenessReason = (typeof REPRESENTATIVENESS_REASONS)[number];

/**
 * One holding's evidence status for a date, reduced to the three facts that
 * decide representativeness. Deliberately booleans and enums — no money.
 */
export interface HoldingEvidence {
  instrumentId: string;
  /** KNOWN or POSSIBLE ownership on this date (i.e. survived PRICE-5A exclusion). */
  eligible:     boolean;
  /** Ownership is inferred rather than directly evidenced. */
  inferred:     boolean;
  /** This holding is market-priced at all (a cash position is not). */
  marketPriced: boolean;
  /** A usable price reached this date for this holding. */
  priced:       boolean;
}

export interface RepresentativenessAssessment {
  dateISO:            string;
  representativeness: Representativeness;
  /** Eligible market holdings over all surfaced market holdings. */
  ownershipCoverage:  EvidenceRatio;
  /** Priced over eligible market holdings. */
  priceCoverage:      EvidenceRatio;
  /** Market holdings excluded as UNKNOWN ownership. */
  excludedCount:      number;
  /** Eligible market holdings whose ownership is inferred rather than evidenced. */
  inferredCount:      number;
  reasons:            RepresentativenessReason[];
}

/**
 * Classify a date by how much of its portfolio the valuation actually saw.
 *
 *   REPRESENTATIVE      every surfaced market holding was eligible AND priced
 *   PARTIAL             at least one market holding was valued, but not all
 *   NON_REPRESENTATIVE  no market holding was valued at all
 *
 * Cash positions are excluded from every ratio: they are always "owned" and
 * never market-priced, so counting them would let a cash balance alone make a
 * day look represented — the precise failure this assessment must catch.
 *
 * Deterministic: counts only, evaluated in a fixed order, reasons emitted by
 * filtering the declared tuple. Identical evidence ⇒ identical output.
 */
export function assessRepresentativeness(
  dateISO:  string,
  holdings: readonly HoldingEvidence[],
): RepresentativenessAssessment {
  const reasons = new Set<RepresentativenessReason>();

  const market         = holdings.filter((h) => h.marketPriced);
  const eligibleMarket = market.filter((h) => h.eligible);
  const pricedEligible = eligibleMarket.filter((h) => h.priced);
  const excludedCount  = market.length - eligibleMarket.length;
  const inferredCount  = eligibleMarket.filter((h) => h.inferred).length;

  if (holdings.length === 0)      reasons.add("NO_HOLDINGS_SURFACED");
  if (market.length === 0 && holdings.length > 0) reasons.add("NO_MARKET_HOLDINGS");
  if (market.length > 0 && eligibleMarket.length === 0) reasons.add("NO_ELIGIBLE_HOLDINGS");
  if (excludedCount > 0)          reasons.add("HOLDINGS_EXCLUDED");
  if (pricedEligible.length < eligibleMarket.length) reasons.add("PRICE_GAP");
  if (inferredCount > 0)          reasons.add("OWNERSHIP_INFERRED");

  const representativeness: Representativeness =
    pricedEligible.length === 0
      ? "NON_REPRESENTATIVE"
      : excludedCount === 0 && pricedEligible.length === market.length
        ? "REPRESENTATIVE"
        : "PARTIAL";

  return {
    dateISO,
    representativeness,
    ownershipCoverage: { covered: eligibleMarket.length, total: market.length },
    priceCoverage:     { covered: pricedEligible.length, total: eligibleMarket.length },
    excludedCount,
    inferredCount,
    reasons: REPRESENTATIVENESS_REASONS.filter((r) => reasons.has(r)),
  };
}

/** Tally a window's assessments. Deterministic; counts only. */
export function summariseRepresentativeness(
  assessments: readonly RepresentativenessAssessment[],
): Record<Representativeness, number> {
  return {
    REPRESENTATIVE:     assessments.filter((a) => a.representativeness === "REPRESENTATIVE").length,
    PARTIAL:            assessments.filter((a) => a.representativeness === "PARTIAL").length,
    NON_REPRESENTATIVE: assessments.filter((a) => a.representativeness === "NON_REPRESENTATIVE").length,
  };
}
