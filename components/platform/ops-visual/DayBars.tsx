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

import { useLayoutEffect, useRef, useState } from "react";
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

function shortDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function DayBars({
  days,
  ariaLabel,
  height = 200,
  noun = "execution",
}: {
  days: readonly DayBar[];
  ariaLabel: string;
  height?: number;
  /** Singular noun for the tooltip ("execution", "refresh"). */
  noun?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

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
  const summary = `${ariaLabel}: ${days.length} days, ${observed.length} observed${days.length - observed.length ? `, ${days.length - observed.length} without data` : ""}; ${sumAll} ${noun}s, ${failedAll} failed`;

  const h = hover !== null ? days[hover] : null;
  const plural = (k: number) => `${k.toLocaleString("en-US")} ${noun}${k === 1 ? "" : "s"}`;

  return (
    <div className="min-w-0" data-day-bars>
      <div
        ref={wrap}
        className="relative touch-pan-y"
        onPointerMove={(e) => {
          const rect = wrap.current?.getBoundingClientRect();
          if (!rect || days.length === 0) return;
          const i = Math.floor((e.clientX - rect.left - padL) / slot);
          setHover(i >= 0 && i < days.length ? i : null);
        }}
        onPointerLeave={() => setHover(null)}
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
              { k: "succeeded", v: d.succeeded, c: DAY_BAR_COLORS.succeeded },
              { k: "other", v: d.other, c: DAY_BAR_COLORS.other },
              { k: "failed", v: d.failed, c: DAY_BAR_COLORS.failed },
            ];
            let base = 0;
            return (
              <g key={d.day} data-day={d.day} opacity={hover === null || hover === i ? 1 : 0.55}>
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
        {h && hover !== null && (
          <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2" style={{ left: Math.min(Math.max(x(hover) + barW / 2, 70), w - 70) }}>
            <div className="rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-2.5 py-1.5 shadow-[var(--shadow-e3)]" style={{ background: "var(--glass-thick)" }}>
              <p className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{h.observed ? plural(total(h)) : "No data"}</p>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                {shortDate(h.day)}{h.observed && h.failed > 0 ? ` · ${h.failed.toLocaleString("en-US")} failed` : ""}
              </p>
            </div>
          </div>
        )}
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
