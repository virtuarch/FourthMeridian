"use client";
import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { X } from "lucide-react";
import { Snapshot } from "@/types";
import { Interval, cutoffForInterval } from "./NetWorthChart";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { GlassPanel } from "@/components/atlas/GlassPanel";

interface Props {
  snapshots: Snapshot[];
  initialInterval: Interval;
  onClose: () => void;
  /** Which series tab opens pre-selected — lets KPI tiles (Net Worth/Total
   *  Assets/Total Liabilities) all open this same chart/modal, just focused
   *  on their own number, instead of each needing its own chart. */
  initialSeries?: SeriesKey;
}

const INTERVALS: { label: Interval; days: number | "ytd" }[] = [
  { label: "7D",  days: 7   },
  { label: "1M",  days: 30  },
  { label: "3M",  days: 90  },
  { label: "6M",  days: 180 },
  { label: "YTD", days: "ytd" },
  { label: "1Y",  days: 365 },
];

// Literal hex (not CSS var) — these mirror the Fourth Meridian design
// tokens (--meridian-500/--emerald-500/--coral-500) exactly, but Recharts
// needs a concrete color string for its series strokes, and these three
// are theme-independent constants anyway (same hex in Midnight and Light
// Glass), unlike text/surface colors below which do need to stay var()-driven.
const SERIES = [
  { key: "netWorth",    label: "Net Worth", color: "#3B82F6" },
  { key: "totalAssets", label: "Assets",    color: "#22C55E" },
  { key: "totalDebt",   label: "Debt",      color: "#ED5247" },
] as const;

export type SeriesKey = (typeof SERIES)[number]["key"];

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, notation: "compact", maximumFractionDigits: 0,
  }).format(n);

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0,
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

const MODAL_TITLE: Record<SeriesKey, string> = {
  netWorth: "Net Worth", totalAssets: "Total Assets", totalDebt: "Total Liabilities",
};

export function NetWorthChartModal({ snapshots, initialInterval, onClose, initialSeries }: Props) {
  const [interval, setInterval]         = useState<Interval>(initialInterval);
  const [active, setActive]             = useState<Set<SeriesKey>>(new Set([initialSeries ?? "netWorth"]));

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
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      return next;
    });
  }

  return (
    // Backdrop — translucent + blurred, matching the rest of the app's
    // glass-modal recipe (CreateSpaceModal/AddWalletModal/AccountModal),
    // instead of the old opaque full-bleed bg-gray-900 takeover.
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-2 sm:p-4"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      {/* Sheet — stops propagation so clicking inside doesn't close */}
      <GlassPanel
        depth="thick"
        elevation="e4"
        radius="xl"
        className="w-full h-[94dvh] sm:h-auto sm:max-w-3xl sm:max-h-[88dvh]"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="h-full sm:max-h-[88dvh] p-5 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between mb-4 shrink-0">
            <p className="text-sm font-semibold text-[var(--text-primary)]">{MODAL_TITLE[initialSeries ?? "netWorth"]}</p>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors touch-manipulation"
            >
              <X size={16} />
            </button>
          </div>

          {/* Series toggles */}
          <div className="flex items-center gap-2 mb-4 flex-wrap shrink-0">
            {SERIES.map(({ key, label, color }) => {
              const on = active.has(key);
              return (
                <button
                  key={key}
                  onClick={() => toggle(key)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-semibold transition-colors touch-manipulation border"
                  style={{
                    borderColor: on ? color : "var(--border-hairline-strong)",
                    background:  on ? `${color}1F` : "transparent",
                    color:       on ? color : "var(--text-muted)",
                  }}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: on ? color : "var(--border-hairline-strong)" }}
                  />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Interval selector */}
          <div className="flex items-center gap-1 mb-4 flex-wrap shrink-0">
            {available.map(({ label }) => (
              <button
                key={label}
                onClick={() => setInterval(label)}
                className={`text-xs font-semibold px-2.5 py-2 rounded-[var(--radius-sm)] transition-colors touch-manipulation ${
                  interval === label
                    ? "text-[var(--meridian-400)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                }`}
                style={
                  interval === label
                    ? { background: "rgba(59,130,246,.14)", border: "1px solid rgba(125,168,255,.32)" }
                    : { border: "1px solid transparent" }
                }
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
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tickFormatter={fmt}
                  tick={{ fontSize: 10, fill: "var(--text-muted)", dx: -20 }}
                  tickLine={false}
                  axisLine={false}
                  width={88}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--glass-thick)", border: "1px solid var(--border-hairline-strong)",
                    borderRadius: 8, fontSize: 12, backdropFilter: "blur(20px)",
                  }}
                  formatter={(v, name) => {
                    const series = SERIES.find((s) => s.key === name);
                    return [fmtFull(Number(v)), series?.label ?? name];
                  }}
                  labelFormatter={(v) => fmtTooltipDate(v)}
                  labelStyle={{ color: "var(--text-secondary)" }}
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
                      activeDot={{ r: 4, fill: color, stroke: "var(--bg-base)", strokeWidth: 2 }}
                    />
                  ) : null
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
