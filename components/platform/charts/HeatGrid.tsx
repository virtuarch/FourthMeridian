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
 * Accessibility: role="grid" > role="row" (each row a CSS grid on one shared
 * column template) > role="gridcell"; the column axis sits outside the grid. Each cell carries its
 * own aria-label (the readout text); the legend names every state, so the
 * hatch/dash/ramp never carry meaning by colour alone.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
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
  layout, ariaLabel, describe, domainMax, rowHeight = 16, labelWidth = 36, cellText, hint = "Tap or click a cell to pin its exact value · Escape or ✕ clears.",
  onSelect, legend = { low: "Less", high: "More" },
}: HeatGridProps) {
  const { rows, cols, cells } = layout;
  const max = domainMax ?? maxValue(cells);
  // Spaces 2.0 interaction (owner): a mouse HOVER previews a cell; a tap /
  // click / keyboard focus PINS it — the readout stays after the finger lifts,
  // and is dismissed by its ✕, Escape, tapping the same cell, or a tap outside.
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [pinned, setPinned] = useState<{ r: number; c: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setPinned(null); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pinned]);
  const active = pinned ?? hover;
  const [focusState, setFocus] = useState<{ r: number; c: number } | null>(null);

  if (rows.length === 0 || cols.length === 0) return null;

  const usable = (r: number, c: number) => cells[r]?.[c] !== undefined && cells[r][c].kind !== "blank";
  // The roving tab stop: the last focused cell while it still exists in THIS
  // layout (a period change can shrink the grid), else the first usable cell —
  // never a blank padding cell, never an index past the edge.
  const firstUsable = (() => {
    for (let c = 0; c < cols.length; c++) for (let r = 0; r < rows.length; r++) if (usable(r, c)) return { r, c };
    return { r: 0, c: 0 };
  })();
  const focus = focusState && focusState.r < rows.length && focusState.c < cols.length ? focusState : firstUsable;
  const live = pinned && usable(pinned.r, pinned.c) ? pinned : null;
  const shown = live ?? (hover && usable(hover.r, hover.c) ? hover : null);
  const readout = shown ? describe(shown.r, shown.c, cells[shown.r][shown.c]) : hint;

  function move(e: KeyboardEvent<HTMLDivElement>) {
    const { r, c } = focus;
    const next = { ArrowUp: { r: r - 1, c }, ArrowDown: { r: r + 1, c }, ArrowLeft: { r, c: c - 1 }, ArrowRight: { r, c: c + 1 },
      Home: { r, c: 0 }, End: { r, c: cols.length - 1 } }[e.key];
    if (next) {
      e.preventDefault();
      const n = { r: Math.max(0, Math.min(rows.length - 1, next.r)), c: Math.max(0, Math.min(cols.length - 1, next.c)) };
      setFocus(n);
      setPinned(n);
      (e.currentTarget.querySelector(`[data-cell="${n.r}-${n.c}"]`) as HTMLElement | null)?.focus();
    } else if (e.key === "Escape" && pinned) {
      e.preventDefault();
      setPinned(null);
    } else if ((e.key === "Enter" || e.key === " ") && usable(r, c)) {
      e.preventDefault();
      if (onSelect) onSelect(r, c); else setPinned({ r, c });
    }
  }

  const template = `${labelWidth}px repeat(${cols.length}, minmax(0, 1fr))`;
  return (
    <div ref={root} className="min-w-0 overflow-hidden p-0.5" data-heat-grid>
      <div role="grid" aria-label={ariaLabel} aria-rowcount={rows.length} aria-colcount={cols.length} onKeyDown={move}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }} className="flex min-w-0 flex-col gap-[2px]">
        {rows.map((row, r) => (
          // Each row is its own grid on the shared column template (no display:contents,
          // which some engines drop from the accessibility tree).
          <div role="row" key={row.key} className="grid min-w-0 gap-[2px]" style={{ gridTemplateColumns: template }}>
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
                  onPointerEnter={(e) => { if (e.pointerType === "mouse") setHover({ r, c }); }}
                  onClick={() => {
                    if (cell.kind === "blank") return;
                    setFocus({ r, c });
                    setPinned((p) => (p && p.r === r && p.c === c ? null : { r, c }));
                    if (onSelect) onSelect(r, c);
                  }}
                  className={`flex min-w-0 items-center justify-center rounded-[3px] text-[10px] font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] ${onSelect && cell.kind !== "blank" ? "cursor-pointer" : ""}`}
                  style={{
                    height: rowHeight,
                    background: s.background,
                    border: s.border,
                    boxShadow: isActive && cell.kind !== "blank" ? (live && live.r === r && live.c === c ? "inset 0 0 0 2px var(--text-primary)" : "inset 0 0 0 1px var(--text-secondary)") : undefined,
                    color: cell.kind === "value" && cell.v / Math.max(max, 1e-9) > 0.6 ? "var(--text-on-accent, #fff)" : "var(--text-secondary)",
                  }}
                >
                  {text}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* The column axis sits OUTSIDE the grid role (valid grid structure); each
          cell's aria-label already names its column. */}
      <div aria-hidden className="grid min-w-0 gap-[2px]" style={{ gridTemplateColumns: template }} data-heat-axis>
        <span />
        {cols.map((col) => (
          <span key={col.key} className="overflow-visible whitespace-nowrap pt-1 text-[10px] leading-none text-[var(--text-muted)] tabular-nums">
            {col.shown === false ? "" : col.label}
          </span>
        ))}
      </div>
      <div className="mt-2 flex min-h-[1.75rem] items-start gap-2" data-heat-readout={live ? "pinned" : shown ? "hover" : "hint"}>
        <p className={`min-w-0 flex-1 text-[11px] leading-snug tabular-nums ${shown ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`} aria-live="polite">
          {readout}
        </p>
        {live && (
          <button type="button" aria-label="Clear selection" onClick={() => setPinned(null)}
            className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-xs)] border border-[var(--border-hairline)] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
            <X size={12} aria-hidden />
          </button>
        )}
      </div>
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
