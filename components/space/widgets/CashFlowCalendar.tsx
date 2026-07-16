"use client";

/**
 * components/space/widgets/CashFlowCalendar.tsx
 *
 * Compact calendar visualization for Cash Flow History (UX-PER-3 refinement).
 * Daily net cash flow as a month grid — one calendar for month scale, three
 * mini calendars for a quarter, twelve for a year. Cells are short, low-padding
 * squares tinted by net (subtle green/red, muted for no-activity) so the whole
 * widget stays legible without internal scrolling. Day amounts live in a
 * hover/focus tooltip rather than inside the cell, keeping height down.
 *
 * CF-3 — the Calendar consumes the SHARED two-perspective projection
 * (cash-flow-projection.ts, `projectDailyFacts`): one pass over BOTH canonical
 * axes, from which the caller's `perspective` + `measures` select what each day
 * shows. It classifies NOTHING itself and reconciles exactly with the Summary
 * for the same rows/perspective. A credit-card-heavy user switches to the
 * Economic perspective (or the "All spending" / "Credit-card spending" measures)
 * to see real daily spending that the liquidity axis correctly excludes.
 *
 * Presentation (the month grid, day cells, tint, tooltip chrome) lives in the
 * shared, metric-agnostic `CalendarHeatmapGrid` — this component supplies only
 * the domain content: the per-day net (from the liquidity/economic measures) and
 * the per-measure tooltip breakdown. The extraction is behavior-neutral; the DOM
 * rendered here is identical to the prior inline grid.
 */

import { useMemo } from "react";
import type { ConversionContext } from "@/lib/money/types";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { Transaction } from "@/types";
import {
  monthsInRange,
  periodRange,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import {
  projectDailyFacts, netOfMeasures, CALENDAR_MEASURES,
  type CalendarMeasureId, type DayFacts,
} from "@/lib/transactions/cash-flow-projection";
import {
  CalendarHeatmapGrid,
  type HeatmapTooltipRow,
} from "@/components/space/widgets/shared/CalendarHeatmapGrid";

interface Props {
  transactions: Transaction[];
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  /** Account tiers — the Calendar resolves the liquidity axis via these. */
  accounts:     { id: string; type: string }[];
  /** CF-3 — which measures each day sums into its net (see CALENDAR_MEASURES). */
  measures:     CalendarMeasureId[];
  /** Click a day cell → open its transactions. Hover tooltip stays summary-only. */
  onSelectDay?: (iso: string, label: string) => void;
  /** All Time — bound the visible span to this single calendar year instead of
   *  the period's range (whose sentinel 0000–9999 would emit garbage grids). The
   *  daily projection still runs over ALL passed rows; only this year is painted. */
  viewYear?:    number;
  /** SD-6C — the pre-projected per-day facts from CashFlowSpaceData (the workspace
   *  composition boundary). When supplied the Calendar consumes it instead of
   *  re-running `projectDailyFacts` over `transactions` — the byte-identical map
   *  (same authority, same rows), so the heatmap is unchanged. Absent ⇒ the
   *  standalone/registry path projects it here, exactly as before. */
  daily?:       Map<string, DayFacts>;
}

export function CashFlowCalendar({ transactions, period, ctx, accounts, measures, onSelectDay, viewYear, daily: dailyProp }: Props) {
  // When viewYear is set (All Time), the visible span is exactly that one year;
  // otherwise it is the period's own range. The sentinel All-Time range is never
  // fed to monthsInRange — that is the whole reason for this prop.
  const range  = useMemo(
    () => (viewYear != null ? { start: `${viewYear}-01-01`, end: `${viewYear}-12-31` } : periodRange(period)),
    [period, viewYear],
  );
  const daily  = useMemo(
    () => dailyProp ?? projectDailyFacts(transactions as LiquidityTx[], tierResolver(accounts), ctx),
    [dailyProp, transactions, accounts, ctx],
  );
  const months = useMemo(() => monthsInRange(range.start, range.end), [range]);

  const currency = ctx?.target ?? DEFAULT_DISPLAY_CURRENCY;
  const fmt = useMemo(() => {
    return ctx
      ? (n: number) => formatCurrency(n, currency)
      : (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  }, [ctx, currency]);

  // Per-day net of the selected measures (Σ in − Σ out) — the signed magnitude
  // the shared grid tints by. Built once from the projection.
  const values = useMemo(() => {
    const m = new Map<string, number>();
    for (const [iso, facts] of daily) m.set(iso, netOfMeasures(facts, measures).net);
    return m;
  }, [daily, measures]);

  // Tint scale is the max magnitude among the VISIBLE (in-range) days only, so a
  // bounded single year under All Time gets meaningful contrast instead of being
  // washed out by a huge day in some other year. For non-ALL periods the passed
  // rows are already period-filtered, so this is identical to the old behavior.
  const max = useMemo(() => {
    let m = 0;
    for (const [iso, net] of values) {
      if (iso >= range.start && iso <= range.end) m = Math.max(m, Math.abs(net));
    }
    return m;
  }, [values, range]);

  // The per-day tooltip breakdown — non-zero measure lines, or "No activity",
  // always followed by the Net row. Identical content to the prior inline cell.
  const tooltipRowsFor = useMemo(() => (iso: string, net: number): HeatmapTooltipRow[] => {
    const data = daily.get(iso);
    const lines = data
      ? measures
          .map((id) => ({ m: CALENDAR_MEASURES[id], v: CALENDAR_MEASURES[id].value(data) }))
          .filter((l) => l.v > 0)
      : [];
    const body: HeatmapTooltipRow[] = lines.length > 0
      ? lines.map((l) => ({
          label: l.m.label,
          value: `${l.m.direction === "in" ? "+" : "−"}${fmt(l.v)}`,
          color: l.m.direction === "in" ? "var(--accent-positive)" : "var(--accent-negative)",
        }))
      : [{ label: "No activity", value: "", color: "var(--text-muted)" }];
    const netColor = net > 0 ? "var(--accent-positive)" : net < 0 ? "var(--accent-negative)" : "var(--text-muted)";
    return [...body, { label: "Net", value: `${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}`, color: netColor, strong: true }];
  }, [daily, measures, fmt]);

  return (
    <CalendarHeatmapGrid
      months={months}
      range={range}
      values={values}
      max={max}
      fmt={fmt}
      tooltipRowsFor={tooltipRowsFor}
      onSelectDay={onSelectDay}
    />
  );
}
