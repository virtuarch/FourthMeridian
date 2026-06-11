"use client";
import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Snapshot } from "@/types";
import { Interval, cutoffForInterval } from "./NetWorthChart";

interface Props {
  snapshots: Snapshot[];
  interval: Interval;
  onIntervalChange: (i: Interval) => void;
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
  { key: "stocks", label: "Stocks",  color: "#8b5cf6" },
  { key: "crypto", label: "Crypto",  color: "#f59e0b" },
] as const;

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

function tickFormat(dateStr: string, interval: Interval): string {
  const d = new Date(dateStr + "T12:00:00");
  if (interval === "7D") return d.toLocaleDateString("en-US", { weekday: "short" });
  if (interval === "1Y" || interval === "YTD")
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function InvestmentsChart({ snapshots, interval, onIntervalChange }: Props) {
  const filtered = useMemo(() => {
    const cutoff = cutoffForInterval(interval);
    return snapshots.filter((s) => s.date >= cutoff);
  }, [snapshots, interval]);

  const data = filtered.map((s) => ({
    date:   s.date,
    stocks: s.totalInvestments,
    crypto: s.totalCrypto,
  }));

  const available = INTERVALS.filter(({ label }) => {
    const cutoff = cutoffForInterval(label);
    return snapshots.some((s) => s.date >= cutoff);
  });

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
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={(v) => tickFormat(v, interval)}
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={fmt}
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          <Tooltip
            contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
            formatter={(v, name) => {
              const s = SERIES.find((s) => s.key === name);
              return [fmtFull(Number(v)), s?.label ?? name];
            }}
            labelFormatter={(v) => new Date(v + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            labelStyle={{ color: "#9ca3af" }}
            trigger="hover"
          />
          {SERIES.map(({ key, color }) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: color, stroke: "#111827", strokeWidth: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <div className="flex items-center gap-4 mt-2">
        {SERIES.map(({ key, label, color }) => (
          <span key={key} className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className="w-3 h-0.5 rounded-full inline-block" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
