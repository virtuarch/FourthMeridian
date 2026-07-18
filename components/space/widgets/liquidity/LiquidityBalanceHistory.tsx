"use client";

/**
 * components/space/widgets/liquidity/LiquidityBalanceHistory.tsx
 *
 * Liquidity Balance History — "how much money could I reach right now, over time?"
 * It is the SAME honesty chart as Net Worth / Investments / Debt (the shared TrendChart
 * core: same interaction model, same As-of/Compare-to window, same observed/reconstructed
 * trust treatment, same brand-neutral line). Only the data MEANING differs: the series is
 * the cashNow tier (accessible cash — checking + savings), not net worth or debt owed.
 * There is ONE chart, not a liquidity look-alike.
 *
 * The series is the CashHistorySlice — already clipped to the shell window
 * [compareTo … asOf] and per-date FX-converted by the workspace (clipCashHistory +
 * convertCashHistory) — so this component only projects it to TrendPoint and hands it
 * over. No clipping, valuation, or FX here.
 */

import { useMemo } from "react";
import { formatDate } from "@/lib/format";
import type { CashHistorySlice } from "@/lib/liquidity/cash-history";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";

export function LiquidityBalanceHistory({
  history,
  currency,
  asOf,
  compareTo,
}: {
  /** The window-clipped, FX-converted accessible-cash slice. null ⇒ no in-window history. */
  history:   CashHistorySlice | null;
  currency:  string;
  asOf:      string;
  compareTo: string | null;
}) {
  // Already clipped by the pure helper; project to the chart's point shape (cashNow is
  // the value; a backfilled row is reconstructed).
  const trendPoints: TrendPoint[] = useMemo(
    () => (history?.points ?? []).map((p) => ({ date: p.date, value: p.cashNow, estimated: p.isEstimated })),
    [history],
  );

  const subtitle = compareTo ? `${formatDate(asOf)} vs ${formatDate(compareTo)}` : `As of ${formatDate(asOf)}`;

  return (
    <TrendChart
      points={trendPoints}
      currency={currency}
      title="Balance history"
      subtitle={subtitle}
      ariaLabel="Accessible cash over time"
      emptyMessage="No cash history in this range yet. Widen the range or connect accounts to build history."
    />
  );
}
