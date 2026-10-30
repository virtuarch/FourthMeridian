"use client";

/**
 * components/platform/charts/HeatGrid.tsx  (Platform Spaces 2.0 — the ONE heatmap renderer)
 *
 * Draws a HeatLayout (heatmap-model.ts) as a CSS grid that fills its container
 * at every width (390 → 1440 px): fixed-height rows, fluid columns, axis labels
 * only where `shown`. Calendar, time-of-week and cohort heatmaps are all this
 * component with a different layout — one visual system, not three.
 *
 * Interaction (owner addendum: "hover/tap details with exact values"):
 *   - hover, tap or keyboard focus selects a cell; the READOUT line under the
 *     grid states its exact value, denominator and period (no floating tooltip
 *     to clip at the screen edge on a phone);
 *   - the grid is ONE tab stop with roving focus — arrow keys move, Home/End
 *     jump within the row — so 168 cells never mean 168 tab presses;
 *   - `onSelect` (optional) turns Enter/click into a drill-down.
 *
 * Accessibility: role="grid" with an aria-label summary; each cell carries its
 * own aria-label (the readout text); the legend names every state, so the
 * hatch/dash/ramp never carry meaning by colour alone.
 */

import { useState, type KeyboardEvent } from "react";
import { HEAT_BINS, NO_DATA_FILL, ZERO_FILL, binFill, cellStyle, maxValue, type HeatCell, type HeatLayout } from "./heatmap-model";

export interface HeatGridProps {
  layout: HeatLayout;
  /** Short summary for assistive tech ("Sign-ins by weekday and UTC hour, last 90 days: 412"). */
  ariaLabel: string;
  /** The readout text for one cell. */
  describe: (row: number, col: number, cell: HeatCell) => string;
  /** Intensity domain max; default = the largest value in the grid. Rates pass 1. */
  domainMax?: number;
  /** Row height in px (cells stretch horizontally). */
  rowHeight?: number;
  /** Width reserved for row labels, px. */
  labelWidth?: number;
  /** Print the value inside each cell (cohort grids, where columns are wide). */
  cellText?: (cell: HeatCell) => string | null;
  /** What the readout says before anything is selected. */
  hint?: string;
  onSelect?: (row: number, col: number) => void;
  /** Legend words for the ramp ends. */
  legend?: { low: string; high: string };
}

export function HeatGrid({
  layout, ariaLabel, describe, domainMax, rowHeight = 16, labelWidth = 36, cellText, hint = "Hover or tap a cell for its exact value.",
  onSelect, legend = { low: "Less", high: "More" },
}: HeatGridProps) {
  const { rows, cols, cells } = layout;
  const max = domainMax ?? maxValue(cells);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });

  if (rows.length === 0 || cols.length === 0) return null;

  const usable = (r: number, c: number) => cells[r]?.[c] && cells[r][c].kind !== "blank";
  const readout = active && usable(active.r, active.c) ? describe(active.r, active.c, cells[active.r][active.c]) : hint;

  function move(e: KeyboardEvent<HTMLDivElement>) {
    const { r, c } = focus;
    const next = { ArrowUp: { r: r - 1, c }, ArrowDown: { r: r + 1, c }, ArrowLeft: { r, c: c - 1 }, ArrowRight: { r, c: c + 1 },
      Home: { r, c: 0 }, End: { r, c: cols.length - 1 } }[e.key];
    if (next) {
      e.preventDefault();
      const n = { r: Math.max(0, Math.min(rows.length - 1, next.r)), c: Math.max(0, Math.min(cols.length - 1, next.c)) };
      setFocus(n);
      setActive(n);
      (e.currentTarget.querySelector(`[data-cell="${n.r}-${n.c}"]`) as HTMLElement | null)?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && onSelect && usable(r, c)) {
      e.preventDefault();
      onSelect(r, c);
    }
  }

  const template = `${labelWidth}px repeat(${cols.length}, minmax(0, 1fr))`;
  return (
    <div className="min-w-0 overflow-hidden p-0.5" data-heat-grid>
      <div role="grid" aria-label={ariaLabel} aria-rowcount={rows.length} aria-colcount={cols.length} onKeyDown={move}
        onPointerLeave={() => setActive(null)} className="grid min-w-0 gap-[2px]" style={{ gridTemplateColumns: template }}>
        {rows.map((row, r) => (
          <div role="row" key={row.key} className="contents">
            <span role="rowheader" className="truncate pr-1.5 text-right text-[10px] leading-none text-[var(--text-muted)] tabular-nums"
              style={{ height: rowHeight, lineHeight: `${rowHeight}px` }} title={row.label}>
              {row.shown === false ? "" : row.label}
            </span>
            {cols.map((col, c) => {
              const cell = cells[r][c];
              const s = cellStyle(cell, max);
              const text = cellText?.(cell) ?? null;
              const isActive = active?.r === r && active?.c === c;
              return (
                <div
                  key={col.key}
                  role="gridcell"
                  data-cell={`${r}-${c}`}
                  data-kind={cell.kind}
                  tabIndex={focus.r === r && focus.c === c ? 0 : -1}
                  aria-label={cell.kind === "blank" ? undefined : describe(r, c, cell)}
                  onPointerEnter={() => setActive({ r, c })}
                  onPointerDown={() => { setActive({ r, c }); setFocus({ r, c }); }}
                  onFocus={() => setActive({ r, c })}
                  onClick={() => { if (onSelect && cell.kind !== "blank") onSelect(r, c); }}
                  className={`flex min-w-0 items-center justify-center rounded-[3px] text-[10px] font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] ${onSelect && cell.kind !== "blank" ? "cursor-pointer" : ""}`}
                  style={{
                    height: rowHeight,
                    background: s.background,
                    border: s.border,
                    boxShadow: isActive && cell.kind !== "blank" ? "inset 0 0 0 1.5px var(--text-primary)" : undefined,
                    color: cell.kind === "value" && cell.v / Math.max(max, 1e-9) > 0.6 ? "var(--text-on-accent, #fff)" : "var(--text-secondary)",
                  }}
                >
                  {text}
                </div>
              );
            })}
          </div>
        ))}
        <span aria-hidden />
        {cols.map((col) => (
          <span key={col.key} aria-hidden className="overflow-visible whitespace-nowrap pt-1 text-[10px] leading-none text-[var(--text-muted)] tabular-nums">
            {col.shown === false ? "" : col.label}
          </span>
        ))}
      </div>
      <p className="mt-2 min-h-[1.25rem] truncate text-[11px] text-[var(--text-secondary)] tabular-nums" aria-live="polite" data-heat-readout>
        {readout}
      </p>
      <HeatLegend low={legend.low} high={legend.high} cells={cells} />
    </div>
  );
}

/** The legend: the ramp, plus only the special states this grid actually contains. */
export function HeatLegend({ low, high, cells }: { low: string; high: string; cells: readonly HeatCell[][] }) {
  const has = (k: HeatCell["kind"]) => cells.some((row) => row.some((c) => c.kind === k));
  const swatch = "inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]" data-heat-legend>
      <span className="inline-flex items-center gap-1">
        {low}
        {Array.from({ length: HEAT_BINS }, (_, b) => <span key={b} aria-hidden className={swatch} style={{ background: binFill(b) }} />)}
        {high}
      </span>
      {has("zero") && <span className="inline-flex items-center gap-1"><span aria-hidden className={swatch} style={{ background: ZERO_FILL }} />None</span>}
      {has("noData") && <span className="inline-flex items-center gap-1"><span aria-hidden className={swatch} style={{ background: NO_DATA_FILL }} />No data</span>}
      {has("immature") && <span className="inline-flex items-center gap-1"><span aria-hidden className={swatch} style={{ border: "1px dashed var(--border-hairline-strong)" }} />In progress</span>}
    </div>
  );
}
