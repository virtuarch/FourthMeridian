"use client";
import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { X } from "lucide-react";
import { Snapshot } from "@/types";
import { Interval, cutoffForInterval } from "./NetWorthChart";

interface Props {
  snapshots: Snapshot[];
  initialInterval: Interval;
  onClose: () => void;
}

const INTERVALS: { label: Interval; days: number | "ytd" }[] = [
  { label: "7D",  days: 7   },
  { label: "1M",  days: 30  },
  { label: "3M",  days: 90  },
  { label: "6M",  days: 180 },
  { label: "YTD", days: "ytd" },
  { label: "1Y",  days: 365 },
];

const SERIES = [
  { key: "netWorth",    label: "Net Worth", color: "#3b82f6" },
  { key: "totalAssets", label: "Assets",    color: "#10b981" },
  { key: "totalDebt",   label: "Debt",      color: "#ef4444" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0,
  }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n);

// X-axis: "09 Jun"
function tickFormat(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleDateString("en-GB", { month: "short" });
  return `${day} ${mon}`;
}

// Tooltip label: "09 Jun 2026"
function fmtTooltipDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = String(d.getDate()).padStart(2, "0");
  const mon = d.toLocaleDateString("en-GB", { month: "short" });
  return `${day} ${mon} ${d.getFullYear()}`;
}

// Pick ~5 evenly-spaced tick values from the data array
function evenTicks(dates: string[], count = 5): string[] {
  if (dates.length <= count) return dates;
  const step = (dates.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => dates[Math.round(i * step)]);
}

export function NetWorthChartModal({ snapshots, initialInterval, onClose }: Props) {
  const [interval, setInterval]         = useState<Interval>(initialInterval);
  const [active, setActive]             = useState<Set<SeriesKey>>(new Set(["netWorth"]));

  const filtered = useMemo(() => {
    const cutoff = cutoffForInterval(interval);
    return snapshots.filter((s) => s.date >= cutoff);
  }, [snapshots, interval]);

  const data = filtered.map((s) => ({
    date:        s.date,
    netWorth:    s.netWorth,
    totalAssets: s.totalAssets,
    totalDebt:   s.totalDebt,
  }));

  const ticks = useMemo(() => evenTicks(data.map((d) => d.date), 15), [data]);

  const available = INTERVALS.filter(({ label }) => {
    const cutoff = cutoffForInterval(label);
    return snapshots.some((s) => s.date >= cutoff);
  });

  function toggle(key: SeriesKey) {
    setActive((prev) => {
      if (prev.has(key) && prev.size === 1) return prev; // keep at least one
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-[100] flex bg-gray-900"
      onClick={onClose}
    >
      {/* Sheet — stops propagation so clicking inside doesn't close */}
      <div
        className="w-full h-full bg-gray-900 p-5 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-white">Net Worth</p>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors touch-manipulation"
          >
            <X size={16} />
          </button>
        </div>

        {/* Series toggles */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {SERIES.map(({ key, label, color }) => {
            const on = active.has(key);
            return (
              <button
                key={key}
                onClick={() => toggle(key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors touch-manipulation border"
                style={{
                  borderColor: on ? color : "#374151",
                  background:  on ? `${color}22` : "transparent",
                  color:       on ? color : "#6b7280",
                }}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: on ? color : "#374151" }}
                />
                {label}
              </button>
            );
          })}
        </div>

        {/* Interval selector */}
        <div className="flex items-center gap-1 mb-4 flex-wrap">
          {available.map(({ label }) => (
            <button
              key={label}
              onClick={() => setInterval(label)}
              className={`text-xs font-semibold px-2.5 py-2 rounded-lg transition-colors touch-manipulation ${
                interval === label
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Chart — flex-1 fills all remaining vertical space */}
        <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 48, left: 16 }}>
            <XAxis
              dataKey="date"
              ticks={ticks}
              tickFormatter={tickFormat}
              tick={{ fontSize: 11, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={fmt}
              tick={{ fontSize: 10, fill: "#6b7280", dx: -20 }}
              tickLine={false}
              axisLine={false}
              width={88}
            />
            <Tooltip
              contentStyle={{
                background: "#1f2937", border: "1px solid #374151",
                borderRadius: 8, fontSize: 12,
              }}
              formatter={(v, name) => {
                const series = SERIES.find((s) => s.key === name);
                return [fmtFull(Number(v)), series?.label ?? name];
              }}
              labelFormatter={(v) => fmtTooltipDate(v)}
              labelStyle={{ color: "#9ca3af" }}
              trigger="hover"
            />
            {SERIES.map(({ key, color }) =>
              active.has(key) ? (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: color, stroke: "#111827", strokeWidth: 2 }}
                />
              ) : null
            )}
          </LineChart>
        </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
