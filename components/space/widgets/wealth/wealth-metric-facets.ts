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
 */

import type { WealthMetricKey } from "./WealthTrendChart";
import type { WealthComposition } from "@/lib/wealth/wealth-time-machine";

/** A WealthComposition component id — the shape of a WealthDriver.id. */
export type WealthComponentId = keyof WealthComposition;

/** Which composition body the card renders for a metric. */
export type CompositionRegime = "assets" | "liabilities" | "liquid";

export const METRIC_COMPOSITION_REGIME: Record<WealthMetricKey, CompositionRegime> = {
  netWorth:         "assets",       // assets donut + a liabilities contribution row
  totalAssets:      "assets",       // assets donut, NO liabilities row
  totalLiabilities: "liabilities",  // debt composition (present-day)
  liquidNetWorth:   "liquid",       // liquidity ladder (present-day)
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
};

/** Possessive phrase for headings ("What moved <phrase>?"). */
export const METRIC_POSSESSIVE: Record<WealthMetricKey, string> = {
  netWorth:         "your net worth",
  totalAssets:      "your assets",
  totalLiabilities: "your liabilities",
  liquidNetWorth:   "your liquid net worth",
};

/** True only for Net Worth — the one metric whose composition shows the
 *  liabilities contribution alongside the assets donut. */
export function showsLiabilityContribution(metric: WealthMetricKey): boolean {
  return metric === "netWorth";
}
