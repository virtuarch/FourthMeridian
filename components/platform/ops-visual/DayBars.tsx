"use client";

/**
 * components/platform/ops-visual/DayBars.tsx  (Platform Ops visual spec §1 — "bars for daily volume")
 *
 * Stacked per-UTC-day COUNTS drawn in the Personal Space chart language — the
 * TrendChart's geometry and palette, not a new one: a MEASURED width (never a
 * stretched viewBox), a fixed pixel height, 3–4 "nice" y ticks over hairline
 * gridlines (TrendChart's own `niceTicks`), three x-axis dates, the hatched
 * "no data" band for a day the source cannot vouch for, and an HTML tooltip.
 *
 * Why not TrendChart itself: it plots ONE money series (its axis and tooltip are
 * currency-formatted) and has no stacked mode; a Platform count series would need
 * a new prop on a Personal component, which this redesign must not change.
 *
 * Honesty: an unobserved day is a hatched gap, never a zero bar; an observed day
 * with no executions is a visible empty slot over the baseline.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { niceTicks } from "@/components/space/widgets/charts/TrendChart";
import type { DayBar } from "./ops-visual-model";

export const DAY_BAR_COLORS = {
  succeeded: "color-mix(in srgb, var(--meridian-400) 75%, transparent)",
  failed: "var(--coral-400)",
  other: "var(--accent-warning)",
} as const;

const PAD_T = 12;
const PAD_B = 22;
const Y_LABEL_CHAR_PX = 6.4;
const Y_LABEL_GAP = 8;

function longDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function shortDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function DayBars({
  days,
  ariaLabel,
  height = 200,
  noun = "execution",
  palette = DAY_BAR_COLORS,
  failedWord = "failed",
  segmentLabels,
}: {
  days: readonly DayBar[];
  ariaLabel: string;
  height?: number;
  /** Singular noun for the tooltip ("execution", "refresh"). */
  noun?: string;
  /**
   * The three stack colours (default: succeeded / other / failed). A series that
   * stacks something other than outcomes (prompt vs completion tokens on AI &
   * Costs) passes its own, so a token is never drawn in a failure colour.
   */
  palette?: { readonly succeeded: string; readonly other: string; readonly failed: string };
  /** The word for the third stack in the summary and tooltip (default "failed"; e.g. "opened"). */
  failedWord?: string;
  /**
   * Words for the three stacks in the pinned readout (default: succeeded /
   * other / `failedWord`). Pass the legend's own words so the readout names
   * each segment exactly as the legend does.
   */
  segmentLabels?: { succeeded: string; other: string; failed: string };
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  // Spaces 2.0 interaction (owner): a mouse HOVER previews; a tap / click /
  // keyboard selection PINS the day — it persists after the finger lifts and is
  // dismissed by the ✕, Escape, a second tap on the same day, or a tap outside.
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A new series (window / toggle) is a new chart: a pin never silently moves to another day.
  const seriesKey = `${days.length}:${days[0]?.day ?? ""}:${days[days.length - 1]?.day ?? ""}:${noun}`;
  const [pinKey, setPinKey] = useState(seriesKey);
  if (pinKey !== seriesKey) { setPinKey(seriesKey); setPinned(null); setHover(null); }

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const observed = days.filter((d) => d.observed);
  const total = (d: DayBar) => d.succeeded + d.failed + d.other;
  const max = observed.reduce((m, d) => Math.max(m, total(d)), 0);
  const ticks = niceTicks(0, Math.max(max, 1)).filter((t) => t >= 0);
  const top = Math.max(ticks[ticks.length - 1] ?? 1, max, 1);
  const labels = ticks.map((t) => (Number.isInteger(t) ? t.toLocaleString("en-US") : t.toFixed(1)));
  const padL = Math.ceil(Math.max(1, ...labels.map((l) => l.length)) * Y_LABEL_CHAR_PX) + Y_LABEL_GAP;
  const plotW = Math.max(1, w - padL);
  const slot = days.length > 0 ? plotW / days.length : plotW;
  const barW = Math.max(2, Math.min(28, slot * 0.62));
  const y = (v: number) => PAD_T + (1 - v / top) * (height - PAD_T - PAD_B);
  const x = (i: number) => padL + i * slot + (slot - barW) / 2;

  const sumAll = observed.reduce((a, d) => a + total(d), 0);
  const failedAll = observed.reduce((a, d) => a + d.failed, 0);
  const summary = `${ariaLabel}: ${days.length} days, ${observed.length} observed${days.length - observed.length ? `, ${days.length - observed.length} without data` : ""}; ${sumAll} ${noun}s, ${failedAll} ${failedWord}`;

  useEffect(() => {
    if (pinned === null) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setPinned(null); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pinned]);

  const active = pinned ?? hover;
  const h = active !== null && active < days.length ? days[active] : null;
  const words = segmentLabels ?? { succeeded: "succeeded", other: "other", failed: failedWord };
  const indexAt = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || days.length === 0) return null;
    const i = Math.floor((clientX - rect.left - padL) / slot);
    return i >= 0 && i < days.length ? i : null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (days.length === 0) return;
    const cur = pinned ?? days.length - 1;
    const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: days.length - 1 }[e.key];
    if (next !== undefined) { e.preventDefault(); setPinned(Math.max(0, Math.min(days.length - 1, pinned === null && e.key !== "Home" ? days.length - 1 : next))); }
    else if (e.key === "Escape" && pinned !== null) { e.preventDefault(); setPinned(null); }
    else if ((e.key === "Enter" || e.key === " ") && pinned === null) { e.preventDefault(); setPinned(days.length - 1); }
  };
  const plural = (k: number) => `${k.toLocaleString("en-US")} ${noun}${k === 1 ? "" : "s"}`;

  return (
    <div ref={root} className="min-w-0" data-day-bars>
      <div
        ref={wrap}
        className="relative cursor-pointer touch-pan-y rounded-[var(--radius-xs)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]"
        tabIndex={0}
        role="group"
        aria-label={`${summary}. Use arrow keys to step through days; Escape clears.`}
        onKeyDown={onKey}
        onPointerMove={(e) => { if (e.pointerType === "mouse") setHover(indexAt(e.clientX)); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
        onClick={(e) => { const i = indexAt(e.clientX); if (i !== null) setPinned((p) => (p === i ? null : i)); }}
      >
        <svg width="100%" height={height} className="block overflow-visible" role="img" aria-label={summary}>
          <defs>
            <pattern id="db-hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="5" stroke="var(--text-muted)" strokeWidth="1" strokeOpacity="0.30" />
            </pattern>
          </defs>
          {ticks.map((t, i) => (
            <g key={t}>
              <line x1={padL} y1={y(t)} x2={w} y2={y(t)} stroke="var(--border-hairline)" strokeWidth="1" strokeOpacity="0.6" />
              <text x={padL - Y_LABEL_GAP} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--text-muted)] text-[11px] tabular-nums">{labels[i]}</text>
            </g>
          ))}
          <line x1={padL} y1={height - PAD_B} x2={w} y2={height - PAD_B} stroke="var(--border-hairline)" strokeWidth="1" />
          {days.map((d, i) => {
            if (!d.observed) {
              return (
                <rect key={d.day} x={padL + i * slot} y={PAD_T - 4} width={slot} height={height - PAD_T - PAD_B + 4} fill="url(#db-hatch)" data-day-gap={d.day} />
              );
            }
            const segs = [
              { k: "succeeded", v: d.succeeded, c: palette.succeeded },
              { k: "other", v: d.other, c: palette.other },
              { k: "failed", v: d.failed, c: palette.failed },
            ];
            let base = 0;
            return (
              <g key={d.day} data-day={d.day} opacity={active === null || active === i ? 1 : 0.55}>
                {segs.filter((s) => s.v > 0).map((s) => {
                  const y0 = y(base);
                  base += s.v;
                  const y1 = y(base);
                  return <rect key={s.k} x={x(i)} y={y1} width={barW} height={Math.max(1, y0 - y1)} rx={1.5} fill={s.c} />;
                })}
              </g>
            );
          })}
          {days.length > 0 && days.every((d) => !d.observed) && (
            <text x={padL + plotW / 2} y={(height - PAD_B) / 2} textAnchor="middle" className="fill-[var(--text-muted)] text-[9px] uppercase" style={{ letterSpacing: "0.08em" }}>no data</text>
          )}
        </svg>
        {h && active !== null && (
          <div className={`${pinned !== null ? "" : "pointer-events-none "}absolute bottom-full z-10 mb-1 w-max max-w-[calc(100%-8px)] -translate-x-1/2`}
            style={{ left: Math.min(Math.max(x(active) + barW / 2, 90), Math.max(90, w - 90)) }}
            onClick={(e) => e.stopPropagation()} data-day-readout={pinned !== null ? "pinned" : "hover"}>
            <div className="min-w-[150px] rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-2.5 py-1.5 shadow-[var(--shadow-e3)]" style={{ background: "var(--glass-thick)" }}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{h.observed ? plural(total(h)) : "No data"}</p>
                {pinned !== null && (
                  <button type="button" aria-label="Clear selection" onClick={(e) => { e.stopPropagation(); setPinned(null); wrap.current?.focus(); }}
                    className="-mr-1 -mt-0.5 grid size-6 place-items-center rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
                    <X size={12} aria-hidden />
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{longDate(h.day)} · UTC</p>
              {/* The segments, by name, when the day has more than one kind. */}
              {h.observed && [h.succeeded, h.other, h.failed].filter((v) => v > 0).length >= 2 && (
                <ul className="mt-1 flex flex-col gap-0.5 text-[11px] tabular-nums text-[var(--text-secondary)]">
                  {([["succeeded", h.succeeded], ["other", h.other], ["failed", h.failed]] as const).filter(([, v]) => v > 0).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ background: palette[k] }} />
                      {`${v.toLocaleString("en-US")} ${words[k]}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <span className="sr-only" aria-live="polite">{pinned !== null && h ? `${longDate(h.day)}: ${h.observed ? plural(total(h)) : "no data"}` : ""}</span>
      </div>
      {days.length > 0 && (
        <div className="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]" style={{ paddingLeft: padL }}>
          <span>{shortDate(days[0].day)}</span>
          <span>{shortDate(days[Math.floor(days.length / 2)].day)}</span>
          <span>{shortDate(days[days.length - 1].day)}</span>
        </div>
      )}
    </div>
  );
}

/** A seven-day success/failure sparkline for one job row. Gaps are dashed, never zero. */
export function Sparkline7({ days, label }: { days: readonly DayBar[]; label: string }) {
  const max = days.reduce((m, d) => Math.max(m, d.observed ? d.succeeded + d.failed + d.other : 0), 0);
  const runs = days.filter((d) => d.observed).reduce((a, d) => a + d.succeeded + d.failed + d.other, 0);
  const failed = days.filter((d) => d.observed).reduce((a, d) => a + d.failed, 0);
  const unobserved = days.filter((d) => !d.observed).length;
  const aria = `${label}: ${runs} run${runs === 1 ? "" : "s"} in 7 days${failed ? `, ${failed} failed` : ""}${unobserved ? `, ${unobserved} days without data` : ""}`;
  const H = 20;
  return (
    <span role="img" aria-label={aria} className="inline-flex h-5 w-[70px] items-end gap-[2px]" data-sparkline>
      {days.map((d) => {
        if (!d.observed) return <span key={d.day} className="flex-1 self-end border-b border-dashed" style={{ borderColor: "var(--border-hairline-strong)", height: 1 }} />;
        const t = d.succeeded + d.failed + d.other;
        if (t === 0) return <span key={d.day} className="flex-1 self-end rounded-[1px]" style={{ height: 2, background: "var(--border-hairline)" }} />;
        const hh = Math.max(3, Math.round((t / Math.max(max, 1)) * H));
        return (
          <span key={d.day} className="flex flex-1 flex-col-reverse overflow-hidden rounded-[1px]" style={{ height: hh }}>
            <span style={{ height: `${(d.succeeded / t) * 100}%`, background: DAY_BAR_COLORS.succeeded }} />
            <span style={{ height: `${(d.other / t) * 100}%`, background: DAY_BAR_COLORS.other }} />
            <span style={{ height: `${(d.failed / t) * 100}%`, background: DAY_BAR_COLORS.failed }} />
          </span>
        );
      })}
    </span>
  );
}

/** The chart's legend — one quiet line, colour + word. */
export function DayBarsLegend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </span>
  );
}
