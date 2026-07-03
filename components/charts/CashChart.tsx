"use client";
import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { Snapshot } from "@/types";
import { Interval, cutoffForInterval } from "./NetWorthChart";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { ChartFirstDayPlaceholder } from "./ChartFirstDayPlaceholder";

interface Props {
  snapshots:        Snapshot[];
  interval:         Interval;
  onIntervalChange: (i: Interval) => void;
  investableCash?:  number; // current flat reference value for uninvested brokerage/crypto cash
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
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 1,
  }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(n);

function tickFormat(dateStr: string, interval: Interval): string {
  const d = new Date(dateStr + "T12:00:00");
  if (interval === "7D") return d.toLocaleDateString("en-US", { weekday: "short" });
  if (interval === "1Y" || interval === "YTD")
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function CashChart({ snapshots, interval, onIntervalChange, investableCash = 0 }: Props) {
  const filtered = useMemo(() => {
    const cutoff = cutoffForInterval(interval);
    return snapshots.filter((s) => s.date >= cutoff);
  }, [snapshots, interval]);

  const hasInvestable = investableCash > 0;

  // Only one snapshot exists yet (e.g. right after a space's first
  // refresh) — a single point can't draw a trend line, so show the day-one
  // explainer instead of a near-empty chart.
  if (snapshots.length === 1) {
    const s = snapshots[0];
    return (
      <ChartFirstDayPlaceholder
        value={s.totalCash + s.totalSavings + (hasInvestable ? investableCash : 0)}
        date={s.date}
      />
    );
  }

  const data = filtered.map((s) => ({
    date:       s.date,
    checking:   s.totalCash,
    savings:    s.totalSavings,
    investable: hasInvestable ? investableCash : undefined,
  }));

  const available = INTERVALS.filter(({ label }) => {
    const cutoff = cutoffForInterval(label);
    return snapshots.some((s) => s.date >= cutoff);
  });

  return (
    <div>
      {/* ── Interval selector ── */}
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

      {/* ── Chart ── */}
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="checkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}    />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => tickFormat(v, interval)}
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
            formatter={(v, name) => [
              fmtFull(Number(v)),
              name === "checking" ? "Checking" : name === "savings" ? "Savings" : "Brokerage Cash",
            ]}
            labelFormatter={(v) => new Date(v + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            labelStyle={{ color: "#9ca3af" }}
            trigger="hover"
          />
          <Line
            type="monotone" dataKey="checking"
            stroke="#3b82f6" strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#3b82f6", stroke: "#111827", strokeWidth: 2 }}
          />
          <Line
            type="monotone" dataKey="savings"
            stroke="#10b981" strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#10b981", stroke: "#111827", strokeWidth: 2 }}
          />
          {hasInvestable && (
            <Line
              type="monotone" dataKey="investable"
              stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 4, fill: "#8b5cf6", stroke: "#111827", strokeWidth: 2 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* ── Legend ── */}
      <div className="flex items-center gap-4 mt-2 flex-wrap">
        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className="w-3 h-0.5 bg-blue-500 rounded-full inline-block" /> Checking
        </span>
        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className="w-3 h-0.5 bg-emerald-500 rounded-full inline-block" /> Savings
        </span>
        {hasInvestable && (
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className="w-3 h-px border-t-2 border-dashed border-violet-500 inline-block" /> Brokerage Cash
          </span>
        )}
      </div>
    </div>
  );
}
