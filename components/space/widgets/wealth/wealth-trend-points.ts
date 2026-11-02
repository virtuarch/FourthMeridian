/**
 * components/space/widgets/wealth/wealth-trend-points.ts  (OVERVIEW-CONSOLIDATION)
 *
 * The PURE projection WealthResult → TrendChart points, for every series the
 * Net Worth page can plot (Total, Assets, and the Cash / Investments slices).
 *
 * Every series is read straight off the chart points the read model already
 * carries — no arithmetic here. The one thing this module ADDS is trust for the
 * Investments slice: the Investments lens plotted a richer, three-state
 * confidence (`observed` / `reconstructed` / `unreliable`) plus a
 * "N of M positions valued" disclosure, both classified by the canonical
 * portfolio-series authority (lib/investments/portfolio-series.ts). When the
 * unified Assets chart is sliced to Investments those disclosures are JOINED
 * onto the wealth window by date, so they survive the move — and a date the
 * portfolio authority REFUSED (unassertable crypto) is dropped from the slice
 * rather than plotted from a bare snapshot total. The series values themselves
 * are identical by construction (both are stocks + crypto on the same row); a
 * test pins that.
 */

import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import type { WealthMetricKey } from "@/lib/wealth/wealth-mode";
import type { PortfolioValuePoint } from "@/lib/investments/portfolio-series";
import type { TrendPoint } from "@/components/space/widgets/charts/TrendChart";
import { markPartialBalanceCoverage, balanceCoverageSidesFor, type BalanceCoverage } from "@/lib/connections/balance-coverage.core";

/** The series whose value INCLUDES the real-asset component (computeSnapshotFields). */
const REAL_ASSET_SERIES: ReadonlySet<WealthMetricKey> = new Set<WealthMetricKey>(["netWorth", "totalAssets"]);

export function projectWealthTrendPoints(
  result: WealthResult,
  metric: WealthMetricKey,
  /** The canonical Investments series (same snapshot rows), for the `invested`
   *  slice's per-point trust. Absent ⇒ the slice plots with the wealth two-state
   *  estimate flag only (a caller that has no portfolio series). */
  investedSeries?: readonly PortfolioValuePoint[] | null,
  /** PB-8 — the Space's balance floors. Points before the latest floor this
   *  series is composed from are marked PARTIAL (values unchanged). Absent ⇒
   *  byte-identical to before. */
  balanceCoverage?: BalanceCoverage | null,
): TrendPoint[] {
  const points = result.chart.points;
  if (metric !== "invested" || !investedSeries) {
    return markPartialBalanceCoverage(points.map((p): TrendPoint => ({
      date: p.date, value: p[metric], estimated: p.isEstimated,
      // RWA-2B — a reconstructed point whose real-asset component is MODELED
      // (a straight line between two of the user's dated estimates) is drawn
      // with the RWA-2A "modeled" basis, so the legend says modeled and the
      // tooltip says "not a market price" — never observed, and not merely
      // "rebuilt" either. Only the two series that contain real assets.
      ...(p.realAssetsModeled && p.isEstimated && REAL_ASSET_SERIES.has(metric) ? { basis: "modeled" as const } : {}),
    })), balanceCoverage ?? null, balanceCoverageSidesFor(metric));
  }
  const byDate = new Map(investedSeries.map((p) => [p.date, p] as const));
  const out: TrendPoint[] = [];
  for (const p of points) {
    const inv = byDate.get(p.date);
    // Refused by the Investments authority (unassertable crypto) ⇒ a real gap.
    if (!inv) continue;
    out.push({
      date:          p.date,
      value:         p.invested,
      estimated:     p.isEstimated || inv.estimated,
      basis:         inv.confidence,
      coverageLabel: inv.coverageLabel,
    });
  }
  return out;
}
