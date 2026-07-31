/**
 * lib/prices/ownership-window.core.ts
 *
 * V26-PRICE-4 — the PURE resolution of "over what span might this instrument
 * have been owned, and how confident are we?". No Prisma, no network, no clock.
 *
 * ── Why confidence is explicit ───────────────────────────────────────────────
 * The obvious shape is one window: earliest evidence → today. The coverage
 * investigation showed why that is wrong. A first OBSERVATION is not first
 * OWNERSHIP: BTC's earliest PositionObservation is dated when capture began, not
 * when the wallet was funded, and deriving the floor from observations alone
 * silently truncates years of real history.
 *
 * The repair is not to widen the window and forget — it is to widen it and SAY
 * SO. Two spans that produce identical price requests are not identical facts:
 *
 *   KNOWN     ownership is directly evidenced (a position, an event)
 *   POSSIBLE  ownership may have begun earlier (the account existed, money moved)
 *   UNKNOWN   before that, there is no evidence either way — never requested
 *
 * Acquisition may fetch KNOWN and POSSIBLE alike; a price is a price. But every
 * downstream consumer must still be able to tell which valuations rest on direct
 * evidence and which rest on an inference, and collapsing the two here would
 * destroy that distinction at the only point it is cheaply knowable. Snapshot
 * completeness (PRICE-5) and reporting (REPORTING-1) both need it.
 *
 * UNKNOWN prehistory is never fetched. Buying prices for a span with no evidence
 * of ownership is how an archive fills with data that licenses fabricated
 * history later.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function assertISO(s: string, label: string): void {
  if (!ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`[prices] ownership-window: invalid ${label} "${s}" (expected YYYY-MM-DD)`);
  }
}
function shiftISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}
function inclusiveDays(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / MS_PER_DAY) + 1;
}

/** Ownership confidence for one contiguous span. UNKNOWN is never a segment — it is the absence of one. */
export type OwnershipConfidence = "KNOWN" | "POSSIBLE";

export interface OwnershipSegment {
  confidence: OwnershipConfidence;
  fromISO:    string;
  toISO:      string;
  /** Inclusive calendar days — the unit the budget report attributes. */
  days:       number;
}

export interface OwnershipEvidence {
  instrumentId: string;
  /**
   * Earliest DIRECT evidence of holding: first PositionObservation or
   * InvestmentEvent. Null when the instrument has neither.
   */
  earliestDirectISO:   string | null;
  /**
   * Earliest date ownership COULD have begun — account connection date, or the
   * account's first transaction. Null when unknown. Widens the window only; it
   * never narrows a direct observation.
   */
  earliestPossibleISO: string | null;
  /**
   * The latest date requiring valuation: today−1 for a held position, the
   * disposal date for a closed one. The CALLER decides — this module does not
   * read a clock.
   */
  valuationToISO:      string;
}

export type OwnershipResolution =
  | {
      kind:               "resolved";
      instrumentId:       string;
      /** Ascending, adjacent, non-overlapping. POSSIBLE precedes KNOWN when both exist. */
      segments:           OwnershipSegment[];
      /** The span acquisition may request — the union of the segments. */
      acquisitionFromISO: string;
      acquisitionToISO:   string;
      knownDays:          number;
      possibleDays:       number;
      /**
       * The last date of UNKNOWN prehistory: everything on or before this is
       * evidence-free and must NEVER be requested. Null when the window opens at
       * the earliest representable evidence.
       */
      unknownBeforeISO:   string | null;
    }
  | {
      kind:         "no-acquisition";
      instrumentId: string;
      reason:       "NO_OWNERSHIP_EVIDENCE" | "EVIDENCE_AFTER_CEILING";
    };

/**
 * Resolve one instrument's ownership window into confidence-tagged segments.
 *
 * Deterministic and clock-free. Throws on malformed input (programmer error).
 *
 * Segment rules:
 *   - direct evidence only            → one KNOWN segment [direct, ceiling]
 *   - possible earlier than direct    → POSSIBLE [possible, direct−1] + KNOWN [direct, ceiling]
 *   - possible at or after direct     → the possible bound adds nothing; KNOWN only
 *   - possible with no direct evidence→ one POSSIBLE segment; nothing is KNOWN
 *   - no evidence at all              → no acquisition (never fetch blind history)
 *   - evidence begins after the ceiling → no acquisition (nothing to value)
 */
export function resolveOwnershipWindow(evidence: OwnershipEvidence): OwnershipResolution {
  const { instrumentId, earliestDirectISO, earliestPossibleISO, valuationToISO } = evidence;
  assertISO(valuationToISO, "valuationToISO");
  if (earliestDirectISO !== null) assertISO(earliestDirectISO, "earliestDirectISO");
  if (earliestPossibleISO !== null) assertISO(earliestPossibleISO, "earliestPossibleISO");

  if (earliestDirectISO === null && earliestPossibleISO === null) {
    return { kind: "no-acquisition", instrumentId, reason: "NO_OWNERSHIP_EVIDENCE" };
  }

  const segments: OwnershipSegment[] = [];

  if (earliestDirectISO === null) {
    // Possible-only: the account could have held it, but nothing evidences it.
    // Fetchable, and every day of it is an inference.
    if (earliestPossibleISO! > valuationToISO) {
      return { kind: "no-acquisition", instrumentId, reason: "EVIDENCE_AFTER_CEILING" };
    }
    segments.push({
      confidence: "POSSIBLE",
      fromISO:    earliestPossibleISO!,
      toISO:      valuationToISO,
      days:       inclusiveDays(earliestPossibleISO!, valuationToISO),
    });
  } else {
    if (earliestDirectISO > valuationToISO) {
      return { kind: "no-acquisition", instrumentId, reason: "EVIDENCE_AFTER_CEILING" };
    }
    // A possible bound EARLIER than direct evidence opens an inferred prefix.
    if (earliestPossibleISO !== null && earliestPossibleISO < earliestDirectISO) {
      const possibleTo = shiftISO(earliestDirectISO, -1);
      segments.push({
        confidence: "POSSIBLE",
        fromISO:    earliestPossibleISO,
        toISO:      possibleTo,
        days:       inclusiveDays(earliestPossibleISO, possibleTo),
      });
    }
    segments.push({
      confidence: "KNOWN",
      fromISO:    earliestDirectISO,
      toISO:      valuationToISO,
      days:       inclusiveDays(earliestDirectISO, valuationToISO),
    });
  }

  const acquisitionFromISO = segments[0].fromISO;
  const acquisitionToISO   = segments[segments.length - 1].toISO;

  return {
    kind:         "resolved",
    instrumentId,
    segments,
    acquisitionFromISO,
    acquisitionToISO,
    knownDays:    segments.filter((s) => s.confidence === "KNOWN").reduce((n, s) => n + s.days, 0),
    possibleDays: segments.filter((s) => s.confidence === "POSSIBLE").reduce((n, s) => n + s.days, 0),
    unknownBeforeISO: shiftISO(acquisitionFromISO, -1),
  };
}

/**
 * Attribute one requested date range to ownership confidence. Used by the budget
 * report so a request's cost is split between evidenced and inferred history
 * rather than presented as one undifferentiated number.
 *
 * Days outside every segment are counted as `unattributed` — they should be zero
 * whenever the plan was built from this resolution, so a non-zero value means
 * something requested prehistory it should not have.
 */
export function attributeRange(
  fromISO:  string,
  toISO:    string,
  segments: readonly OwnershipSegment[],
): { knownDays: number; possibleDays: number; unattributedDays: number } {
  assertISO(fromISO, "fromISO");
  assertISO(toISO, "toISO");
  let known = 0, possible = 0;
  const total = fromISO > toISO ? 0 : inclusiveDays(fromISO, toISO);
  for (const s of segments) {
    const lo = s.fromISO > fromISO ? s.fromISO : fromISO;
    const hi = s.toISO   < toISO   ? s.toISO   : toISO;
    if (lo > hi) continue;
    const days = inclusiveDays(lo, hi);
    if (s.confidence === "KNOWN") known += days;
    else possible += days;
  }
  return { knownDays: known, possibleDays: possible, unattributedDays: total - known - possible };
}
