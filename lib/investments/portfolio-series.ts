/**
 * lib/investments/portfolio-series.ts  (SD-4 FU-CHART)
 *
 * The canonical "Portfolio Value Over Time" series for the Investments Workspace —
 * built by REUSING the already-persisted SpaceSnapshot per-date series (the same
 * authority Wealth reads), NOT by sampling getInvestmentValueAsOf across dates
 * (an N×date DB path) and NOT by reconstructing from today's holdings.
 *
 * BUCKET RULE (preserves the doctrine "shared PositionObservation spine ≠ shared
 * net-worth bucket", and avoids the historical BTC double-count): the Investments
 * Workspace portfolio is brokerage + crypto, so each point's value is
 *   totalInvestments (SpaceSnapshot.stocks — investments EXCLUDING crypto)
 *   + totalCrypto     (SpaceSnapshot.crypto  — the separate digital-asset column)
 * i.e. two DISJOINT historical buckets summed = each asset counted exactly ONCE.
 * We never sum `stocks` with a crypto-INCLUDED valuation (that double-counts), and
 * never plot `stocks` alone (that silently drops crypto).
 *
 * Honesty: `fxMiss` points (a snapshot whose mixed-currency total couldn't be
 * converted) are DROPPED — a shorter honest series over a silently mixed one, the
 * same rule the net-worth hero uses. `estimated` (reconstructed / display-estimated)
 * rides through per point.
 *
 * Pure — no DB, no prisma. The route gathers the snapshots (getRecentSnapshots) and
 * hands them here; this module only reshapes + (optionally) display-converts.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";

/** One point on the Portfolio Value Over Time chart, in a stated currency. */
export interface PortfolioValuePoint {
  /** YYYY-MM-DD. */
  date:      string;
  /** Reporting- (or display-) currency investment value = investments + crypto. */
  value:     number;
  currency:  string;
  /** True when the snapshot was reconstructed / display-estimated (badge, not a lie). */
  estimated: boolean;
}

/** The SpaceSnapshot fields this series needs (structural — no import coupling). */
export interface SnapshotSeriesRow {
  date:             string;
  totalInvestments: number; // SpaceSnapshot.stocks — investments EXCLUDING crypto
  totalCrypto:      number; // SpaceSnapshot.crypto  — separate digital-asset bucket
  isEstimated?:     boolean;
  fxMiss?:          boolean;
}

/**
 * Reshape a stamp-converted SpaceSnapshot window into the Investments value series.
 * Drops `fxMiss` points; every remaining point's value is the two disjoint buckets
 * summed (brokerage + crypto), in `reportingCurrency`.
 */
export function buildPortfolioValueSeries(
  snapshots: readonly SnapshotSeriesRow[],
  reportingCurrency: string,
): PortfolioValuePoint[] {
  const out: PortfolioValuePoint[] = [];
  for (const s of snapshots) {
    if (s.fxMiss) continue; // honest omission — never a silently mixed-magnitude point
    out.push({
      date:      s.date,
      value:     s.totalInvestments + s.totalCrypto,
      currency:  reportingCurrency,
      estimated: s.isEstimated ?? false,
    });
  }
  return out;
}

/**
 * Display-currency conversion for the series — the SAME canonical `convertMoney`
 * seam the rest of the Workspace uses. Identity when the point currency already IS
 * the target; a rate miss rides through as `estimated` (the money contract), never a
 * relabel-only masquerade. Converts each point at the chart's single rate date.
 */
export function convertPortfolioValueSeries(
  series:  readonly PortfolioValuePoint[],
  ctx:     ConversionContext,
  dateISO: string,
): PortfolioValuePoint[] {
  return series.map((p) => {
    if (p.currency === ctx.target) return p;
    const c = convertMoney({ amount: p.value, currency: p.currency }, dateISO, ctx);
    return { date: p.date, value: c.amount, currency: ctx.target, estimated: p.estimated || c.estimated };
  });
}
