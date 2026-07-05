"use client";
import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Snapshot } from "@/types";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { ChartFirstDayPlaceholder } from "./ChartFirstDayPlaceholder";
import { EstimatedHistoryBadge } from "./EstimatedHistoryBadge";

export type Interval = "7D" | "1M" | "3M" | "6M" | "YTD" | "1Y";

interface Props {
  snapshots:        Snapshot[];
  interval:         Interval;
  onIntervalChange: (i: Interval) => void;
  cashMode?:        boolean;
  fill?:            boolean;
}

const INTERVALS: { label: Interval; days: number | "ytd" }[] = [
  { label: "7D",  days: 7   },
  { label: "1M",  days: 30  },
  { label: "3M",  days: 90  },
  { label: "6M",  days: 180 },
  { label: "YTD", days: "ytd" },
  { label: "1Y",  days: 365 },
];

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 0 }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(n);

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

export function NetWorthChart({ snapshots, interval, onIntervalChange, cashMode = false, fill = false }: Props) {
  const filtered = useMemo(() => {
    const cutoff = cutoffForInterval(interval);
    return snapshots.filter((s) => s.date >= cutoff);
  }, [snapshots, interval]);

  const data = filtered.map((s) => ({
    date:     s.date,
    netWorth: cashMode ? s.totalCash : s.netWorth,
  }));

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
    return (
      <ChartFirstDayPlaceholder
        value={cashMode ? s.totalCash : s.netWorth}
        date={s.date}
        height={chartHeight}
      />
    );
  }

  const hasEstimated = filtered.some((s) => s.isEstimated);

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
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -20 }}>
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
              width={44}
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
