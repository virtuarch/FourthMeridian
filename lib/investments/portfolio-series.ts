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
import {
  resolveSnapshotCompleteness, snapshotConfidence, type SnapshotConfidence,
} from "@/lib/snapshots/snapshot-completeness.core";
import { valuedOfTotalLabel } from "./investments-trust";

export type { SnapshotConfidence };

/** One point on the Portfolio Value Over Time chart, in a stated currency. */
export interface PortfolioValuePoint {
  /** YYYY-MM-DD. */
  date:      string;
  /** Reporting- (or display-) currency investment value = investments + crypto. */
  value:     number;
  currency:  string;
  /** True when the snapshot was reconstructed / display-estimated (badge, not a lie). */
  estimated: boolean;
  /**
   * V26-INVESTMENTS-HISTORY — the point's confidence, already CLASSIFIED here so
   * the chart layer receives a state to draw rather than evidence to judge.
   * `estimated` above is the older two-state view of the same thing and is kept
   * for consumers that only need "is this a reconstruction?".
   */
  confidence: SnapshotConfidence;
  /**
   * Ready-to-render disclosure ("1 of 19 positions valued"), or null when the
   * snapshot recorded no composition. Built by the ONE canonical author
   * (`valuedOfTotalLabel`) so no surface writes its own evidence string, and
   * passed as text so no surface does arithmetic on the counts.
   */
  coverageLabel: string | null;
}

/** The SpaceSnapshot fields this series needs (structural — no import coupling). */
export interface SnapshotSeriesRow {
  date:             string;
  totalInvestments: number; // SpaceSnapshot.stocks — investments EXCLUDING crypto
  totalCrypto:      number; // SpaceSnapshot.crypto  — separate digital-asset bucket
  isEstimated?:     boolean;
  fxMiss?:          boolean;
  /**
   * V26-CRYPTO-STATUS-1 — may this row's crypto component be asserted? Resolved
   * ONCE at the snapshot read boundary from observation + the persisted
   * `cryptoValuationStatus` + materiality. Read here, never re-derived: this
   * module must not know what a price floor, a provider or a materiality
   * threshold is. Optional so a caller predating the field is unaffected.
   */
  cryptoAssertable?: boolean;
  // V26-INVESTMENTS-HISTORY — the persisted confidence, as resolved by the read
  // authority (lib/data/snapshots.ts). All optional: a caller that predates the
  // columns, or a row written before them, classifies as `reconstructed` exactly
  // as it does today. See snapshotConfidence() for why `completenessRecorded`
  // rather than the tier alone decides that.
  completenessTier?:           string;
  completenessRecorded?:       boolean;
  contributingComponentCount?: number | null;
  totalComponentCount?:        number | null;
}

/**
 * Reshape a stamp-converted SpaceSnapshot window into the Investments value series.
 * Drops `fxMiss` points; every remaining point's value is the two disjoint buckets
 * summed (brokerage + crypto), in `reportingCurrency`.
 *
 * V26-CRYPTO-STATUS-1 — also drops points whose crypto MAY NOT BE ASSERTED. This
 * series' value is investments + crypto, so an unassertable crypto makes the SUM
 * unassertable: plotting `stocks` alone would silently drop crypto, and plotting
 * the stored figure asserts a valuation that never existed. Omission is the same
 * honesty the `fxMiss` rule already applies, and it produces a date hole the
 * chart renders as a real break — never a bridge.
 *
 * The decision is READ, not re-derived. `cryptoAssertable` arrives already
 * resolved from the snapshot read boundary (lib/data/snapshots.ts), which folds
 * together observation, the persisted status and materiality. This module
 * therefore contains no price floor, no provider name, no date rule and no
 * materiality threshold of its own — the previous version carried all four, and
 * a floor-derived rule was actively unsafe: the floor moves when a wider tier is
 * configured, which would have silently re-blessed every stale row.
 *
 * Only THIS series is affected. `stocks`, `cash`, `savings`, `debt` and
 * `netWorth` remain untouched on the row for Net Worth, Liquidity, Debt, AI and
 * export.
 */
export function buildPortfolioValueSeries(
  snapshots: readonly SnapshotSeriesRow[],
  reportingCurrency: string,
): PortfolioValuePoint[] {
  const out: PortfolioValuePoint[] = [];
  for (const s of snapshots) {
    if (s.fxMiss) continue; // honest omission — never a silently mixed-magnitude point
    // Unassertable crypto ⇒ unassertable portfolio total. Omitted, never asserted.
    // Absent (a caller predating the resolved DTO) leaves prior behaviour intact.
    if (s.cryptoAssertable === false) continue;
    // Classify ONCE, here. The row's stored confidence is re-resolved through the
    // same canonical interpreter the read authority uses, so a caller that hands
    // us a raw row and one that hands us a resolved DTO get the same answer.
    const completeness = resolveSnapshotCompleteness({
      isEstimated:                s.isEstimated ?? false,
      completenessTier:           s.completenessTier ?? null,
      contributingComponentCount: s.contributingComponentCount ?? null,
      totalComponentCount:        s.totalComponentCount ?? null,
    });
    // The read authority already told us whether the tier was RECORDED or
    // inferred; prefer its answer, since a re-resolve from the DTO cannot see
    // the difference between a recorded `unknown` and a legacy null.
    const recorded = s.completenessRecorded ?? completeness.recorded;
    const contributing = s.contributingComponentCount ?? null;
    const total = s.totalComponentCount ?? null;
    out.push({
      date:      s.date,
      value:     s.totalInvestments + s.totalCrypto,
      currency:  reportingCurrency,
      estimated: s.isEstimated ?? false,
      confidence: snapshotConfidence({ ...completeness, recorded }),
      // Disclosure, never a rule: the counts decide nothing above, they only
      // explain. Null when the row recorded no composition.
      coverageLabel: contributing != null && total != null
        ? valuedOfTotalLabel(contributing, total)
        : null,
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
  return series.flatMap((p) => {
    if (p.currency === ctx.target) return [p];
    const c = convertMoney({ amount: p.value, currency: p.currency }, dateISO, ctx);
    // V25-FINAL-1 — a point with no acceptable rate has no reporting value; DROP it
    // (never plot a native magnitude or a fake 0 beside converted points).
    if (c.amount === null) return [];
    return [{
      ...p,
      value: c.amount,
      currency: ctx.target,
      estimated: p.estimated || c.estimated,
      // A walked-back rate makes an OBSERVED point an estimate. It can only ever
      // degrade: an already-unreliable point is not rescued by its FX being fine,
      // and a reconstructed one does not become unreliable just because a rate
      // was walked back.
      confidence: c.estimated && p.confidence === "observed" ? "reconstructed" : p.confidence,
    }];
  });
}
