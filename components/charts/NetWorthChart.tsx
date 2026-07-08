"use client";
import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Snapshot } from "@/types";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currency-context";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import { ChartFirstDayPlaceholder } from "./ChartFirstDayPlaceholder";
import { EstimatedHistoryBadge } from "./EstimatedHistoryBadge";

export type Interval = "7D" | "1M" | "3M" | "6M" | "YTD" | "1Y";

interface Props {
  snapshots:        Snapshot[];
  interval:         Interval;
  onIntervalChange: (i: Interval) => void;
  cashMode?:        boolean;
  fill?:            boolean;
  /**
   * MC1 — effective conversion context (e.g. the Personal "view as" override).
   * When provided together with `snapshotCurrency`, each point is CONVERTED at
   * its own date before formatting, so the plotted values (not just the axis
   * label) move to the target currency. Omitted ⇒ existing consumers plot the
   * raw stamped values unchanged. `useDisplayCurrency()` still owns formatting.
   */
  ctx?:             ConversionContext;
  /**
   * The currency the snapshot totals are stamped in (the Space's reporting
   * currency) — the "from" currency for conversion. Required alongside `ctx`.
   */
  snapshotCurrency?: string;
}

const INTERVALS: { label: Interval; days: number | "ytd" }[] = [
  { label: "7D",  days: 7   },
  { label: "1M",  days: 30  },
  { label: "3M",  days: 90  },
  { label: "6M",  days: 180 },
  { label: "YTD", days: "ytd" },
  { label: "1Y",  days: 365 },
];

const fmtBase = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 0 }).format(n);

const fmtFullBase = (n: number, cur: string = DEFAULT_DISPLAY_CURRENCY) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);

export function cutoffForInterval(interval: Interval): string {
  const now = new Date();
  if (interval === "YTD") return `${now.getFullYear()}-01-01`;
  const days = INTERVALS.find((i) => i.label === interval)!.days as number;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

function tickFormat(dateStr: string, interval: Interval): string {
  const d = new Date(dateStr + "T12:00:00");
  if (interval === "7D") return d.toLocaleDateString("en-US", { weekday: "short" });
  if (interval === "1Y" || interval === "YTD") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function NetWorthChart({ snapshots, interval, onIntervalChange, cashMode = false, fill = false, ctx, snapshotCurrency }: Props) {
  // MC1 Phase 4 Slice 1 (D-1) — aggregate surfaces format in the Space's
  // reporting currency; USD fallback when no provider is mounted.
  const displayCurrency = useDisplayCurrency();
  const fmt = (n: number) => fmtBase(n, displayCurrency); // MC1 P4 Slice 1 — aggregate display currency
  const fmtFull = (n: number) => fmtFullBase(n, displayCurrency); // MC1 P4 Slice 1 — aggregate display currency
  const filtered = useMemo(() => {
    const cutoff = cutoffForInterval(interval);
    return snapshots.filter((s) => s.date >= cutoff);
  }, [snapshots, interval]);

  // MC1 — CONVERT each point at its OWN date through the effective context
  // before formatting (the fix for "symbol changes, value doesn't"). Without a
  // ctx/snapshotCurrency pair (every existing consumer) the raw stamped value
  // passes through unchanged. The identity fast path (target === snapshotCurrency)
  // is a no-op, so the saved-currency chart stays byte-identical; only a real
  // "view as" override moves the values. A rate miss returns the native amount
  // flagged estimated (D-3) → surfaces the badge below.
  const { data, conversionEstimated } = useMemo(() => {
    const rows = filtered.map((s) => {
      const raw = cashMode ? s.totalCash : s.netWorth;
      if (ctx && snapshotCurrency) {
        const c = convertMoney({ amount: raw, currency: snapshotCurrency }, s.date, ctx);
        return { date: s.date, netWorth: c.amount, estimated: c.estimated };
      }
      return { date: s.date, netWorth: raw, estimated: false };
    });
    return { data: rows, conversionEstimated: rows.some((r) => r.estimated) };
  }, [filtered, ctx, snapshotCurrency, cashMode]);

  const available = INTERVALS.filter(({ label }) => {
    const cutoff = cutoffForInterval(label);
    return snapshots.some((s) => s.date >= cutoff);
  });

  // fill=true uses a taller fixed height on desktop; both paths use an explicit
  // pixel height so ResponsiveContainer never receives -1 from the DOM.
  const chartHeight = fill ? 260 : 180;

  // Only one snapshot exists yet — show the day-one explainer instead of a
  // near-empty chart.
  if (snapshots.length === 1) {
    const s = snapshots[0];
    const raw = cashMode ? s.totalCash : s.netWorth;
    const value = ctx && snapshotCurrency
      ? convertMoney({ amount: raw, currency: snapshotCurrency }, s.date, ctx).amount
      : raw;
    return (
      <ChartFirstDayPlaceholder
        value={value}
        date={s.date}
        height={chartHeight}
      />
    );
  }

  const hasEstimated = filtered.some((s) => s.isEstimated) || conversionEstimated;

  return (
    <div>
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {available.map(({ label }) => (
          <button
            key={label}
            onClick={() => onIntervalChange(label)}
            className={`text-xs font-semibold px-2.5 py-2 rounded-lg transition-colors touch-manipulation ${
              interval === label
                ? "bg-blue-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            {label}
          </button>
        ))}
        {hasEstimated && (
          <span className="ml-auto">
            <EstimatedHistoryBadge />
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={chartHeight}>
          <AreaChart
            data={data}
            // Y-axis clipping fix: left is 0 (was -20). A negative left margin
            // pulled the axis band off the container's left edge and truncated
            // the tick labels ("$8K", "-$3K", …) in narrow cards. Still
            // width="100%" responsive; no horizontal scroll added.
            margin={{ top: 4, right: 4, bottom: 4, left: 0 }}
          >
            <defs>
              <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tickFormatter={(v: string) => tickFormat(v, interval)}
              tick={{ fontSize: 10, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              padding={{ left: 12, right: 4 }}
            />
            <YAxis
              tickFormatter={fmt}
              tick={{ fontSize: 10, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              // Reserve room for the widest compact label incl. a leading
              // "-"/"$" (e.g. "-$120K"); the old 44px clipped negatives.
              // Reserved inside the responsive container ⇒ no horizontal scroll.
              width={54}
            />
          <Tooltip
            contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
            formatter={(v) => [fmtFull(Number(v)), cashMode ? "Cash" : "Net Worth"]}
            labelFormatter={(v) => new Date(v + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            labelStyle={{ color: "#9ca3af" }}
            trigger="hover"
          />
          <Area
            type="monotone"
            dataKey="netWorth"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#nwGrad)"
            dot={false}
            activeDot={{ r: 4, fill: "#3b82f6", stroke: "#111827", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
