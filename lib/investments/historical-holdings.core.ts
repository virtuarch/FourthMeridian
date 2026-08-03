/**
 * lib/investments/historical-holdings.core.ts
 *
 * V26-S2-OWNERSHIP — WHAT DID THIS PORTFOLIO ACTUALLY HOLD ON THIS DATE?
 *
 * Pure: no Prisma, no DB, no clock, no network, no prices.
 *
 * ── The single question, and why it needed its own authority ─────────────────
 * Every consumer that shows historical composition — the coverage label, the
 * allocation ring, a future chart drill-down, an export, an AI summary — needs
 * the same set: the holdings that EXISTED on a date. Until now nobody produced
 * that set, so each consumer inferred it from whatever it happened to have:
 *
 *   · the coverage label divided by "every component the valuation produced",
 *     which with `holdConstantBeforeEarliest` is every pair the account has EVER
 *     observed. Measured live: `12 of 19` on 2026-01-01, where 6 of those 19
 *     were positions the engine itself had already refused as unowned, and one
 *     more was unvalued. The honest reading is `12 of 13`.
 *   · closed positions left that denominator only because the valuation binding
 *     skips an explicit zero quantity — a different mechanism, in a different
 *     file, that says nothing about ownership.
 *   · nothing could answer "when did ownership begin / end" at all.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * A holding is HELD on a date because historical evidence licenses it on that
 * date. Not because it exists today.
 *
 *   KNOWN     directly evidenced on this date          → held
 *   POSSIBLE  the container was active; inferred        → held, and said so
 *   UNKNOWN   no evidence either way                    → NOT held
 *   CLOSED    proven not-held (an observed zero)        → NOT held
 *
 * The denominator is the HELD set. That is the entire point: a count of what
 * existed, never a count of what exists now. It rises when positions are
 * acquired, falls when they are sold, and reaches zero for a date before the
 * portfolio began — and reaching zero is a correct answer, not a failure.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * It does not value anything, price anything, or decide a quantity. Those are
 * the valuation engine's, and duplicating any of them here would create the
 * second engine this arc exists to remove. It receives components that engine
 * already produced and answers one question about each.
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { OwnershipResolution, OwnershipSegment } from "@/lib/prices/ownership-window.core";
import type { OwnershipConfidenceAxis } from "@/lib/snapshots/price-completeness.core";

/** Why a holding is not in the held set. Coded, never free text. */
export const HOLDING_EXCLUSION_REASONS = [
  /** No ownership evidence reaches this date — prehistory. */
  "OWNERSHIP_UNKNOWN",
  /** An observation proves the position was closed on or before this date. */
  "OWNERSHIP_CLOSED",
  /** The pair has no ownership resolution at all (no evidence of any kind). */
  "NO_OWNERSHIP_EVIDENCE",
] as const;
export type HoldingExclusionReason = (typeof HOLDING_EXCLUSION_REASONS)[number];

/**
 * One component as the valuation engine produced it, reduced to what ownership
 * needs. Structural rather than importing InstrumentValuation, so this fixture-
 * tests without constructing a full view — the ownership-eligibility precedent.
 */
export interface HoldingComponent {
  financialAccountId: string;
  instrumentId:       string;
  /** The quantity the valuation engine resolved; null when it had none. */
  quantity:           number | null;
  /** Reporting-currency value, or null when it could not be valued. */
  reportingValue:     number | null;
  /** The valuation engine's own tier for this component. */
  tier:               CompletenessTier;
  /** The valuation engine's own explanation (price miss, refusal, basis). */
  reason:             string;
}

/** A holding that EXISTED on the date, with the evidence that says so. */
export interface HeldHolding extends HoldingComponent {
  ownership:        Exclude<OwnershipConfidenceAxis, "UNKNOWN">;
  /** When the licensing segment began / ends. Answers "since when / until when". */
  ownershipFromISO: string;
  ownershipToISO:   string;
  /** True when the engine produced a value for it on this date. */
  valued:           boolean;
}

/** A component that did NOT exist on the date, and why. */
export interface ExcludedHolding extends HoldingComponent {
  reasonCode: HoldingExclusionReason;
  /** Deterministic, name-free sentence. Explains, never apologises. */
  explanation: string;
}

/** Everything a consumer needs about one date's composition. */
export interface HistoricalHoldingsSet {
  dateISO: string;
  /** THE DENOMINATOR — components ownership licenses on this date. */
  held:     HeldHolding[];
  /** Components ownership refuses on this date, each with a coded reason. */
  excluded: ExcludedHolding[];
  /** held.length — how many positions existed. */
  heldCount:   number;
  /** How many of those the engine could value. */
  valuedCount: number;
  /** Σ reportingValue over HELD components only. */
  valuedSubtotal: number;
  /** Worst ownership confidence among held; UNKNOWN when nothing is held. */
  ownershipConfidence: OwnershipConfidenceAxis;
}

/**
 * Where `dateISO` falls relative to one holding's ownership segments.
 *
 * Inside a KNOWN segment → KNOWN; inside a POSSIBLE segment → POSSIBLE; outside
 * every segment → UNKNOWN. Since V26-S2 a segment can END, so "after the window"
 * is now a real position for a date to be in, and it reads UNKNOWN here — the
 * caller distinguishes closed-from-never-owned via `closedFromISO`.
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

/** The segment covering a date, for the "since when / until when" answer. */
function coveringSegment(
  dateISO: string,
  resolution: OwnershipResolution | undefined,
  confidence: "KNOWN" | "POSSIBLE",
): OwnershipSegment | null {
  if (!resolution || resolution.kind !== "resolved") return null;
  return resolution.segments.find(
    (s) => s.confidence === confidence && dateISO >= s.fromISO && dateISO <= s.toISO,
  ) ?? null;
}

const CONFIDENCE_RANK: Record<OwnershipConfidenceAxis, number> = { KNOWN: 0, POSSIBLE: 1, UNKNOWN: 2 };

/** Ownership facts the set needs per holding, supplied by the binding. */
export interface HoldingOwnershipFacts {
  resolution:    OwnershipResolution | undefined;
  /** First OBSERVED zero on/after the last positive; null when never closed. */
  closedFromISO: string | null;
}

/**
 * Build one date's holdings set.
 *
 * Deterministic: held and excluded are sorted by (account, instrument), and the
 * subtotal is summed in that order, so identical inputs give a byte-identical
 * result whatever order the components arrived in.
 *
 * A held holding the engine could not value STAYS HELD. That is the difference
 * between the two counts and the reason both exist: "12 of 13" says twelve
 * positions were valued out of thirteen that existed, which is a statement about
 * COVERAGE. Dropping the thirteenth would silently restate it as complete.
 */
export function buildHistoricalHoldings(
  dateISO:    string,
  components: readonly HoldingComponent[],
  ownershipBy: ReadonlyMap<string, HoldingOwnershipFacts>,
  keyOf: (c: HoldingComponent) => string,
): HistoricalHoldingsSet {
  const held: HeldHolding[] = [];
  const excluded: ExcludedHolding[] = [];
  let confidence: OwnershipConfidenceAxis = "KNOWN";
  let sawHeld = false;

  for (const c of components) {
    const facts = ownershipBy.get(keyOf(c));
    const own = ownershipOn(dateISO, facts?.resolution);

    if (own === "UNKNOWN") {
      // Closed and never-owned are BOTH "not held", and they are not the same
      // fact. A consumer that cannot tell them apart cannot explain a portfolio
      // that shrinks, so the distinction is carried rather than collapsed.
      const closedFrom = facts?.closedFromISO ?? null;
      const closed = closedFrom !== null && dateISO >= closedFrom;
      const reasonCode: HoldingExclusionReason =
        closed ? "OWNERSHIP_CLOSED"
        : facts?.resolution === undefined || facts.resolution.kind !== "resolved" ? "NO_OWNERSHIP_EVIDENCE"
        : "OWNERSHIP_UNKNOWN";
      excluded.push({
        ...c,
        reasonCode,
        explanation:
          reasonCode === "OWNERSHIP_CLOSED"
            ? `Not held on ${dateISO}: an observation on ${closedFrom} states this position was closed.`
            : reasonCode === "NO_OWNERSHIP_EVIDENCE"
              ? `Not held on ${dateISO}: no ownership evidence of any kind exists for this position.`
              : `Not held on ${dateISO}: no ownership evidence reaches this date.`,
      });
      continue;
    }

    const seg = coveringSegment(dateISO, facts?.resolution, own);
    held.push({
      ...c,
      ownership:        own,
      ownershipFromISO: seg?.fromISO ?? dateISO,
      ownershipToISO:   seg?.toISO ?? dateISO,
      valued:           c.reportingValue != null,
    });
    if (!sawHeld || CONFIDENCE_RANK[own] > CONFIDENCE_RANK[confidence]) {
      confidence = own;
      sawHeld = true;
    }
  }

  const byPair = (a: HoldingComponent, b: HoldingComponent): number =>
    a.financialAccountId.localeCompare(b.financialAccountId) ||
    a.instrumentId.localeCompare(b.instrumentId);
  held.sort(byPair);
  excluded.sort(byPair);

  return {
    dateISO,
    held,
    excluded,
    heldCount:   held.length,
    valuedCount: held.reduce((n, h) => n + (h.valued ? 1 : 0), 0),
    valuedSubtotal: held.reduce((n, h) => n + (h.reportingValue ?? 0), 0),
    ownershipConfidence: sawHeld ? confidence : "UNKNOWN",
  };
}
