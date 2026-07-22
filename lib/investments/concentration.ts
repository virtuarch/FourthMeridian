/**
 * lib/investments/concentration.ts
 *
 * The single source of the portfolio CONCENTRATION formula + classification
 * bands. Extracted from lib/ai/assemblers/holdings.ts so both the AI holdings
 * assembler and the Investments Allocation panel compute concentration ONE way —
 * a later threshold change happens here, not in two places (mirrors the TI1
 * flow-predicates consolidation).
 *
 * PURE and import-free: same-input → same-output, no DB / clock / network. It
 * operates on already-weighted positions (weights relative to the analyzable
 * invested value), and it assumes the caller passes them value/weight-DESC (it
 * reads `positions[0]` as the top holding and never re-sorts) — the exact
 * contract the assembler already relied on.
 *
 * Behavior is byte-for-byte the pre-extraction assembler math: same band
 * thresholds, same Herfindahl / top-5 / effective-holdings formulas, same
 * most-severe-first band check, same INSUFFICIENT_DATA guard.
 */

/**
 * Concentration classification for the analyzable (non-cash, visible) portion of
 * a portfolio. `INSUFFICIENT_DATA` = nothing analyzable (all cash / hidden).
 */
export type ConcentrationClassification =
  | 'INSUFFICIENT_DATA'
  | 'DIVERSIFIED'
  | 'MODERATE'
  | 'CONCENTRATED'
  | 'HIGHLY_CONCENTRATED';

/** Deterministic concentration metrics, all relative to the analyzed invested value. */
export interface ConcentrationMetrics {
  classification:    ConcentrationClassification;
  topSymbol:         string | null;
  /** largest single-name weight, 0..1 */
  topWeight:         number | null;
  /** sum of the five largest weights, 0..1 (or fewer if <5) */
  top5Weight:        number | null;
  /** Σ(weight²), 0..1; higher = more concentrated */
  herfindahl:        number | null;
  /** 1 / herfindahl — intuitive "effective number of positions" */
  effectiveHoldings: number | null;
}

/**
 * Classification bands — a portfolio is flagged when EITHER the single-name top
 * weight OR the Herfindahl index crosses the band floor, so both single-name
 * dominance and few-position clustering are caught. Checked most-severe first.
 */
export const CONCENTRATION_BANDS: Array<{
  classification: Exclude<ConcentrationClassification, 'INSUFFICIENT_DATA'>;
  topWeight:      number;
  herfindahl:     number;
}> = [
  { classification: 'HIGHLY_CONCENTRATED', topWeight: 0.40, herfindahl: 0.25 },
  { classification: 'CONCENTRATED',        topWeight: 0.25, herfindahl: 0.15 },
  { classification: 'MODERATE',            topWeight: 0.15, herfindahl: 0.10 },
];

/**
 * Concentration metrics over analyzable positions. `positions` MUST already be
 * sorted value/weight-descending and carry `weight` relative to `invested`.
 * Returns INSUFFICIENT_DATA with null metrics when there is nothing to analyze.
 */
export function computeConcentration<T extends { weight: number; symbol: string | null }>(
  positions: readonly T[],
  invested:  number,
): ConcentrationMetrics {
  if (positions.length === 0 || invested <= 0) {
    return {
      classification:    'INSUFFICIENT_DATA',
      topSymbol:         null,
      topWeight:         null,
      top5Weight:        null,
      herfindahl:        null,
      effectiveHoldings: null,
    };
  }

  const topWeight  = positions[0].weight;
  const top5Weight = positions.slice(0, 5).reduce((sum, p) => sum + p.weight, 0);
  const herfindahl = positions.reduce((sum, p) => sum + p.weight * p.weight, 0);
  const effectiveHoldings = herfindahl > 0 ? 1 / herfindahl : positions.length;

  let classification: ConcentrationClassification = 'DIVERSIFIED';
  for (const band of CONCENTRATION_BANDS) {
    if (topWeight >= band.topWeight || herfindahl >= band.herfindahl) {
      classification = band.classification;
      break;
    }
  }

  return {
    classification,
    topSymbol:         positions[0].symbol,
    topWeight,
    top5Weight,
    herfindahl,
    effectiveHoldings,
  };
}
