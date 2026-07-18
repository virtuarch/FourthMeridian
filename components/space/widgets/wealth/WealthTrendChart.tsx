"use client";

/**
 * components/space/widgets/wealth/WealthTrendChart.tsx
 *
 * The Net Worth workspace's Balance History — the metric switcher (Net Worth /
 * Assets / Liabilities / Liquid) over the canonical WealthResult, rendered through
 * the SHARED honesty plotter (components/space/widgets/charts/TrendChart). The
 * plotting core (observed/reconstructed lines, no-data hatch, hover, legend) now
 * lives once in TrendChart so Net Worth and Investments read as one system; this
 * file owns only the Wealth-specific bits: the metric options and the WealthResult
 * → points mapping. The chart owns no time state — range/asOf/compare are the shell's.
 */

import { useState } from "react";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { Chips } from "@/components/atlas/Chips";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";

export type WealthMetricKey = "netWorth" | "totalAssets" | "totalLiabilities" | "liquidNetWorth";

const METRICS: { key: WealthMetricKey; label: string; title: string }[] = [
  { key: "netWorth",         label: "Net Worth",   title: "net worth" },
  { key: "totalAssets",      label: "Assets",      title: "total assets" },
  { key: "totalLiabilities", label: "Liabilities", title: "total liabilities" },
  { key: "liquidNetWorth",   label: "Liquid NW",   title: "liquid net worth" },
];

export function WealthTrendChart({
  result,
  currency,
  metric: controlledMetric,
  onMetricChange,
}: {
  result:          WealthResult;
  currency:        string;
  metric?:         WealthMetricKey;
  onMetricChange?: (m: WealthMetricKey) => void;
}) {
  const [internalMetric, setInternalMetric] = useState<WealthMetricKey>("netWorth");
  const metric = controlledMetric ?? internalMetric;
  const metricDef = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  const setMetric = (m: WealthMetricKey) => { setInternalMetric(m); onMetricChange?.(m); };

  const points: TrendPoint[] = result.chart.points.map((p) => ({
    date: p.date, value: p[metric], estimated: p.isEstimated,
  }));

  const subtitle =
    result.chart.compareDate
      ? `${formatWealthDate(result.chart.asOfDate ?? result.asOf)} vs ${formatWealthDate(result.chart.compareDate)}`
      : result.chart.asOfDate
        ? `As of ${formatWealthDate(result.chart.asOfDate)}`
        : `${metricDef.title} over time`;

  return (
    <TrendChart
      points={points}
      currency={currency}
      title="Balance history"
      subtitle={subtitle}
      ariaLabel={`${metricDef.title} over time`}
      emptyMessage="No snapshot history in this range yet. Widen the range or connect accounts to build history."
      formatDate={formatWealthDate}
      headerRight={
        <Chips
          options={METRICS.map((m) => ({ id: m.key, label: m.label }))}
          value={metric}
          onChange={setMetric}
          ariaLabel="Chart metric"
        />
      }
    />
  );
}
