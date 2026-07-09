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
 * It computes nothing new: `dailyCashFlow` supplies FlowType-aware per-day
 * income / spend / refunds / net (same doctrine as the summary). Presentation
 * only.
 */

import { useMemo } from "react";
import type { ConversionContext } from "@/lib/money/types";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { Transaction } from "@/types";
import {
  dailyCashFlow,
  monthsInRange,
  periodRange,
  type CashFlowPeriod,
  type DayCashFlow,
} from "@/lib/transactions/cash-flow";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const POS = "34,197,94";   // green-500
const NEG = "239,68,68";   // red-500

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Subtle background tint for a day's net, scaled to the period max. */
function cellBg(net: number, max: number): string {
  if (net === 0 || max <= 0) return "var(--surface-inset)";
  const alpha = 0.14 + 0.5 * Math.min(1, Math.abs(net) / max);
  return `rgba(${net > 0 ? POS : NEG},${alpha.toFixed(3)})`;
}

/** Day-number color. On strong positive/negative cells the muted grey washes
 *  out against the tint, so brighten the number to a clear, hue-matched shade;
 *  weak / no-activity cells keep the quiet muted grey. */
function cellText(net: number, max: number): string {
  if (net === 0 || max <= 0) return "var(--text-muted)";
  const intensity = Math.abs(net) / max;
  if (intensity < 0.4) return "var(--text-muted)";
  return net > 0 ? "rgb(134,239,172)" /* green-300 */ : "rgb(252,165,165)" /* red-300 */;
}

/** Deterministic, measurement-free tooltip placement that stays inside the
 *  widget: flip below for the top row, and anchor to the cell's left/right edge
 *  for the outer columns instead of centering (which would overflow). */
function tooltipPlacement(col: number, row: number): string {
  const vertical = row === 0 ? "top-full mt-1" : "bottom-full mb-1";
  const horizontal =
    col <= 1 ? "left-0"
    : col >= 5 ? "right-0"
    : "left-1/2 -translate-x-1/2";
  return `${vertical} ${horizontal}`;
}

// ─── Day cell (with hover/focus tooltip) ──────────────────────────────────────

interface DayCellProps {
  iso:    string;
  day:    number;
  data?:  DayCashFlow;
  bg:     string;
  text:   string;
  col:    number;   // 0–6 within the week row (for tooltip placement)
  row:    number;   // 0-based week row (for tooltip placement)
  size:   "full" | "mini";
  fmt:    (n: number) => string;
}

function DayCell({ iso, day, data, bg, text, col, row, size, fmt }: DayCellProps) {
  const net = data?.net ?? 0;
  const dateLabel = new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const netColor = net > 0 ? "var(--accent-positive)" : net < 0 ? "var(--accent-negative)" : "var(--text-muted)";

  return (
    <div className={`group relative ${size === "full" ? "h-7" : "h-4"}`}>
      <button
        type="button"
        aria-label={`${dateLabel}: net ${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}`}
        className="w-full h-full rounded flex items-center justify-center focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
        style={{ background: bg }}
      >
        <span className={`${size === "full" ? "text-[10px]" : "text-[8px]"} leading-none font-medium`} style={{ color: text }}>{day}</span>
      </button>

      {/* Tooltip — absolute, so it never changes layout or widget height. Placement
          flips/shifts by cell position so it never clips outside the widget. Shows
          on hover AND keyboard focus (focus-within). pointer-events-none keeps it
          from stealing interaction / perturbing any drag source. */}
      <div
        role="tooltip"
        className={`pointer-events-none absolute z-50 hidden group-hover:block group-focus-within:block ${tooltipPlacement(col, row)}`}
      >
        <div
          className="rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-2xl"
          style={{
            // Fully opaque floating card — no frosted-glass translucency, so
            // calendar cells underneath never bleed through or reduce contrast.
            background: "#1f2027",
            border: "1px solid var(--border-hairline-strong)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
          }}
        >
          <p className="text-[10px] font-semibold text-[var(--text-primary)] mb-1">{dateLabel}</p>
          <div className="space-y-0.5 text-[10px] tabular-nums">
            <Row label="Income"   value={`+${fmt(data?.income ?? 0)}`} color="var(--accent-positive)" />
            <Row label="Spending" value={`−${fmt(data?.spend ?? 0)}`}  color="var(--accent-negative)" />
            {(data?.refunds ?? 0) > 0 && <Row label="Refunds" value={fmt(data?.refunds ?? 0)} color="var(--text-secondary)" />}
            <Row label="Net" value={`${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}`} color={netColor} strong />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, color, strong }: { label: string; value: string; color: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={strong ? "text-[var(--text-secondary)] font-medium" : "text-[var(--text-muted)]"}>{label}</span>
      <span style={{ color }} className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}

// ─── Month grid ───────────────────────────────────────────────────────────────

interface MonthGridProps {
  year:   number;
  month:  number;                  // 1–12
  daily:  Map<string, DayCashFlow>;
  max:    number;
  range:  { start: string; end: string };
  size:   "full" | "mini";
  fmt:    (n: number) => string;
}

function MonthGrid({ year, month, daily, max, range, size, fmt }: MonthGridProps) {
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth  = new Date(year, month, 0).getDate();
  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: size === "full" ? "long" : "short",
    ...(size === "full" ? { year: "numeric" } : {}),
  });

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const isFull = size === "full";

  return (
    <div>
      <p className={`font-semibold text-[var(--text-secondary)] ${isFull ? "text-xs mb-1.5" : "text-[10px] mb-1"}`}>
        {monthLabel}
      </p>
      {isFull && (
        <div className="grid grid-cols-7 gap-0.5 mb-0.5">
          {WEEKDAYS.map((w, i) => (
            <div key={i} className="text-center text-[9px] text-[var(--text-faint)]">{w}</div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          const col = i % 7, gridRow = Math.floor(i / 7);
          if (d == null) return <div key={i} aria-hidden className={isFull ? "h-7" : "h-4"} />;
          const iso = `${year}-${pad(month)}-${pad(d)}`;
          const inRange = iso >= range.start && iso <= range.end;
          if (!inRange) {
            return (
              <div key={i} className={`${isFull ? "h-7 text-[10px]" : "h-4 text-[8px]"} flex items-center justify-center text-[var(--text-faint)] opacity-25`}>
                {d}
              </div>
            );
          }
          const data = daily.get(iso);
          const net = data?.net ?? 0;
          return (
            <DayCell
              key={i} iso={iso} day={d} data={data}
              bg={cellBg(net, max)} text={cellText(net, max)}
              col={col} row={gridRow} size={size} fmt={fmt}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

interface Props {
  transactions: Transaction[];
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
}

export function CashFlowCalendar({ transactions, period, ctx }: Props) {
  const range  = useMemo(() => periodRange(period), [period]);
  const daily  = useMemo(() => dailyCashFlow(transactions, ctx), [transactions, ctx]);
  const months = useMemo(() => monthsInRange(range.start, range.end), [range]);
  const max    = useMemo(
    () => Math.max(0, ...[...daily.values()].map((v) => Math.abs(v.net))),
    [daily],
  );

  const currency = ctx?.target ?? DEFAULT_DISPLAY_CURRENCY;
  const fmt = useMemo(() => {
    return ctx
      ? (n: number) => formatCurrency(n, currency)
      : (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  }, [ctx, currency]);

  const size: "full" | "mini" = months.length <= 1 ? "full" : "mini";
  const gridCls =
    months.length <= 1 ? "grid-cols-1"
    : months.length <= 3 ? "grid-cols-1 sm:grid-cols-3"
    : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";

  return (
    <div className="space-y-2.5">
      <div className={`grid ${gridCls} gap-x-4 gap-y-3`}>
        {months.map(({ year, month }) => (
          <MonthGrid
            key={`${year}-${month}`}
            year={year} month={month}
            daily={daily} max={max} range={range} size={size} fmt={fmt}
          />
        ))}
      </div>
      <div className="flex items-center gap-4 pt-0.5 text-[10px] text-[var(--text-faint)]">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: `rgba(${POS},.5)` }} /> Net positive</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: `rgba(${NEG},.5)` }} /> Net negative</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--surface-inset)]" /> No activity</span>
      </div>
    </div>
  );
}
