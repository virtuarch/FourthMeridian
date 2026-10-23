/**
 * lib/ai/assemblers/holdings-core.ts
 *
 * PURE assembly for the AI 'holdings_summary' domain (P2-4). No DB, no clock, no
 * network — fixture-testable. This is the half of the holdings assembler that
 * shapes the HoldingsSummaryData payload from already-read inputs; the DB binding
 * (holdings.ts) gathers those inputs from the CANONICAL investment truth spine and
 * calls in here.
 *
 * ── The canonical cutover (P2-4) ─────────────────────────────────────────────
 * FULL-visibility position DETAIL now comes from `getCurrentPositions({spaceId})`
 * (the A10-at-today seam; visibility enforced INSIDE it — see current-positions.ts),
 * NOT from a legacy `Holding` read with the visibility branch re-implemented here.
 * The all-visibility aggregate VALUE (which legitimately includes the value of
 * BALANCE_ONLY / SUMMARY_ONLY accounts while withholding their positions) comes
 * from the canonical `getInvestmentValueAsOf({visibilityScope:"all"})` path.
 *
 * ── W5 — one authority, one source (P2-6 executed) ───────────────────────────
 * Crypto no longer has a side entrance. The legacy `Holding` bridge
 * (lib/investments/legacy-crypto-holdings.ts) and its CANONICAL-WINS dedup
 * (lib/investments/canonical-precedence.core.ts) were DELETED per their own
 * deletion conditions: a crypto wallet appears here exactly like any other
 * instrument — as a PositionObservation valued through the dated archive price
 * on the canonical seam. A wallet with NO spine observation is HONESTLY ABSENT
 * (position-unknown), never back-filled from a legacy row and never re-valued
 * from an undated sync-time spot quote. Do not reintroduce a `Holding` read or
 * a second crypto valuation path — scripts/audit-crypto-holding-tombstone.ts
 * fails the build on the retired vocabulary.
 *
 * ── Privacy invariant ────────────────────────────────────────────────────────
 * This module only ever SEES FULL-visibility position rows (`fullRows`, from the
 * detail-eligible seam). Non-FULL accounts contribute ONLY aggregate value
 * (`allScope`) — never a symbol, name, quantity, or per-position value. The
 * hidden non-cash value is disclosed via `positionsPartiallyHidden` + a
 * dataLimits note, never leaked as detail.
 *
 * ── Concentration parity ─────────────────────────────────────────────────────
 * Concentration is computed over the FULL non-cash rows aggregated PER INSTRUMENT
 * (exactly as investments-allocation-core.ts::computeAllocation does) and run
 * through the SAME lib/investments/concentration.ts helper — so on a FULL
 * fixture the AI number and the Investments Allocation number are identical.
 * (W5: the off-spine crypto blend that transitionally diverged from the
 * spine-only UI is gone with the bridge — the two surfaces now read one spine.)
 */

import { computeConcentration } from "@/lib/investments/concentration";
import { boundedSelection } from "@/lib/ai/bounded-selection";
import type {
  HoldingsSummaryData,
  HoldingPosition,
  UnvaluedPosition,
} from "@/lib/ai/types";

/** The subset of a canonical CurrentPositionRow this core consumes (FULL detail). */
export interface CanonicalPositionRow {
  instrumentId:   string;
  symbol:         string | null;
  name:           string | null;
  /**
   * CF-12 — the instrument's canonical `AssetClass`, carried so a question
   * about securities is not answered with crypto.
   *
   * The spine is deliberately mixed: W5 routed digital assets through the same
   * two seams as securities, so BTC and SOL are positions like any other. That
   * is right for "what do I hold" and wrong for "what STOCKS do I own", and
   * without this field the serializer had no way to tell them apart.
   */
  assetClass?:    string;
  /** reporting-currency value; null ⇒ unvalued (excluded from totals & concentration). */
  reportingValue: number | null;
  isCash:         boolean;
  /**
   * W5 — valuation dating from the canonical path (InstrumentValuation):
   * the archive date the value was priced at and its age in days relative to
   * asOf. Carried so the payload can DISCLOSE a stale valuation instead of
   * presenting an aged price as current. null ⇒ unvalued or dating unknown.
   */
  priceDate?: string | null;
  staleDays?: number | null;
  /**
   * Observed quantity, and the seam's reason when a row could not be priced.
   *
   * ⚠️ CARRIED ONLY TO DESCRIBE AN EXCLUSION. Nothing here multiplies a quantity
   * by anything: an unpriced position stays unpriced and is reported as such.
   */
  quantity?: number | null;
  reason?:   string | null;
}

/**
 * The all-visibility aggregate from the canonical `getInvestmentValueAsOf("all")`
 * path — the ONE place a non-FULL account's value legitimately enters (value only,
 * never detail).
 */
export interface AllScopeAggregate {
  /** Σ reportingValue over VALUED components, ALL visibility levels (spine). */
  valuedSubtotal: number;
  /** Σ reportingValue over VALUED cash components, ALL visibility levels (spine). */
  cashValue:      number;
  /** any component's FX was estimated (walked-back / missing rate). */
  anyFxEstimated: boolean;
  /** any component present at all (spine has investment observations in scope). */
  hasAny:         boolean;
  /**
   * The canonical seam's OWN completeness verdict, carried verbatim.
   *
   * ⚠️ IT WAS BEING DISCARDED. `getInvestmentValueAsOf` returns a tier, a
   * sentence and both counts; this core used to drop all four and re-derive a
   * weaker note by counting nulls among the FULL-visibility rows — which cannot
   * see a position withheld by visibility, and which produced
   * "9 position(s) could not be valued" where the seam had already said
   * "9 of 13 holdings could not be valued … the total shown is a partial subtotal".
   */
  completeness:   {
    tier:          string;
    reason:        string | null;
    valuedCount:   number;
    unvaluedCount: number;
  };
}

const EPS = 1e-6;

/**
 * W5 — a valuation is DISCLOSED as stale beyond this age (days). 0–1 days is the
 * normal market-close lag (yesterday's close priced today) and is not remarked
 * on; at 2+ days the payload says how old the price is instead of letting an
 * aged figure read as current. Disclosure-only: nothing is graded or excluded
 * on staleness — the value stays in the totals with its age stated.
 */
export const STALE_PRICE_DISCLOSURE_DAYS = 2;

/** Maximum number of top positions surfaced in the context payload. */
export const HOLDINGS_TOP_N = 10;

/**
 * CF-12 — which side of the portfolio a question is about.
 *
 * Reuses the canonical `AssetClass.CRYPTO` marker already minted on every
 * digital-asset instrument (lib/investments/crypto-instrument.ts) rather than
 * introducing a second notion of "is this crypto?". CF-7 proved the two classes
 * are disjoint by account classification; this is the same split one level
 * down, at the instrument.
 */
export const PositionClass = {
  /** Every position. The default, and what "what do I hold" wants. */
  ALL:         'ALL',
  /** Securities only — equities, ETFs, funds, bonds, cash equivalents. */
  TRADITIONAL: 'TRADITIONAL',
  /** Digital assets only. */
  DIGITAL:     'DIGITAL',
} as const;

export type PositionClassKind = typeof PositionClass[keyof typeof PositionClass];

/** True when a row belongs to the requested side. */
export function positionMatchesClass(
  row: { assetClass?: string }, want: PositionClassKind,
): boolean {
  if (want === PositionClass.ALL) return true;
  const isCrypto = row.assetClass === 'CRYPTO';
  return want === PositionClass.DIGITAL ? isCrypto : !isCrypto;
}

/**
 * One sentence naming the concentration population.
 *
 * ⚠️ SHAPE, NEVER IDENTITY. It counts positions and names the KIND of exclusion
 * (unpriced, withheld). It never mentions an instrument, an account, a provider
 * or an asset class, so it stays true on any Space.
 */
export function describePopulation(
  analyzed: number, held: number, unvalued: number, anyHidden: boolean,
): string {
  if (analyzed === 0) return 'no positions could be analysed';
  // ⚠️ NEVER CLAIM A FRACTION THE INPUTS CANNOT SUPPORT. `held` comes from the
  // valuation seam's own counts; a caller that supplies none (a fixture, a Space
  // with nothing in scope) gets the count without a denominator rather than
  // "3 of 0".
  const parts = [held >= analyzed
    ? `${analyzed} of ${held} held position(s)`
    : `${analyzed} position(s)`];
  if (unvalued > 0) parts.push(`${unvalued} could not be priced and are excluded`);
  if (anyHidden)    parts.push('some positions are withheld by account visibility');
  return `${parts.join('; ')} — weights are a share of this population only`;
}

/** The base guardrails: what this value-only summary deliberately does not answer. */
function baseDataLimits(): string[] {
  return [
    // Cost basis is captured on the spine but deliberately NOT surfaced here;
    // gains/returns are out of scope for this value-based summary.
    "Cost basis is not surfaced here — unrealized/realized gains are not computed.",
    "No returns or performance metrics in this summary.",
    "Asset-class and sector breakdown are not included in this summary.",
  ];
}

/**
 * Shape the HoldingsSummaryData payload from canonical inputs. PURE.
 * Returns null when there is nothing to report (no spine positions and no crypto).
 */
export function buildHoldingsSummary(args: {
  scopeHint: "full" | "brief";
  /** FULL-visibility detail rows from getCurrentPositions (visibility enforced upstream). */
  fullRows:  readonly CanonicalPositionRow[];
  allScope:  AllScopeAggregate;
  /**
   * CF-12 — which side of the portfolio the question is about. Narrows the
   * POSITION LIST only: every total below stays whole-portfolio, because
   * `totalPortfolioValue` is what it says it is and silently redefining it
   * would be a second, contradictory definition of the same field.
   */
  positionClass?: PositionClassKind;
}): HoldingsSummaryData | null {
  const { scopeHint, fullRows, allScope, positionClass = PositionClass.ALL } = args;

  // Domain cleanly empty — no observations in scope. (W5: a crypto wallet with
  // no spine observation is part of this honest emptiness, never back-filled.)
  if (!allScope.hasAny) return null;

  // ── Aggregate totals — SCOPED TO WHAT COULD BE PRICED ───────────────────────
  //
  // ⚠️ THESE ARE NOT PORTFOLIO TOTALS AND THE FIELD NAMES NOW SAY SO. A position
  // whose price could not be resolved contributes NOTHING here, so on a Space
  // where the price archive is behind, this "total" can be a rounding error
  // against the account-level composition. The names changed from
  // totalPortfolioValue / investedValue / cashValue for exactly that reason.
  const allInvestedSpine   = allScope.valuedSubtotal - allScope.cashValue;
  const valuedPositionsTotal = allScope.valuedSubtotal;
  const valuedCashTotal      = allScope.cashValue;
  const valuedNonCashTotal   = allInvestedSpine;
  const totalsEstimated      = allScope.anyFxEstimated;
  const cashPct = valuedPositionsTotal > 0 ? valuedCashTotal / valuedPositionsTotal : 0;

  // ── FULL detail → concentration ─────────────────────────────────────────────
  // Spine rows aggregate PER INSTRUMENT (VTI in two brokerages collapses to one
  // weighted position — same as the Allocation panel, giving byte-identical
  // concentration on a FULL fixture). W5: crypto instruments participate here
  // exactly like any other instrument — no separate blend key exists any more.
  const byKey = new Map<string, {
    symbol: string | null; name: string | null; value: number;
    // CF-12 — carried through the aggregation so the ranked list can be
    // narrowed to one side of the portfolio without a second lookup.
    assetClass?: string;
  }>();
  let fullSpineInvestedNonCash = 0;
  const unvaluedPositions: UnvaluedPosition[] = [];
  let stalePricedCount = 0;
  let maxStaleDays = 0;
  let maxStalePriceDate: string | null = null;
  for (const r of fullRows) {
    if (r.reportingValue == null) {
      // ⚠️ NAMED, NOT COUNTED. Which positions are missing is the whole content
      // of the disclosure: on the real Space the unpriced set is every crypto
      // holding, and a bare count could not say so.
      unvaluedPositions.push({
        symbol:     r.symbol ?? null,
        name:       r.name ?? r.symbol ?? null,
        assetClass: r.assetClass ?? null,
        quantity:   r.quantity ?? null,
        reason:     r.reason ?? null,
      });
      continue;
    }
    // W5 — staleness bookkeeping for the disclosure below (valued rows only).
    if ((r.staleDays ?? 0) >= STALE_PRICE_DISCLOSURE_DAYS) {
      stalePricedCount++;
      if ((r.staleDays ?? 0) > maxStaleDays) {
        maxStaleDays = r.staleDays ?? 0;
        maxStalePriceDate = r.priceDate ?? null;
      }
    }
    if (r.isCash) continue;
    fullSpineInvestedNonCash += r.reportingValue;
    const b = byKey.get(r.instrumentId) ?? {
      symbol: r.symbol ?? r.name ?? null, name: r.name ?? r.symbol ?? null, value: 0,
      assetClass: r.assetClass,
    };
    b.value += r.reportingValue;
    byKey.set(r.instrumentId, b);
  }

  const analyzedInvestedValue = [...byKey.values()].reduce((s, p) => s + p.value, 0);

  // Concentration input: value-descending, weight relative to analyzedInvestedValue —
  // the EXACT contract computeConcentration + computeAllocation share.
  const concentrationPositions = [...byKey.values()]
    .map((p) => ({
      symbol: p.symbol,
      weight: analyzedInvestedValue > 0 ? p.value / analyzedInvestedValue : 0,
      value:  p.value,
    }))
    .sort((a, b) => b.value - a.value);
  const metrics = computeConcentration(concentrationPositions, analyzedInvestedValue);

  // ── The population the statistic describes ──────────────────────────────────
  //
  // ⚠️ ATTACHED TO THE METRICS, NOT BESIDE THEM. `computeConcentration` is the
  // shared authority (the Allocation panel runs the same function) and it is
  // correct — it answers "given these weights, how concentrated is this?". What
  // was missing is what the weights are a share OF, and the only structural way
  // to stop that being dropped is for it to live inside the object a serializer
  // reaches for.
  const hiddenValue = Math.max(0, allInvestedSpine - fullSpineInvestedNonCash);
  const isComplete  = unvaluedPositions.length === 0 && hiddenValue <= EPS;
  const concentration = {
    ...metrics,
    population: {
      label: describePopulation(
        byKey.size, allScope.completeness.valuedCount + allScope.completeness.unvaluedCount,
        unvaluedPositions.length, hiddenValue > EPS),
      value:              analyzedInvestedValue,
      positionCount:      byKey.size,
      unvaluedCount:      unvaluedPositions.length,
      hiddenValue,
      shareOfValuedTotal: valuedPositionsTotal > 0
        ? analyzedInvestedValue / valuedPositionsTotal : null,
      isComplete,
    },
  };

  // CF-12 — the class rides along the ranked list. Weights stay relative to the
  // WHOLE analyzed portfolio: narrowing the list must not silently redefine
  // what a position's share is a share OF.
  const rankedPositions: (HoldingPosition & { assetClass?: string })[] = [...byKey.values()]
    .map((p) => ({
      symbol: p.symbol ?? p.name ?? "—",
      name:   p.name ?? p.symbol ?? "—",
      value:  p.value,
      weight: analyzedInvestedValue > 0 ? p.value / analyzedInvestedValue : 0,
      assetClass: p.assetClass,
    }))
    .sort((a, b) => b.value - a.value);

  // ── Partial-visibility disclosure (non-cash spine value withheld) ───────────
  const positionsPartiallyHidden = allInvestedSpine - fullSpineInvestedNonCash > EPS;

  // ── dataLimits (honest caveats; the LLM must not infer hidden composition) ───
  const dataLimits = baseDataLimits();
  if (positionsPartiallyHidden) {
    dataLimits.push(
      "Some accounts are shared below full visibility; their individual positions " +
      "are excluded from position and concentration analysis (their value is still " +
      "counted in the totals).",
    );
  }
  // ⚠️ THE SEAM'S OWN SENTENCE, not a second one derived from a subset of its
  // rows. `unvaluedPositions` carries the identities; this carries the verdict.
  if (allScope.completeness.unvaluedCount > 0 && allScope.completeness.reason) {
    dataLimits.push(allScope.completeness.reason);
  }
  if (unvaluedPositions.length > 0) {
    // Wording note: "could not be valued" is pinned by holdings-core.test.ts and
    // predates this change; it stays, and what is ADDED is where to look and the
    // instruction not to restate a percentage without its population.
    dataLimits.push(
      `${unvaluedPositions.length} position(s) could not be valued and are excluded ` +
      "from every value and every concentration figure here — see unvaluedPositions " +
      "for which, and read concentration.population before restating any percentage.",
    );
  }
  // W5 — staleness disclosure: a value priced from an archive date older than
  // the normal close lag is stated as such, never presented as current. The
  // value stays in the totals; only its age is disclosed.
  if (stalePricedCount > 0) {
    dataLimits.push(
      `${stalePricedCount} position value(s) use a price ${maxStaleDays} day(s) old` +
      (maxStalePriceDate ? ` (latest available price date ${maxStalePriceDate})` : "") +
      " — treat those values as of that date, not today.",
    );
  }

  const data: HoldingsSummaryData = {
    valuedPositionsTotal,
    valuedNonCashTotal,
    valuedCashTotal,
    totalsEstimated,
    cashPct,
    positionCount: rankedPositions.length,
    analyzedInvestedValue,
    valuationCompleteness: {
      tier:          allScope.completeness.tier,
      reason:        allScope.completeness.reason,
      valuedCount:   allScope.completeness.valuedCount,
      unvaluedCount: allScope.completeness.unvaluedCount,
    },
    unvaluedPositions,
    positionsPartiallyHidden,
    concentration,
    dataLimits,
    // topPositions omitted for the Daily Brief aggregator to keep payload lean.
    ...(scopeHint !== "brief"
      // CF-1 — `positionCount` already carried the denominator, but only inside
      // a JSON dump with no statement of what topPositions is a subset OF. The
      // selection now says so explicitly, in the shared shape.
      // CF-12 — the denominator is the FILTERED population, so "showing 8 of 9"
      // counts securities on a securities question rather than quietly keeping
      // the mixed total. CF-1's rule applied to a second narrowing.
      ? { topPositions: boundedSelection(
            rankedPositions.filter((r) => positionMatchesClass(r, positionClass)),
            HOLDINGS_TOP_N) }
      : {}),
  };
  return data;
}
