"use client";

/**
 * components/dashboard/widgets/transactions/TransactionsCalendarHeatmap.tsx
 *
 * The Transactions Tab's calendar view (§2.4) — a second, independent consumer
 * of the shared `CalendarHeatmapGrid`. It buckets the ALREADY-FETCHED,
 * ALREADY-FILTERED transaction list by day (net = money in − money out, per the
 * confirmed metric) and hands the grid a signed-net-per-day map plus a per-day
 * in/out tooltip. Zero new query — getTransactions() has no row cap, so the full
 * filtered list is already in memory.
 *
 * It carries NONE of Cash Flow's liquidity axis (no CALENDAR_MEASURES, no
 * tierResolver) — that was the whole reason CashFlowCalendar was not imported
 * directly (§2.4 / stop condition §9.9). It shares only the presentational grid.
 *
 * Honesty (§9.6): the grid renders a day OUTSIDE the loaded/filtered span as
 * UNAVAILABLE (faint), and an in-span day with no transactions as a NEUTRAL
 * empty cell — two different facts, two different looks. The `range` fed here is
 * exactly the filtered list's own [min, max] date span, so "no data loaded" and
 * "nothing happened that day" can never be conflated.
 */

import { useMemo } from "react";
import type { Transaction } from "@/types";
import {
  CalendarHeatmapGrid,
  type HeatmapTooltipRow,
} from "@/components/space/widgets/shared/CalendarHeatmapGrid";

/** The most-recent month grids to paint, NEWEST first, walking back from `end` to
 *  `start` and capped at `cap` (defensive, matches the grid's own ceiling). The
 *  Transactions "All Time" span can cover years; the shared monthsInRange caps from
 *  the OLDEST edge, which would strand the calendar on the first-ever month. This
 *  anchors on the newest activity instead — the ledger's default "Newest" reading —
 *  without touching the shared grid or its range/values. */
export function recentMonths(
  start: string,
  end: string,
  cap = 24,
): { year: number; month: number }[] {
  const sy = Number(start.slice(0, 4)), sm = Number(start.slice(5, 7));
  const out: { year: number; month: number }[] = [];
  let y = Number(end.slice(0, 4)), m = Number(end.slice(5, 7));
  while ((y > sy || (y === sy && m >= sm)) && out.length < cap) {
    out.push({ year: y, month: m });
    if (--m < 1) { m = 12; y--; }
  }
  return out;
}

/** Pure — signed net (money in − money out) per ISO day. `amountOf` returns the
 *  row's own signed, converted amount (positive = credit / in). */
export function bucketNetByDay(
  rows: readonly Transaction[],
  amountOf: (t: Transaction) => number,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of rows) m.set(t.date, (m.get(t.date) ?? 0) + amountOf(t));
  return m;
}

/** Pure — per-day money-in / money-out magnitudes for the tooltip breakdown. */
export function bucketInOutByDay(
  rows: readonly Transaction[],
  amountOf: (t: Transaction) => number,
): Map<string, { in: number; out: number }> {
  const m = new Map<string, { in: number; out: number }>();
  for (const t of rows) {
    const v = amountOf(t);
    const agg = m.get(t.date) ?? { in: 0, out: 0 };
    if (v >= 0) agg.in += v; else agg.out += -v;
    m.set(t.date, agg);
  }
  return m;
}

/** Pure — the [min, max] ISO-date span of the rows: the loaded/filtered range the
 *  grid paints. Null for an empty set (caller renders its own empty state). */
export function transactionsDateRange(
  rows: readonly Transaction[],
): { start: string; end: string } | null {
  if (rows.length === 0) return null;
  let start = rows[0].date, end = rows[0].date;
  for (const t of rows) {
    if (t.date < start) start = t.date;
    if (t.date > end) end = t.date;
  }
  return { start, end };
}

interface Props {
  /** The already-filtered transaction list (same universe as the table view). */
  transactions: Transaction[];
  /** Signed, converted amount accessor — the SAME one the summary bar uses, so
   *  the calendar's totals reconcile exactly with the chips. */
  amountOf: (t: Transaction) => number;
  /** Aggregate formatter (display currency) — same as the summary chips. */
  fmt: (n: number) => string;
}

export function TransactionsCalendarHeatmap({ transactions, amountOf, fmt }: Props) {
  const range  = useMemo(() => transactionsDateRange(transactions), [transactions]);
  const values = useMemo(() => bucketNetByDay(transactions, amountOf), [transactions, amountOf]);
  const inOut  = useMemo(() => bucketInOutByDay(transactions, amountOf), [transactions, amountOf]);
  // Newest month first — the calendar leads with the most recent activity (matching
  // the ledger's default "Newest" sort) instead of opening on the first-ever month.
  // Presentation only: the grid paints months in the order given; range/values and
  // the shared CalendarHeatmapGrid authority are untouched.
  const months = useMemo(() => (range ? recentMonths(range.start, range.end) : []), [range]);
  const max    = useMemo(() => {
    let m = 0;
    if (range) {
      for (const [iso, net] of values) {
        if (iso >= range.start && iso <= range.end) m = Math.max(m, Math.abs(net));
      }
    }
    return m;
  }, [values, range]);

  const tooltipRowsFor = useMemo(
    () => (iso: string, net: number): HeatmapTooltipRow[] => {
      const agg = inOut.get(iso);
      const body: HeatmapTooltipRow[] = [];
      if (agg && agg.in > 0)  body.push({ label: "Money in",  value: `+${fmt(agg.in)}`,  color: "var(--accent-positive)" });
      if (agg && agg.out > 0) body.push({ label: "Money out", value: `−${fmt(agg.out)}`, color: "var(--accent-negative)" });
      if (body.length === 0)  body.push({ label: "No activity", value: "", color: "var(--text-muted)" });
      const netColor = net > 0 ? "var(--accent-positive)" : net < 0 ? "var(--accent-negative)" : "var(--text-muted)";
      return [...body, { label: "Net", value: `${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}`, color: netColor, strong: true }];
    },
    [inOut, fmt],
  );

  if (!range) return null; // empty set — the parent renders the "no matches" state.

  return (
    <div className="p-4">
      <CalendarHeatmapGrid
        months={months}
        range={range}
        values={values}
        max={max}
        fmt={fmt}
        tooltipRowsFor={tooltipRowsFor}
      />
    </div>
  );
}
