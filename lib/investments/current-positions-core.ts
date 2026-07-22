/**
 * lib/investments/current-positions-core.ts
 *
 * P2-3 — PURE assembly + read-strategy helpers for the canonical current-position
 * seam (getCurrentPositions). No DB, no clock, no network — fixture-testable.
 *
 * getCurrentPositions is **A10-at-today** computed through a CHEAPER read: instead
 * of scanning the full observation window and resolving each pair, it reads only
 * the latest observation per (account, instrument) from the DB. This module holds
 * the two pure pieces of that:
 *
 *   1. `latestObservationsPerPair` — the executable statement of the read
 *      strategy: the max-date rows per (account, instrument). It reproduces, in
 *      memory, exactly what the binding's `groupBy(max date) + fetch` returns, so
 *      the parity test can prove that resolving over these rows is byte-identical
 *      to resolving over the full window (the ONLY documented difference between
 *      getCurrentPositions and A10-at-today is this read strategy).
 *   2. `assembleCurrentPositions` — reuses the SAME pure builders the Time Machine
 *      uses (`toValuedHoldingRows`, `toInvestmentsPortfolio`), then rides an
 *      additive `costBasis` onto each row. It creates NO valuation, price, FX, or
 *      completeness math — every number is passed through from the canonical
 *      valuation view. Not a second investment authority.
 */

import type { InvestmentValuationView } from "./valuation-core";
import {
  toValuedHoldingRows,
  toInvestmentsPortfolio,
  type InstrumentDisplay,
  type InvestmentsPortfolio,
  type ValuedHoldingRow,
} from "./investments-time-machine-core";

/**
 * A current, valued position. A10 `ValuedHoldingRow` verbatim (identity, quantity,
 * value, share, allocation, and the full valuation provenance — basisUsed,
 * priceDate, staleDays, per-factor tiers, reason, conflicted) plus one ADDITIVE
 * field the current-state consumers (AI, export) want and A10 does not carry.
 */
export interface CurrentPositionRow extends ValuedHoldingRow {
  /**
   * Plaid holding-level aggregate cost basis from the resolved latest
   * observation; null when the provider never supplied one. Additive — deliberately
   * absent from A10's holdings so the historical read is unchanged.
   */
  costBasis: number | null;
}

/** The canonical current-position projection. Serialisable. */
export interface CurrentPositions {
  /** The resolved "today" the positions were valued at (YYYY-MM-DD). */
  asOf:              string;
  reportingCurrency: string;
  /** Valued rows, value-descending then instrumentId-ascending (A10's order). */
  rows:              CurrentPositionRow[];
  /** Valued subtotal + explicit unvalued remainder + trust envelope (A10 shape). */
  portfolio:         InvestmentsPortfolio;
}

/** The minimal per-row identity the latest-per-pair selection reads. */
export interface DatedPairRow {
  financialAccountId: string;
  instrumentId:       string;
  date:               string; // YYYY-MM-DD
}

/**
 * The latest observation(s) per (account, instrument): every row whose date equals
 * that pair's maximum date. Same-date rows (multiple origins/sources) are all kept
 * so the downstream A4 origin/institution tiebreak resolves them identically to the
 * full-window read. Pure; order-preserving.
 *
 * This is the in-memory twin of the binding's `groupBy(_max: date) + fetch`. The
 * parity test feeds a full window through it and asserts the resolved position is
 * unchanged — proving the cheap read loses nothing.
 */
export function latestObservationsPerPair<T extends DatedPairRow>(rows: readonly T[]): T[] {
  const maxDate = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.financialAccountId}|${r.instrumentId}`;
    const cur = maxDate.get(k);
    if (cur === undefined || r.date > cur) maxDate.set(k, r.date);
  }
  return rows.filter((r) => r.date === maxDate.get(`${r.financialAccountId}|${r.instrumentId}`));
}

/**
 * Compose the canonical current-position result from an already-computed valuation
 * view, the instrument display map, and the resolved per-pair cost basis. Pure —
 * reuses the Time Machine's row/portfolio builders so getCurrentPositions.rows and
 * A10.holdings are identically shaped and ordered for the same view.
 */
export function assembleCurrentPositions(args: {
  asOf:            string;
  view:            InvestmentValuationView;
  display:         Record<string, InstrumentDisplay>;
  /** costBasis keyed by `${accountId}|${instrumentId}`; missing ⇒ null. */
  costBasisByPair: Record<string, number | null>;
}): CurrentPositions {
  const { asOf, view, display, costBasisByPair } = args;
  const rows: CurrentPositionRow[] = toValuedHoldingRows(view, display).map((r) => ({
    ...r,
    costBasis: costBasisByPair[`${r.accountId}|${r.instrumentId}`] ?? null,
  }));
  return {
    asOf,
    reportingCurrency: view.reportingCurrency,
    rows,
    portfolio: toInvestmentsPortfolio(view),
  };
}
