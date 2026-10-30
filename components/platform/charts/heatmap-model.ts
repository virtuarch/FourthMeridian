/**
 * components/platform/charts/heatmap-model.ts  (Platform Spaces 2.0 — the heatmap kit, pure)
 *
 * The cell model and the three layouts the owner's Heatmaps addendum names —
 * calendar (weekday × week), time of week (weekday × UTC hour) and cohort
 * (cohort × offset or stage) — as plain data the one renderer (HeatGrid.tsx)
 * draws. No React, no clock, no fetch: tested in isolation.
 *
 * Honesty (owner addendum):
 *   value     a measured figure (> 0), optionally with its numerator/denominator
 *   zero      measured, and nothing happened — drawn, never confused with…
 *   noData    the source cannot vouch for this period (hatched)
 *   immature  the period has not finished (dashed outline, no fill)
 *   blank     padding outside the window (not a period at all)
 */

import type { AcquisitionDay, CohortRow } from "@/lib/platform/growth/acquisition-types";

export type HeatCell =
  | { kind: "value"; v: number; num?: number; den?: number }
  | { kind: "zero"; den?: number }
  | { kind: "noData" }
  | { kind: "immature" }
  | { kind: "blank" };

export interface HeatAxis { key: string; label: string; /** Show the label on the axis (others are read in the readout). */ shown?: boolean }

export interface HeatLayout {
  rows: HeatAxis[];
  cols: HeatAxis[];
  /** Row-major: cells[row][col]. */
  cells: HeatCell[][];
}

export const HEAT_BINS = 5;
/** The Meridian luminance ramp (one hue; ordered by lightness, so it reads without colour vision). */
const RAMP = [22, 38, 55, 72, 92];

/** Which of the 5 bins a value falls in, over (0, max]. */
export function heatBin(v: number, max: number): number {
  if (!(max > 0) || !(v > 0)) return 0;
  return Math.min(HEAT_BINS - 1, Math.max(0, Math.ceil((v / max) * HEAT_BINS) - 1));
}

export function binFill(bin: number): string {
  return `color-mix(in srgb, var(--meridian-400) ${RAMP[bin]}%, transparent)`;
}

export const ZERO_FILL = "color-mix(in srgb, var(--text-muted) 10%, transparent)";
export const NO_DATA_FILL =
  "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-muted) 28%, transparent) 0 1px, transparent 1px 4px)";

/** The CSS background (and border) for a cell. */
export function cellStyle(cell: HeatCell, max: number): { background: string; border?: string } {
  switch (cell.kind) {
    case "value": return { background: binFill(heatBin(cell.v, max)) };
    case "zero": return { background: ZERO_FILL };
    case "noData": return { background: NO_DATA_FILL };
    case "immature": return { background: "transparent", border: "1px dashed var(--border-hairline-strong)" };
    case "blank": return { background: "transparent" };
  }
}

export const maxValue = (cells: readonly HeatCell[][]): number =>
  cells.reduce((m, row) => row.reduce((mm, c) => (c.kind === "value" ? Math.max(mm, c.v) : mm), m), 0);

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const shortDay = (day: string) =>
  new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const count = (n: number | null): HeatCell => (n === null ? { kind: "noData" } : n > 0 ? { kind: "value", v: n } : { kind: "zero" });

/**
 * Calendar: rows Mon…Sun, one column per ISO week; days outside the series are
 * `blank`. Week columns are labelled by their Monday, roughly every 4th shown.
 */
export function calendarLayout(days: readonly AcquisitionDay[]): HeatLayout & { dayAt: (r: number, c: number) => string | null } {
  if (days.length === 0) return { rows: [], cols: [], cells: [], dayAt: () => null };
  const first = days[0].day;
  const lead = (new Date(`${first}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const nCols = Math.ceil((lead + days.length) / 7);
  const cells: HeatCell[][] = WEEKDAYS.map(() => Array.from({ length: nCols }, () => ({ kind: "blank" }) as HeatCell));
  const at: (string | null)[][] = WEEKDAYS.map(() => Array.from({ length: nCols }, () => null));
  days.forEach((d, i) => {
    const slot = lead + i;
    const r = slot % 7, c = Math.floor(slot / 7);
    cells[r][c] = count(d.count);
    at[r][c] = d.day;
  });
  const every = nCols > 8 ? 4 : nCols > 4 ? 2 : 1;
  const cols: HeatAxis[] = Array.from({ length: nCols }, (_, c) => {
    const monday = new Date(Date.parse(`${first}T00:00:00.000Z`) + (c * 7 - lead) * 86_400_000).toISOString().slice(0, 10);
    return { key: monday, label: shortDay(monday), shown: c % every === 0 };
  });
  return {
    rows: WEEKDAYS.map((w, i) => ({ key: w, label: w, shown: i % 2 === 0 })),
    cols, cells,
    dayAt: (r, c) => at[r]?.[c] ?? null,
  };
}

/** Time of week: rows Mon…Sun × 24 UTC hours (labels every 6 h). */
export function weekHourLayout(grid: readonly (readonly number[])[]): HeatLayout {
  return {
    rows: WEEKDAYS.map((w) => ({ key: w, label: w, shown: true })),
    cols: Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: `${String(h).padStart(2, "0")}:00`, shown: h % 6 === 0 })),
    cells: WEEKDAYS.map((_, r) => Array.from({ length: 24 }, (_, h) => count(grid[r]?.[h] ?? 0))),
  };
}

/**
 * Cohort: one row per cohort (labelled by its week and size), one column per
 * offset/stage; a value cell's intensity is num ÷ den on a FIXED 0–1 domain so
 * two cohorts compare honestly. A cohort with no members reads `blank` cells.
 */
export function cohortLayout(rows: readonly CohortRow[], cols: readonly HeatAxis[]): HeatLayout {
  return {
    rows: rows.map((r) => ({ key: r.weekStart, label: `${shortDay(r.weekStart)} · ${r.size}`, shown: true })),
    cols: cols.map((c) => ({ ...c, shown: c.shown ?? true })),
    cells: rows.map((r) =>
      r.cells.map((c): HeatCell => {
        if (c.state === "noData") return { kind: "noData" };
        if (c.state === "immature") return { kind: "immature" };
        if (c.den === 0) return { kind: "blank" };
        return c.num > 0 ? { kind: "value", v: c.num / c.den, num: c.num, den: c.den } : { kind: "zero", den: c.den };
      }),
    ),
  };
}

/** Whole-number percentage, "—" without a denominator. */
export function pct(num: number, den: number): string {
  return den > 0 ? `${Math.round((num / den) * 100)}%` : "—";
}

/** Enough history to draw a heatmap at all: at least two measured (value/zero) periods. */
export function hasCoverage(cells: readonly HeatCell[][], min = 2): boolean {
  let measured = 0;
  for (const row of cells) for (const c of row) if (c.kind === "value" || c.kind === "zero") measured++;
  return measured >= min;
}
