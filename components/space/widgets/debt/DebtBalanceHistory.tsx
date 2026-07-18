"use client";

/**
 * components/space/widgets/debt/DebtBalanceHistory.tsx
 *
 * Debt Balance History — "how has what I owe changed over time?" It is the SAME honesty
 * chart as the Net Worth workspace (the shared TrendChart core: same interaction model,
 * same As-of/Compare-to window, same observed/reconstructed trust treatment, same
 * brand-neutral line — Net Worth draws its own "Liabilities" metric in exactly this
 * chart). Only the data MEANING differs: the series is total debt owed, not net worth.
 * There is ONE chart, not a debt look-alike.
 *
 * The series is the canonical DebtSpaceData.history slice — already clipped to the shell
 * window [compareTo … asOf] and per-date FX-converted by the workspace (convertDebtHistory)
 * — so this component only projects it to TrendPoint and hands it over. No clipping,
 * valuation, or FX here.
 */

import { useMemo } from "react";
import { formatDate } from "@/lib/format";
import type { DebtHistorySlice } from "@/lib/debt-space-data";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";

export function DebtBalanceHistory({
  history,
  currency,
  asOf,
  compareTo,
}: {
  /** The window-clipped, FX-converted Balance-Over-Time slice. null ⇒ no in-window history. */
  history:   DebtHistorySlice | null;
  currency:  string;
  asOf:      string;
  compareTo: string | null;
}) {
  // Already clipped by the contract; project to the chart's point shape (totalDebt is
  // the value; a backfilled row is reconstructed).
  const trendPoints: TrendPoint[] = useMemo(
    () => (history?.points ?? []).map((p) => ({ date: p.date, value: p.totalDebt, estimated: p.isEstimated })),
    [history],
  );

  const subtitle = compareTo ? `${formatDate(asOf)} vs ${formatDate(compareTo)}` : `As of ${formatDate(asOf)}`;

  return (
    <TrendChart
      points={trendPoints}
      currency={currency}
      title="Balance history"
      subtitle={subtitle}
      ariaLabel="Total debt over time"
      emptyMessage="No debt history in this range yet. Widen the range or connect accounts to build history."
    />
  );
}
