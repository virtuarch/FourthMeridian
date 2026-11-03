"use client";

/**
 * components/space/widgets/liquidity/LiquidityBalanceHistory.tsx
 *
 * Liquidity Balance History — ALL cash over time (checking + savings, RESTRICTED cash
 * included). It is the SAME honesty chart as Net Worth / Investments / Debt (the shared
 * TrendChart core: same interaction model, same As-of/Compare-to window, same
 * observed/reconstructed trust treatment, same brand-neutral line).
 *
 * ⚠️ FIN-005 part 1 — the series is NOT "Available now". The snapshot stores no
 * restricted split, so HSA and retirement cash are in every point while the hero's
 * figure excludes them. The chart therefore states its own basis — title/legend
 * "All cash (incl. restricted)" plus a basis note — from the slice's `basis`
 * (CASH_HISTORY_BASIS_PRESENTATION), and never uses the hero's "accessible" wording.
 *
 * The series is the CashHistorySlice — already clipped to the shell window
 * [compareTo … asOf] and per-date FX-converted by the workspace (clipCashHistory +
 * convertCashHistory) — so this component only projects it to TrendPoint and hands it
 * over. No clipping, valuation, or FX here.
 */

import { useMemo } from "react";
import { CASH_HISTORY_BASIS_PRESENTATION, type CashHistorySlice } from "@/lib/liquidity/cash-history";
import { TrendChart, type TrendPoint } from "@/components/space/widgets/charts/TrendChart";

export function LiquidityBalanceHistory({
  history,
  currency,
  onSelectPoint,
}: {
  /** The window-clipped, FX-converted ALL-cash slice. null ⇒ no in-window history. */
  history:   CashHistorySlice | null;
  currency:  string;
  asOf:      string;
  compareTo: string | null;
  /** v2.6 — open the shared explorer at the LIQUIDITY root. */
  onSelectPoint?: (dateISO: string) => void;
}) {
  // Already clipped by the pure helper; project to the chart's point shape (cashNow is
  // the value; a backfilled row is reconstructed).
  const trendPoints: TrendPoint[] = useMemo(
    () => (history?.points ?? []).map((p) => ({ date: p.date, value: p.cashNow, estimated: p.isEstimated })),
    [history],
  );

  // FIN-005 — the basis the slice declares; ALL_CASH is the only one today, so an
  // absent slice (no history) still labels the chart truthfully.
  const basis = CASH_HISTORY_BASIS_PRESENTATION[history?.basis ?? "ALL_CASH"];

  return (
    <div data-cash-history-basis={history?.basis ?? "ALL_CASH"}>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]" data-cash-history-label>
        {basis.label}
      </p>
      <TrendChart
        onSelectPoint={onSelectPoint}
        points={trendPoints}
        currency={currency}
        ariaLabel={`${basis.label} over time`}
        emptyMessage="No cash history in this range yet. Widen the range or connect accounts to build history."
      />
      <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-cash-history-basis-note>{basis.note}</p>
    </div>
  );
}
