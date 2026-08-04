"use client";

/**
 * components/space/widgets/investments/InvestmentsBalanceHistory.tsx
 *
 * Investments Balance History — "how has my invested wealth changed over time?" It is
 * the SAME honesty chart as the Net Worth workspace (the shared TrendChart core: same
 * interaction model, same As-of/Compare-to window, same observed/reconstructed trust
 * treatment). Only the data MEANING differs: the series is the canonical persisted
 * portfolio value (investments + crypto, no double-count) rather than net worth.
 *
 * The series is a Space-level resource served alongside the contract and already
 * display-converted by the Workspace; this component clips it to the shell window
 * (compareTo … asOf) and hands the points to TrendChart. No metric switcher — invested
 * value is one series, not four.
 */

import { useMemo } from "react";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import type { PortfolioValuePoint } from "@/lib/investments/portfolio-series";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";

export function InvestmentsBalanceHistory({
  points,
  currency,
  asOf,
  compareTo,
  onSelectPoint,
}: {
  points:    PortfolioValuePoint[];
  currency:  string;
  asOf:      string;
  compareTo: string | null;
  /** V26-S3-DETAIL — passed straight through; this component decides nothing. */
  onSelectPoint?: (dateISO: string) => void;
}) {
  // Clip to the shell window (end travels with asOf; start at compareTo when set) —
  // the same windowing the shell's time controls drive for every temporal surface.
  // V26-INVESTMENTS-HISTORY — `confidence` and `coverageLabel` are carried
  // through VERBATIM. They were classified and worded upstream (the series
  // builder, from the snapshot's persisted completeness); this component only
  // clips the window and renames `confidence` to the chart's `basis` slot. It
  // reads no tier, compares no count, and writes no copy.
  const trendPoints: TrendPoint[] = useMemo(
    () =>
      points
        .filter((p) => p.date <= asOf && (!compareTo || p.date >= compareTo))
        .map((p) => ({
          date: p.date, value: p.value, estimated: p.estimated,
          basis: p.confidence, coverageLabel: p.coverageLabel,
        })),
    [points, asOf, compareTo],
  );

  const subtitle = compareTo
    ? `${formatWealthDate(asOf)} vs ${formatWealthDate(compareTo)}`
    : `As of ${formatWealthDate(asOf)}`;

  return (
    <TrendChart
      points={trendPoints}
      currency={currency}
      title="Balance history"
      subtitle={subtitle}
      ariaLabel="Invested value over time"
      emptyMessage="No portfolio history in this range yet. Widen the range or connect accounts to build history."
      formatDate={formatWealthDate}
      onSelectPoint={onSelectPoint}
    />
  );
}
