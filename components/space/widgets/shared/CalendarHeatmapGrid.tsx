"use client";

/**
 * components/space/widgets/shared/CalendarHeatmapGrid.tsx
 *
 * Metric-agnostic month-grid heat map — the presentation-only primitive shared
 * by the Cash Flow calendar and the Transactions calendar. Extracted verbatim
 * from `CashFlowCalendar.tsx` (day cells tinted by a signed magnitude, a
 * hover/focus tooltip, "full" size for one month / "mini" for a quarter or year,
 * click-a-day → open callback) with ONE seam added: the per-day tooltip body is
 * supplied by the caller as a plain data array (`HeatmapTooltipRow[]`), so this
 * component knows nothing about liquidity measures, FlowType, or any domain axis.
 *
 * It takes a caller-built `Map<iso, number>` of signed day magnitudes, a value
 * formatter, a `tooltipRowsFor` builder, and an `onSelectDay` callback — no
 * measures/tier/liquidity concepts inside it at all. Both consumers render
 * identical DOM; the only difference is what each puts in the tooltip and the
 * value map.
 */

import { useState, type ReactNode } from "react";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const POS = "34,197,94";   // green-500
const NEG = "239,68,68";   // red-500

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Subtle background tint for a day's net, scaled to the period max. */
export function cellBg(net: number, max: number): string {
  if (net === 0 || max <= 0) return "var(--surface-inset)";
  const alpha = 0.14 + 0.5 * Math.min(1, Math.abs(net) / max);
  return `rgba(${net > 0 ? POS : NEG},${alpha.toFixed(3)})`;
}

/** Day-number color. On strong positive/negative cells the muted grey washes
 *  out against the tint, so brighten the number to a clear, hue-matched shade;
 *  weak / no-activity cells keep the quiet muted grey. */
export function cellText(net: number, max: number): string {
  if (net === 0 || max <= 0) return "var(--text-muted)";
  const intensity = Math.abs(net) / max;
  if (intensity < 0.4) return "var(--text-muted)";
  return net > 0 ? "rgb(134,239,172)" /* green-300 */ : "rgb(252,165,165)" /* red-300 */;
}

/** Deterministic, measurement-free tooltip placement that stays inside the
 *  widget: flip below for the top row, and anchor to the cell's left/right edge
 *  for the outer columns instead of centering (which would overflow). */
export function tooltipPlacement(col: number, row: number): string {
  const vertical = row === 0 ? "top-full mt-1" : "bottom-full mb-1";
  const horizontal =
    col <= 1 ? "left-0"
    : col >= 5 ? "right-0"
    : "left-1/2 -translate-x-1/2";
  return `${vertical} ${horizontal}`;
}

/** Responsive cell size: one month renders "full", multi-month renders "mini".
 *  Pure function of the visible month count (identical to the pre-extraction rule). */
export function heatmapSize(monthCount: number): "full" | "mini" {
  return monthCount <= 1 ? "full" : "mini";
}

/** Outer responsive column count, keyed to the visible month count. */
export function heatmapGridCls(monthCount: number): string {
  return monthCount <= 1 ? "grid-cols-1"
    : monthCount <= 3 ? "grid-cols-1 sm:grid-cols-3"
    : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}

// ── Tooltip row (caller-supplied semantic content) ────────────────────────────

export interface HeatmapTooltipRow {
  label:  string;
  value:  string;
  color:  string;
  strong?: boolean;
}

export interface HeatmapMonth {
  year:  number;
  month: number;   // 1–12
}

function Row({ label, value, color, strong }: HeatmapTooltipRow) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={strong ? "text-[var(--text-secondary)] font-medium" : "text-[var(--text-muted)]"}>{label}</span>
      <span style={{ color }} className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}

// ── Day cell (with hover/focus tooltip) ───────────────────────────────────────

interface DayCellProps {
  iso:    string;
  day:    number;
  net:    number;
  bg:     string;
  text:   string;
  col:    number;   // 0–6 within the week row (for tooltip placement)
  row:    number;   // 0-based week row (for tooltip placement)
  size:   "full" | "mini";
  fmt:    (n: number) => string;
  tooltipRows: HeatmapTooltipRow[];
  onSelect?: (iso: string, label: string) => void;
}

function DayCell({ iso, day, net, bg, text, col, row, size, fmt, tooltipRows, onSelect }: DayCellProps) {
  const dateLabel = new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  /**
   * UX-CLOSE-2B — preview is CONTROLLED, not `group-hover:`/`group-focus-within:`.
   *
   * Pure-CSS hover could not be dismissed, and clicking a day left it stuck: the
   * detail panel portals to <body>, so the pointer never leaves the cell and no
   * mouseleave fires, while `focus-within` was additionally held by the button
   * the click had just focused. The tooltip then sat at z-50 under the panel's
   * z-100 — visible beside the panel, describing a day the user had already
   * opened.
   *
   * Hover and selection are now separate lifecycles: hover is transient preview,
   * click is persistent detail, and a click ends the preview immediately.
   *
   * Keyboard focus still previews, but tracked via :focus-visible rather than
   * focus-within — so a MOUSE click (which does not match :focus-visible) leaves
   * no preview behind, while Tab still shows one. This also means focus
   * returning to the cell when the panel closes re-previews only for keyboard
   * users, which is where it is wanted.
   */
  const [hovering, setHovering] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const previewing = hovering || keyboardFocus;

  const endPreview = () => { setHovering(false); setKeyboardFocus(false); };

  return (
    <div
      className={`group relative ${size === "full" ? "h-7" : "h-4"}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        aria-label={`${dateLabel}: net ${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}. Open transactions.`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onSelect ? () => { endPreview(); onSelect(iso, dateLabel); } : undefined}
        onFocus={(e) => setKeyboardFocus(e.currentTarget.matches(":focus-visible"))}
        onBlur={() => setKeyboardFocus(false)}
        className={`w-full h-full rounded flex items-center justify-center focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)] ${onSelect ? "cursor-pointer" : ""}`}
        style={{ background: bg }}
      >
        <span className={`${size === "full" ? "text-[10px]" : "text-[8px]"} leading-none font-medium`} style={{ color: text }}>{day}</span>
      </button>

      {/* Tooltip — absolute, so it never changes layout or widget height. Placement
          flips/shifts by cell position so it never clips outside the widget.
          pointer-events-none keeps it from stealing interaction / perturbing any
          drag source. */}
      <div
        role="tooltip"
        className={`pointer-events-none absolute z-50 ${previewing ? "block" : "hidden"} ${tooltipPlacement(col, row)}`}
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
            {tooltipRows.map((r, i) => (
              <Row key={i} label={r.label} value={r.value} color={r.color} strong={r.strong} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Month grid ────────────────────────────────────────────────────────────────

interface MonthGridProps {
  year:   number;
  month:  number;                  // 1–12
  values: Map<string, number>;
  max:    number;
  range:  { start: string; end: string };
  size:   "full" | "mini";
  fmt:    (n: number) => string;
  tooltipRowsFor: (iso: string, net: number) => HeatmapTooltipRow[];
  onSelectDay?: (iso: string, label: string) => void;
}

function MonthGrid({ year, month, values, max, range, size, fmt, tooltipRowsFor, onSelectDay }: MonthGridProps) {
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
            // Outside the loaded/selected span — UNAVAILABLE (no data here), a
            // different fact from an in-range day with zero activity below.
            return (
              <div key={i} className={`${isFull ? "h-7 text-[10px]" : "h-4 text-[8px]"} flex items-center justify-center text-[var(--text-faint)] opacity-25`}>
                {d}
              </div>
            );
          }
          const net = values.get(iso) ?? 0;
          return (
            <DayCell
              key={i} iso={iso} day={d} net={net}
              bg={cellBg(net, max)} text={cellText(net, max)}
              col={col} row={gridRow} size={size} fmt={fmt}
              tooltipRows={tooltipRowsFor(iso, net)}
              onSelect={onSelectDay}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Heat-map grid (months + legend) ───────────────────────────────────────────

const DEFAULT_LEGEND = { positive: "Net positive", negative: "Net negative", neutral: "No activity" };

export interface CalendarHeatmapGridProps {
  /** The months to paint, in order (each a {year, month:1–12}). */
  months: HeatmapMonth[];
  /** The visible/loaded span — days outside it render as unavailable, not zero. */
  range:  { start: string; end: string };
  /** iso → signed day magnitude. A missing in-range iso is a no-activity (net 0)
   *  day; the caller decides what "net" means (this component never classifies). */
  values: Map<string, number>;
  /** Max |net| among the visible days, for tint scaling. */
  max:    number;
  /** Value formatter (currency). */
  fmt:    (n: number) => string;
  /** Per-day tooltip body rows — the caller's semantic content (measure lines,
   *  a spend line, a Net row, or a "No activity" row, as it sees fit). */
  tooltipRowsFor: (iso: string, net: number) => HeatmapTooltipRow[];
  /** Click a day cell → open its detail. Omit for a read-only grid. */
  onSelectDay?: (iso: string, label: string) => void;
  /** Legend wording (both current consumers are net, so this defaults to it). */
  legend?: { positive: string; negative: string; neutral: string };
  /** Optional extra content rendered after the legend (e.g. a footnote). */
  footer?: ReactNode;
}

export function CalendarHeatmapGrid({
  months, range, values, max, fmt, tooltipRowsFor, onSelectDay, legend = DEFAULT_LEGEND, footer,
}: CalendarHeatmapGridProps) {
  const size = heatmapSize(months.length);
  const gridCls = heatmapGridCls(months.length);

  return (
    <div className="space-y-2.5">
      <div className={`grid ${gridCls} gap-x-4 gap-y-3`}>
        {months.map(({ year, month }) => (
          <MonthGrid
            key={`${year}-${month}`}
            year={year} month={month}
            values={values} max={max} range={range} size={size} fmt={fmt}
            tooltipRowsFor={tooltipRowsFor}
            onSelectDay={onSelectDay}
          />
        ))}
      </div>
      <div className="flex items-center gap-4 pt-0.5 text-[10px] text-[var(--text-faint)]">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: `rgba(${POS},.5)` }} /> {legend.positive}</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: `rgba(${NEG},.5)` }} /> {legend.negative}</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--surface-inset)]" /> {legend.neutral}</span>
      </div>
      {footer}
    </div>
  );
}
