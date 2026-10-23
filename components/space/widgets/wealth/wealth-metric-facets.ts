/**
 * components/space/widgets/wealth/wealth-metric-facets.ts
 *
 * V25-CLOSE-4A — presentation FACETS of the four wealth metrics.
 *
 * This is NOT an authority and creates NO aggregation: every number still comes
 * from WealthResult (deltas / drivers / composition). This module only answers
 * three presentation questions the Composition card and the Change ledger both
 * need, in ONE place so they cannot disagree:
 *
 *   1. which composition REGIME does a metric render? (assets vs liabilities vs
 *      liquid — a liabilities metric must never draw an assets donut)
 *   2. which driver COMPONENTS belong to a metric's change story? (so "What moved
 *      your assets" excludes the liabilities driver, and reconciles to
 *      deltas.totalAssets)
 *   3. what POSSESSIVE phrase names it? ("your net worth" / "your assets" / …)
 *
 * The component sets are a partition-consistent view of WealthComposition's five
 * components {cash, investments, crypto, real, liabilities}, where `cash` already
 * folds checking+savings (wealth-time-machine.toState) and `liabilities` is the
 * debt scalar. They are chosen so a metric's driver rows reconcile with its
 * delta:
 *   totalAssets    = cash + investments + crypto + real           (sum of parts)
 *   totalLiabilities = liabilities                                 (the one part)
 *   liquidNetWorth = cash − liabilities  (cash folds savings; liabilities = debt)
 *   netWorth       = assets − liabilities                          (all five)
 *   cash           = cash                     (OVERVIEW-CONSOLIDATION: the Cash slice)
 *   invested       = investments + crypto     (the Investments slice — disjoint from cash)
 */

import type { WealthMetricKey } from "@/lib/wealth/wealth-mode";
import type { WealthComposition, WealthMetrics } from "@/lib/wealth/wealth-time-machine";

/** A WealthComposition component id — the shape of a WealthDriver.id. */
export type WealthComponentId = keyof WealthComposition;

/** Which composition body the card renders for a metric. */
export type CompositionRegime = "assets" | "liabilities" | "liquid";

export const METRIC_COMPOSITION_REGIME: Record<WealthMetricKey, CompositionRegime> = {
  netWorth:         "assets",       // assets donut + a liabilities contribution row
  totalAssets:      "assets",       // assets donut, NO liabilities row
  totalLiabilities: "liabilities",  // debt composition (present-day)
  liquidNetWorth:   "liquid",       // liquidity ladder (present-day)
  cash:             "assets",       // the Assets slices keep the assets donut (the whole is the subject)
  invested:         "assets",
};

/**
 * The driver components whose deltas make up a metric's change.
 * Ordered assets-first, liabilities last (the ledger's reading order).
 */
export const METRIC_DRIVER_COMPONENTS: Record<WealthMetricKey, WealthComponentId[]> = {
  netWorth:         ["cash", "investments", "crypto", "real", "liabilities"],
  totalAssets:      ["cash", "investments", "crypto", "real"],
  totalLiabilities: ["liabilities"],
  liquidNetWorth:   ["cash", "liabilities"],
  cash:             ["cash"],
  invested:         ["investments", "crypto"],
};

/** Possessive phrase for headings ("What moved <phrase>?"). */
export const METRIC_POSSESSIVE: Record<WealthMetricKey, string> = {
  netWorth:         "your net worth",
  totalAssets:      "your assets",
  totalLiabilities: "your liabilities",
  liquidNetWorth:   "your liquid net worth",
  cash:             "your cash",
  invested:         "your investments",
};

/** True only for Net Worth — the one metric whose composition shows the
 *  liabilities contribution alongside the assets donut. */
export function showsLiabilityContribution(metric: WealthMetricKey): boolean {
  return metric === "netWorth";
}

/**
 * The headline TOTAL of the "Where it sits" card for a metric — the figure in
 * the middle of the donut.
 *
 * The donut's slices are ASSET classes, so the presenter's own total (Σ slices)
 * is total ASSETS. In Net Worth mode the card is about net worth, and printing
 * Σ assets in its centre overstated the user's position by every dollar they
 * owe: the liabilities sat in a side row labelled "shown separately" and were
 * never subtracted from the number the eye lands on.
 *
 * The total is READ from the resolved snapshot state (`netWorth` — the canonical
 * aggregate), never rebuilt from the slices or from presentation values. The
 * assets / liabilities legs ride along so the card can show the reconciliation
 *     assets − liabilities = net worth
 * and `reconciles` reports whether the canonical triple actually satisfies it
 * (within a cent) — a snapshot that does not is shown its stated net worth and
 * NOT a locally "corrected" one.
 *
 * Returns null for every other metric: their total IS the slices they draw.
 */
export interface WhereItSitsTotal {
  /** The canonical net worth of the resolved snapshot. */
  value:       number;
  label:       string;
  assets:      number;
  liabilities: number;
  reconciles:  boolean;
}

export function whereItSitsTotal(
  metric: WealthMetricKey,
  state:  Pick<WealthMetrics, "netWorth" | "totalAssets" | "totalLiabilities">,
): WhereItSitsTotal | null {
  if (!showsLiabilityContribution(metric)) return null;
  return {
    value:       state.netWorth,
    label:       "net worth",
    assets:      state.totalAssets,
    liabilities: state.totalLiabilities,
    reconciles:  Math.abs(state.totalAssets - state.totalLiabilities - state.netWorth) < 0.005,
  };
}
