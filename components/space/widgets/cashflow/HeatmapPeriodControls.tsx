"use client";

/**
 * components/space/widgets/cashflow/HeatmapPeriodControls.tsx
 * (v2.7 final follow-ups — Workstream A: stable heatmap period controls)
 *
 * The Activity heatmap's period controls for Cash Flow AND Spending, in TWO rows:
 *
 *   ROW 1 (always, identical markup in every state)
 *     [ Month | Quarter | Year ]  ·····························  [ measure ▾ ]
 *     A fixed-width segmented group (each segment a fixed width; below `sm` the
 *     visible text is M / Q / Y, the accessible name stays the full word) and the
 *     page's measure select at a stable spot. Selecting a unit only toggles the
 *     segment's colour (`aria-checked`) — nothing is inserted into this row, so
 *     nothing in it can move.
 *
 *   ROW 2 (only while a unit is active — an explicit `fperiod`)
 *     [◀]  [ October 2026 ▾ ]  [▶]  ··································  [ Reset ]
 *     ◀ / ▶ step one unit; the label opens the direct picker (any month · quarter ·
 *     year in the supported range); Reset returns the FLOW period to its rolling 1M
 *     default (the measure is untouched — it is widget-local state).
 *
 * Range bounds: ONE predicate (`isSelectablePeriod`, lib/space/perspective-time-
 * groups.ts) bounds the arrows AND the picker — never a unit that starts after
 * today, never one that ends before the first transaction.
 *
 * The picker is a popover dialog anchored under row 2 (full row width on phones,
 * 18rem from `sm`), so it never overflows a 375 px viewport. Escape and a click
 * outside close it and return focus to the label; opening focuses the selected
 * (or first selectable) cell; every cell is ≥ 40 px tall.
 *
 * Controls stop pointerdown so they can't perturb a section drag source.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import type { ExplicitCashFlowPeriod } from "@/lib/transactions/cash-flow";
import {
  explicitPeriodKey,
  periodPickerOptions,
  selectablePickerYears,
  type CalendarScale,
} from "@/lib/space/perspective-time-groups";

const TRACK = { background: "var(--glass-ultrathin)", border: "1px solid var(--border-hairline)" } as const;
const ACTIVE = { background: "rgba(59,130,246,.14)", border: "1px solid rgba(125,168,255,.32)" } as const;
const IDLE = { border: "1px solid transparent" } as const;
const RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export const HEATMAP_SCALES: { id: CalendarScale; label: string; short: string; picker: string }[] = [
  { id: "month",   label: "Month",   short: "M", picker: "Choose a month" },
  { id: "quarter", label: "Quarter", short: "Q", picker: "Choose a quarter" },
  { id: "year",    label: "Year",    short: "Y", picker: "Choose a year" },
];

// ─── Row 1 — Month · Quarter · Year (fixed-width segments) ─────────────────────

/** Fixed-width segmented unit control. Its geometry never depends on `scale`. */
export function HeatmapScaleControl({ scale, onPick }: { scale: CalendarScale | null; onPick: (s: CalendarScale) => void }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 p-0.5 rounded-[var(--radius-full)]" style={TRACK}
      role="radiogroup" aria-label="Heatmap period" onPointerDown={stop} data-heatmap-scale>
      {HEATMAP_SCALES.map(({ id, label, short }) => {
        const active = id === scale;
        return (
          <button key={id} type="button" role="radio" aria-checked={active} data-scale={id} aria-label={label}
            onClick={() => { if (!active) onPick(id); }}
            className={`w-10 sm:w-[4.25rem] shrink-0 rounded-[var(--radius-full)] py-1 text-center text-[11px] font-semibold transition-colors max-lg:min-h-10 ${RING} ${active ? "text-[var(--meridian-400)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
            style={active ? ACTIVE : IDLE}>
            <span aria-hidden="true" className="sm:hidden">{short}</span>
            <span aria-hidden="true" className="max-sm:hidden">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Row 1: the unit control and the page's measure select. Same markup in every state but the active segment. */
export function HeatmapPrimaryRow({ scale, onPick, measure }: {
  scale: CalendarScale | null;
  /** Absent ⇒ no unit control (a standalone heatmap with no period authority). */
  onPick?: (s: CalendarScale) => void;
  measure: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 min-w-0" data-heatmap-controls data-heatmap-row="primary">
      {onPick ? <HeatmapScaleControl scale={scale} onPick={onPick} /> : <span />}
      <div className="shrink-0 max-w-full" data-heatmap-measure>{measure}</div>
    </div>
  );
}

// ─── Row 2 — ◀ label ▶ · Reset (only while a unit is active) ───────────────────

const ARROW = `flex shrink-0 items-center justify-center h-7 w-7 rounded-[var(--radius-full)] text-[var(--text-muted)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-default transition-colors max-lg:h-10 max-lg:w-10 ${RING}`;

export function HeatmapPeriodRow({ period, label, prev, next, earliest, today, onSelect, onReset, defaultOpen = false }: {
  /** The active explicit unit. */
  period: ExplicitCashFlowPeriod;
  /** Its display label (October 2026 · Q4 2026 · 2026). */
  label: string;
  prev: ExplicitCashFlowPeriod | null;
  next: ExplicitCashFlowPeriod | null;
  /** Earliest data-bearing date (null ⇒ no lower bound) and today — the supported range. */
  earliest: string | null;
  today: string;
  onSelect: (p: ExplicitCashFlowPeriod) => void;
  /** Back to the rolling default. Absent ⇒ no Reset (standalone heatmap). */
  onReset?: () => void;
  /** Test seam: render with the picker open (static markup). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const unit = HEATMAP_SCALES.find((s) => s.id === period.kind)!;

  // Close on a click outside the row (the picker lives inside it).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  return (
    <div ref={wrapRef} className="relative min-w-0" onPointerDown={stop} data-heatmap-row="period">
      <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-heatmap-stepper>
        <button type="button" aria-label="Previous period" disabled={prev == null} onClick={() => prev && onSelect(prev)} className={ARROW} style={TRACK}>
          <ChevronLeft size={14} />
        </button>
        <button ref={triggerRef} type="button" data-heatmap-period-label
          aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? pickerId : undefined}
          aria-label={`${label} — ${unit.picker.toLowerCase()}`}
          onClick={() => setOpen((o) => !o)}
          className={`inline-flex min-w-[8.5rem] shrink-0 items-center justify-center gap-1 rounded-[var(--radius-full)] px-2.5 py-1 text-xs font-semibold tabular-nums whitespace-nowrap text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors max-lg:min-h-10 ${RING}`}
          style={TRACK}>
          <span aria-live="polite">{label}</span>
          <ChevronDown size={12} aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"} />
        </button>
        <button type="button" aria-label="Next period" disabled={next == null} onClick={() => next && onSelect(next)} className={ARROW} style={TRACK}>
          <ChevronRight size={14} />
        </button>
        {onReset && (
          <button type="button" data-heatmap-reset onClick={() => { setOpen(false); onReset(); }}
            aria-label="Reset to the rolling 1 month default"
            className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-full)] px-3 py-1 text-[11px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors max-lg:min-h-10 ${RING}`}
            style={TRACK}>
            <RotateCcw size={12} aria-hidden="true" />
            Reset
          </button>
        )}
      </div>
      {open && (
        <HeatmapPeriodPicker key={explicitPeriodKey(period)} id={pickerId} period={period} earliest={earliest} today={today}
          onChoose={(p) => { close(true); if (explicitPeriodKey(p) !== explicitPeriodKey(period)) onSelect(p); }}
          onDismiss={() => close(true)} />
      )}
    </div>
  );
}

// ─── The direct period picker ──────────────────────────────────────────────────

export function HeatmapPeriodPicker({ id, period, earliest, today, onChoose, onDismiss }: {
  id?: string;
  period: ExplicitCashFlowPeriod;
  earliest: string | null;
  today: string;
  onChoose: (p: ExplicitCashFlowPeriod) => void;
  onDismiss: () => void;
}) {
  const unit = HEATMAP_SCALES.find((s) => s.id === period.kind)!;
  const range = { earliest, today };
  const years = selectablePickerYears({ earliest, today, current: period });
  const [year, setYear] = useState(period.year);
  const options = periodPickerOptions(period.kind, year, range, years);
  const currentKey = explicitPeriodKey(period);
  const yi = years.indexOf(year);
  const focusRef = useRef<HTMLButtonElement>(null);

  // Focus management: opening lands on the selected (or first selectable) cell.
  useEffect(() => { focusRef.current?.focus(); }, []);
  const focusKey = options.find((o) => o.key === currentKey && o.selectable)?.key ?? options.find((o) => o.selectable)?.key;

  const cols = period.kind === "quarter" ? "grid-cols-4" : "grid-cols-3";
  const yearBtn = `flex items-center justify-center h-10 w-10 rounded-[var(--radius-full)] text-[var(--text-muted)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-default ${RING}`;

  return (
    <div id={id} role="dialog" aria-modal="false" aria-label={unit.picker} data-heatmap-picker={period.kind}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDismiss(); } }}
      className="absolute left-0 right-0 top-full z-30 mt-1.5 rounded-[var(--radius-lg)] border border-[var(--border-hairline-strong)] bg-[var(--bg-deep)] p-2 shadow-[var(--shadow-e3)] sm:right-auto sm:w-72">
      {period.kind !== "year" && (
        <div className="mb-1.5 flex items-center justify-between" data-heatmap-picker-year>
          <button type="button" aria-label="Previous year" disabled={yi <= 0} onClick={() => setYear(years[yi - 1])} className={yearBtn}>
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs font-semibold tabular-nums text-[var(--text-secondary)]" aria-live="polite">{year}</span>
          <button type="button" aria-label="Next year" disabled={yi < 0 || yi >= years.length - 1} onClick={() => setYear(years[yi + 1])} className={yearBtn}>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      <div className={`grid ${cols} gap-1`}>
        {options.map((o) => {
          const current = o.key === currentKey;
          const full = o.period.kind === "month"
            ? new Date(Date.UTC(o.period.year, o.period.month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
            : o.period.kind === "quarter" ? `Q${o.period.quarter} ${o.period.year}` : `${o.period.year}`;
          return (
            <button key={o.key} type="button" data-period-option={o.key}
              ref={o.key === focusKey ? focusRef : undefined}
              disabled={!o.selectable} aria-current={current ? "true" : undefined} aria-label={full}
              onClick={() => onChoose(o.period)}
              className={`min-h-10 rounded-[var(--radius-md)] px-1 text-xs font-semibold tabular-nums transition-colors disabled:opacity-30 disabled:cursor-default ${RING} ${current ? "text-[var(--meridian-400)]" : "text-[var(--text-secondary)] enabled:hover:text-[var(--text-primary)]"}`}
              style={current ? ACTIVE : IDLE}>
              {o.short}
            </button>
          );
        })}
      </div>
    </div>
  );
}
