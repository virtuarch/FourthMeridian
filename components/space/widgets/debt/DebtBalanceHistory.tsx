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
import type { DebtHistorySlice } from "@/lib/debt-space-data";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";
import { useSpaceIdContext } from "@/components/space/space-id-context";
import { useSpaceBalanceCoverage } from "@/components/space/PerspectiveEmptyState";
import { debtTrendPoints } from "./debt-trend-points";
import { balanceChartPending, clipToBalanceCoverage } from "@/lib/connections/balance-coverage.core";

export function DebtBalanceHistory({
  history,
  currency,
  onSelectPoint,
  showPartialHistory = false,
}: {
  /** The window-clipped, FX-converted Balance-Over-Time slice. null ⇒ no in-window history. */
  history:   DebtHistorySlice | null;
  currency:  string;
  asOf:      string;
  compareTo: string | null;
  /** v2.6 — open the shared historical exploration sheet at the DEBT root. */
  onSelectPoint?: (dateISO: string) => void;
  /** B12 O-3 — the viewer opted in to the partial days before the coverage floor. */
  showPartialHistory?: boolean;
}) {
  // Already clipped by the contract; project to the chart's point shape (totalDebt is
  // the value; a backfilled row is reconstructed).
  // PB-8 — days before a liability's balance-history floor are drawn PARTIAL.
  const balanceCoverage = useSpaceBalanceCoverage(useSpaceIdContext());
  const trendPoints: TrendPoint[] = useMemo(
    // B12 O-3 — by default the plot STARTS at the coverage floor; opted in, the
    // partial days are drawn, marked partial as above.
    () => clipToBalanceCoverage(debtTrendPoints(history, balanceCoverage), balanceCoverage, ["liability"], showPartialHistory),
    [history, balanceCoverage, showPartialHistory],
  );
  // B12 P3 — while that read is in flight the chart HOLDS its placeholder
  // instead of flashing the unclipped series; FAILED / nothing to cover render now.
  const pending = balanceChartPending(balanceCoverage, ["liability"], showPartialHistory);


  return (
    <TrendChart
      onSelectPoint={onSelectPoint}
      points={pending ? [] : trendPoints}
      pending={pending}
      currency={currency}
      ariaLabel="Total debt over time"
      emptyMessage="No debt history in this range yet. Widen the range or connect accounts to build history."
    />
  );
}
