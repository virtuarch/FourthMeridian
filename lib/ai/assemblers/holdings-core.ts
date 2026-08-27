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

  // ── Aggregate totals (all visibility, ONE spine — crypto included) ──────────
  const allInvestedSpine = allScope.valuedSubtotal - allScope.cashValue;
  const totalPortfolioValue = allScope.valuedSubtotal;
  const cashValue           = allScope.cashValue;
  const investedValue       = allInvestedSpine;
  const totalsEstimated     = allScope.anyFxEstimated;
  const cashPct = totalPortfolioValue > 0 ? cashValue / totalPortfolioValue : 0;

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
  let unvaluedFullCount = 0;
  let stalePricedCount = 0;
  let maxStaleDays = 0;
  let maxStalePriceDate: string | null = null;
  for (const r of fullRows) {
    if (r.reportingValue == null) { unvaluedFullCount++; continue; }
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
  const concentration = computeConcentration(concentrationPositions, analyzedInvestedValue);

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
  if (unvaluedFullCount > 0) {
    dataLimits.push(
      `${unvaluedFullCount} position(s) could not be valued and are excluded from ` +
      "the value totals — treat the totals as a subtotal, not the whole.",
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
    totalPortfolioValue,
    investedValue,
    cashValue,
    totalsEstimated,
    cashPct,
    positionCount: rankedPositions.length,
    analyzedInvestedValue,
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
