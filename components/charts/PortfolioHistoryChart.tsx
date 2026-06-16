"use client";

import { useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { ChartFirstDayPlaceholder } from "./ChartFirstDayPlaceholder";

export interface ChartSeries {
  key: string;
  label: string;
  color: string; // hex
}

interface DataPoint {
  date: string;
  [key: string]: number | string;
}

interface Props {
  data: DataPoint[];
  series: ChartSeries[];
  activeKeys: string[];
  title?: string;
}

const INTERVALS = [
  { label: "7D",  days: 7 },
  { label: "1M",  days: 30 },
  { label: "3M",  days: 90 },
  { label: "6M",  days: 180 },
  { label: "1Y",  days: 365 },
];

const fmtCompact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: DEFAULT_DISPLAY_CURRENCY,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: DEFAULT_DISPLAY_CURRENCY,
    maximumFractionDigits: 0,
  }).format(n);

function fmtAxisDate(dateStr: string, days: number) {
  const d = new Date(dateStr);
  if (days <= 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  if (days <= 90) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export function PortfolioHistoryChart({ data, series, activeKeys, title }: Props) {
  // Determine which intervals are available given the data length
  const availableIntervals = INTERVALS.filter((i) => data.length >= i.days);

  // Default to the largest available interval
  const defaultLabel = availableIntervals[availableIntervals.length - 1]?.label ?? "7D";
  const [selectedLabel, setSelectedLabel] = useState(defaultLabel);

  // If the selected interval is no longer available (e.g. data shrinks), fall back gracefully
  const effectiveInterval =
    availableIntervals.find((i) => i.label === selectedLabel) ??
    availableIntervals[availableIntervals.length - 1] ??
    INTERVALS[0];

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const slicedData = useMemo(
    () => data.slice(-effectiveInterval.days),
    [data, effectiveInterval.days]
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const activeSeries = series.filter((s) => activeKeys.includes(s.key));

  // Only one data point exists yet (e.g. right after a workspace's first
  // refresh) — a single point can't draw a trend line, so show the day-one
  // explainer instead of a near-empty chart. Headline sums the active
  // series' values for that one point (e.g. just "cash", or "total").
  if (data.length === 1) {
    const point = data[0];
    const value = activeSeries.reduce((sum, s) => sum + (Number(point[s.key]) || 0), 0);
    return (
      <div className="rounded-2xl border border-gray-700 bg-gray-900 p-5">
        {title && (
          <p className="text-sm font-semibold text-gray-300 shrink-0 mb-4">{title}</p>
        )}
        <ChartFirstDayPlaceholder value={value} date={point.date} height={220} />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-700 bg-gray-900 p-5">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        {title && (
          <p className="text-sm font-semibold text-gray-300 shrink-0">{title}</p>
        )}

        {/* Interval selector */}
        <div className="flex items-center gap-1 ml-auto">
          {INTERVALS.map(({ label }) => {
            const available = availableIntervals.some((i) => i.label === label);
            const active = label === effectiveInterval.label;
            return (
              <button
                key={label}
                onClick={() => available && setSelectedLabel(label)}
                disabled={!available}
                className={`text-xs font-semibold px-2.5 py-2.5 rounded-lg transition-colors touch-manipulation ${
                  active
                    ? "bg-blue-600 text-white"
                    : available
                    ? "text-gray-400 hover:text-white hover:bg-gray-800"
                    : "text-gray-700 cursor-not-allowed"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Legend (only when multiple series visible) */}
      {activeSeries.length > 1 && (
        <div className="flex items-center gap-4 mb-3 flex-wrap">
          {activeSeries.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-xs text-gray-400">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={slicedData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
          <defs>
            {activeSeries.map((s) => (
              <linearGradient key={s.key} id={`phc_grad_${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={s.color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={(v) => fmtAxisDate(v, effectiveInterval.days)}
            tick={{ fill: "#6b7280", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />

          <YAxis
            tickFormatter={fmtCompact}
            tick={{ fill: "#6b7280", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={58}
          />

          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "12px",
              fontSize: 13,
            }}
            labelStyle={{ color: "#9ca3af", fontSize: 12, marginBottom: 4 }}
            formatter={(value, name) => {
              const s = series.find((s) => s.key === name);
              return [fmtFull(Number(value)), s?.label ?? String(name)];
            }}
            trigger="click"
          />

          {activeSeries.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#phc_grad_${s.key})`}
              dot={false}
              activeDot={{ r: 4, fill: s.color, stroke: "#111827", strokeWidth: 2 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
