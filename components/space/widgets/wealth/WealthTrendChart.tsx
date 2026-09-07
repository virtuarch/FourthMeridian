"use client";

/**
 * components/space/widgets/wealth/WealthTrendChart.tsx
 *
 * The Net Worth page's Balance History — one series of the canonical WealthResult
 * rendered through the SHARED honesty plotter (components/space/widgets/charts/
 * TrendChart). The plotting core (observed/reconstructed lines, no-data hatch,
 * hover, legend) lives once in TrendChart so Net Worth, Debt and the former
 * Investments / Liquidity charts read as one system; this file owns only the
 * Wealth-specific bits: the series titles and the WealthResult → points mapping.
 *
 * OVERVIEW-CONSOLIDATION — the series switcher no longer lives in this header.
 * The page SUBJECT (Total · Assets · Debt) is the page-level selector above the
 * hero; inside Assets the caller passes the All · Cash · Investments slice
 * control through `headerRight`. The chart owns no time state and no selection
 * state — `metric` is the shell's resolved series.
 */

import type { ReactNode } from "react";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import type { WealthMetricKey } from "@/lib/wealth/wealth-mode";
import type { PortfolioValuePoint } from "@/lib/investments/portfolio-series";
import { TrendChart } from "@/components/space/widgets/charts/TrendChart";
import { projectWealthTrendPoints } from "./wealth-trend-points";

export type { WealthMetricKey } from "@/lib/wealth/wealth-mode";

/** Series copy — every plottable series, including the retained legacy ones. */
export const WEALTH_SERIES_TITLE: Record<WealthMetricKey, string> = {
  netWorth:         "net worth",
  totalAssets:      "total assets",
  totalLiabilities: "total liabilities",
  liquidNetWorth:   "liquid net worth",
  cash:             "cash",
  invested:         "invested value",
};

export function WealthTrendChart({
  result,
  currency,
  metric = "netWorth",
  investedSeries,
  headerRight,
  onSelectPoint,
}: {
  result:          WealthResult;
  currency:        string;
  /** The series to plot — resolved by the page (mode + slice), never chosen here. */
  metric?:         WealthMetricKey;
  /** The canonical Investments series for the `invested` slice's per-point trust. */
  investedSeries?: readonly PortfolioValuePoint[] | null;
  /** The caller's slice control (Assets: All · Cash · Investments), if any. */
  headerRight?:    ReactNode;
  /** v2.6 — open the shared historical exploration sheet for a clicked point. */
  onSelectPoint?:  (dateISO: string) => void;
}) {
  const title = WEALTH_SERIES_TITLE[metric];
  const points = projectWealthTrendPoints(result, metric, investedSeries);

  const subtitle =
    result.chart.compareDate
      ? `${formatWealthDate(result.chart.asOfDate ?? result.asOf)} vs ${formatWealthDate(result.chart.compareDate)}`
      : result.chart.asOfDate
        ? `As of ${formatWealthDate(result.chart.asOfDate)}`
        : `${title} over time`;

  return (
    <TrendChart
      onSelectPoint={onSelectPoint}
      points={points}
      currency={currency}
      title="Balance history"
      subtitle={subtitle}
      ariaLabel={`${title} over time`}
      emptyMessage="No snapshot history in this range yet. Widen the range or connect accounts to build history."
      formatDate={formatWealthDate}
      headerRight={headerRight}
    />
  );
}
