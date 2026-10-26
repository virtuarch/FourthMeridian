"use client";

/**
 * components/space/widgets/charts/TrendChart.tsx
 *
 * The honesty trend chart — the ONE plotting core, extracted verbatim from the Net
 * Worth workspace's WealthTrendChart (itself recreated 1:1 from the prototype's
 * TrendChart). Both Net Worth (WealthTrendChart) and Investments (Balance History)
 * render through THIS — there is one chart, not two look-alikes.
 *
 * Plotting, preserved exactly:
 *   - MEASURED width (ResizeObserver) + fixed pixel height — never a stretched
 *     viewBox, so markers stay circular;
 *   - the line BREAKS at real gaps; across a basis change (observed↔reconstructed)
 *     it flows point to point, each run keeping its own stroke style (v2.7);
 *   - reconstructed runs are dashed + faint with HOLLOW markers;
 *   - the unknown is a hatched "NO DATA" band, not an absence;
 *   - y-scale from real points ONLY (no interpolation across the hole);
 *   - three x-axis labels + 3–4 y-axis value ticks (compact, in the caller's
 *     currency) over subtle gridlines; an HTML tooltip that won't snap across a gap;
 *     honest legend (Observed / Reconstructed / Never observed, each only if present).
 *
 * v2.7 (owner) — no title/subtitle: the hero above already states the range. The
 * V26 evidence-basis seam rule and its "Evidence changes" legend item are retired;
 * adjacent runs on different bases are JOINED (the later run's path starts at the
 * earlier run's last point), so the step is visible as a change of stroke style, not
 * as a break. True date gaps still break and still draw the hatched band.
 *
 * Geometry splitting lives in trend-runs.core.ts (pure, React-free, unit-tested).
 * This file owns pixels; that file owns what a run, a gap and a seam MEAN.
 *
 * This core is domain-free: it takes points `{date,value,estimated}`, a currency, and
 * one presentation slot (headerRight). The consumer owns what the series MEANS (net
 * worth vs invested value) and any switcher (headerRight).
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatCompactCurrency } from "@/lib/currency";
import {
  medianSpacingDays, toRuns, toDateGaps, toBasisSeams,
  basisOf,
  type TrendGeomPoint, type TrendRun, type TrendBasis,
} from "./trend-runs.core";

export interface TrendPoint {
  /** YYYY-MM-DD. */
  date:      string;
  value:     number;
  /** True when reconstructed / display-estimated (drawn as a different KIND of fact). */
  estimated: boolean;
  /**
   * V26-INVESTMENTS-HISTORY — the caller's ALREADY-CLASSIFIED confidence. When
   * present it wins over `estimated` (see basisOf). This component never decides
   * what makes a point unreliable: it receives a state and draws it. Optional,
   * so callers with no confidence data are unchanged.
   */
  basis?:    TrendBasis;
  /**
   * Ready-to-render disclosure for the tooltip, e.g. "1 of 19 positions valued".
   * Passed as TEXT, deliberately: handing this component the counts instead
   * would invite it to compute a ratio and decide something from it.
   */
  coverageLabel?: string | null;
}

const H = 264;
const PAD_T = 16;
const PAD_B = 26;
/** Approx. px per character of an 11px tabular y-axis label, + the gap to the plot. */
const Y_LABEL_CHAR_PX = 6.4;
const Y_LABEL_GAP = 8;

/**
 * 3–4 "nice" y-axis tick values inside [lo, hi] — 1/2/2.5/5 × 10ⁿ steps. Pure
 * presentation: it picks where to draw reference lines, never moves a point.
 * Exported for the unit test.
 */
export function niceTicks(lo: number, hi: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  let best: number[] = [];
  for (const target of [3, 4, 2, 5]) {
    const rough = (hi - lo) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (out.length >= 3 && out.length <= 4) return out;
    if (best.length === 0 || Math.abs(out.length - 3.5) < Math.abs(best.length - 3.5)) best = out;
  }
  return best;
}

/** Default date label — "Jan 1, 2025" (UTC), matching the Net Worth chart exactly. */
function defaultFormatDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function ts(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

type Pt = TrendGeomPoint;
type Run = TrendRun;

/**
 * How each basis is DRAWN. A lookup table, not a decision: the caller has
 * already classified the point, and this only says what that class looks like.
 *
 * `unreliable` gets NO area fill on purpose. A filled area reads as substance
 * beneath the line, and the whole claim of an unreliable run is that most of it
 * could not be valued — so the line is drawn and nothing is asserted under it.
 * The dotted stroke and the lowest opacity put it visibly below a reconstructed
 * estimate rather than beside it.
 */
const RUN_STYLE: Record<TrendBasis, { fill: string | null; opacity: number; dash?: string }> = {
  observed:      { fill: "url(#tc-fill)",       opacity: 1 },
  reconstructed: { fill: "url(#tc-fill-recon)", opacity: 0.6,  dash: "4 3" },
  unreliable:    { fill: null,                  opacity: 0.34, dash: "1 4" },
  // RWA-2A — a manual asset's estimates. Recorded is the solid line between two
  // same-day anchors only; a modeled run is dashed like a reconstruction; a
  // carried-forward run is a long dash with no fill (nothing new is asserted).
  recorded:      { fill: "url(#tc-fill)",       opacity: 1 },
  modeled:       { fill: "url(#tc-fill-recon)", opacity: 0.6,  dash: "4 3" },
  carried:       { fill: null,                  opacity: 0.6,  dash: "8 4" },
};

/** The tooltip's one-word provenance suffix. Text, not logic. */
const BASIS_SUFFIX: Record<TrendBasis, string | null> = {
  observed:      null,
  reconstructed: "rebuilt",
  unreliable:    "low confidence",
  recorded:      "your estimate",
  modeled:       "modeled — not a market price",
  carried:       "latest estimate, carried forward",
};

/** RWA-2A — the user-estimate bases (a manual asset's chart). */
const ESTIMATE_BASES: ReadonlySet<TrendBasis> = new Set<TrendBasis>(["recorded", "modeled", "carried"]);

export function TrendChart({
  points,
  currency,
  headerRight,
  emptyMessage = "No history in this range yet. Widen the range or connect accounts to build history.",
  ariaLabel,
  formatDate = defaultFormatDate,
  onSelectPoint,
}: {
  points:       TrendPoint[];
  currency:     string;
  /** Optional control above the plot (e.g. the desktop Assets slice chips). */
  headerRight?: ReactNode;
  emptyMessage?: string;
  ariaLabel?:   string;
  formatDate?:  (iso: string) => string;
  /**
   * V26-S3-DETAIL — OPTIONAL. When supplied, a point becomes selectable and the
   * chart reports WHICH DATE was chosen — nothing more. It computes no
   * composition, no total and no completeness; the consumer asks the canonical
   * historical authority for those. Omitted ⇒ the chart is exactly as it was.
   */
  onSelectPoint?: (dateISO: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const label = ariaLabel ?? "Balance history";

  // Measure rather than stretch — non-uniform scaling warps markers into ovals.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const pts: Pt[] = points.map((p) => ({
      date: p.date, t: ts(p.date), value: p.value, estimated: p.estimated, basis: p.basis,
    }));
    if (pts.length === 0) return null;

    const times = pts.map((p) => p.t);
    const tMin = times[0];
    const tMax = times[times.length - 1];
    const tSpan = tMax - tMin || 1;

    const values = pts.map((p) => p.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const yLo = lo - span * 0.18;
    const yHi = hi + span * 0.14;

    const y = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD_T - PAD_B);

    // y-axis ticks, labelled in the CALLER's display currency. Labels that would
    // read identically (a flat series) collapse to one. The left gutter is sized
    // from the longest label so nothing clips, at 375px too.
    const ticks: { v: number; label: string }[] = [];
    for (const v of niceTicks(yLo, yHi)) {
      const lbl = formatCompactCurrency(v, currency);
      if (!ticks.some((t) => t.label === lbl)) ticks.push({ v, label: lbl });
    }
    const padL = Math.ceil(Math.max(0, ...ticks.map((t) => t.label.length)) * Y_LABEL_CHAR_PX) + Y_LABEL_GAP;
    const plotW = Math.max(1, w - padL);

    const x = (t: number) => padL + (pts.length === 1 ? plotW / 2 : ((t - tMin) / tSpan) * plotW);

    const gapDays = Math.max(medianSpacingDays(times) * 3, medianSpacingDays(times) + 2);
    // v2.7 — JOIN across a basis change: a run that begins at a basis seam (adjacent
    // points, no date hole) starts its path at the previous run's last point, so the
    // line flows on in the new run's style. Date holes are untouched (no seam there).
    const joinFrom = new Map<Pt, Pt>(toBasisSeams(pts, gapDays).map((s) => [pts[s.toIndex], pts[s.fromIndex]]));
    const runs = toRuns(pts, gapDays).map((run) => {
      const prev = joinFrom.get(run.points[0]);
      return prev && run.points[0] !== prev ? { ...run, points: [prev, ...run.points] } : run;
    });

    const line = (run: Run) =>
      run.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const area = (run: Run) => {
      if (run.points.length < 2) return "";
      const first = run.points[0];
      const last = run.points[run.points.length - 1];
      return `${line(run)} L${x(last.t).toFixed(1)},${H - PAD_B} L${x(first.t).toFixed(1)},${H - PAD_B} Z`;
    };

    const gaps = toDateGaps(pts, gapDays).map((g) => ({
      x0: x(pts[g.fromIndex].t), x1: x(pts[g.toIndex].t),
    }));

    return { pts, x, y, runs, line, area, gaps, ticks, padL, last: pts[pts.length - 1] };
  }, [points, w, currency]);

  /** The point nearest an x offset, or null inside a gap. */
  function nearestIndex(clientX: number): number | null {
    if (!geom) return null;
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = clientX - rect.left;
    let best: number | null = null;
    let bestD = Infinity;
    geom.pts.forEach((p, i) => {
      const d = Math.abs(geom.x(p.t) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    // Don't snap across the hole — inside a gap the honest answer is "nothing".
    return bestD < 20 ? best : null;
  }

  function onMove(e: React.PointerEvent) {
    setHover(nearestIndex(e.clientX));
  }

  /**
   * V26-S4 — A CLICK SELECTS WITHOUT NEEDING A HOVER FIRST.
   *
   * Selection used to read the `hover` state, so the first click on a chart did
   * nothing: on touch, and for keyboard and assistive-technology users, no
   * pointer-move precedes the click, and a control that requires one is a
   * control those users cannot operate. The click now resolves the point from
   * its OWN coordinates and falls back to the hovered point only when it lands
   * in a gap.
   */
  function onSelect(e: React.MouseEvent) {
    if (!onSelectPoint || !geom) return;
    const i = nearestIndex(e.clientX) ?? hover;
    if (i === null) return;
    setHover(i);
    onSelectPoint(geom.pts[i].date);
  }

  /** Keyboard: arrows move the selection, Enter/Space opens it. */
  function onKeys(e: React.KeyboardEvent) {
    if (!onSelectPoint || !geom) return;
    const last = geom.pts.length - 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const from = hover ?? last;
      setHover(Math.max(0, Math.min(last, from + (e.key === "ArrowRight" ? 1 : -1))));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : last);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectPoint(geom.pts[hover ?? last].date);
    }
  }

  // v2.7 — no title / subtitle; a header row exists only to hold headerRight.
  const header = headerRight ? (
    <div className="mb-4 flex flex-wrap items-baseline justify-end gap-x-4 gap-y-2">
      {headerRight}
    </div>
  ) : null;

  if (!geom) {
    return (
      <section>
        {header}
        <div className="py-6 text-center">
          <p className="text-xs text-[var(--text-faint)] max-w-xs mx-auto leading-relaxed">{emptyMessage}</p>
        </div>
      </section>
    );
  }

  const hoverPt = hover !== null ? geom.pts[hover] : null;

  return (
    <section>
      {header}

      <div className="relative">
        <div
          ref={wrap}
          className={`relative touch-pan-y${onSelectPoint ? " cursor-pointer" : ""}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onClick={onSelect}
          onKeyDown={onKeys}
          onFocus={() => { if (onSelectPoint && hover === null && geom) setHover(geom.pts.length - 1); }}
          role={onSelectPoint ? "button" : undefined}
          tabIndex={onSelectPoint ? 0 : undefined}
          aria-label={onSelectPoint ? `${label} — arrow keys move between dates, Enter opens the selected date` : undefined}
        >
          <svg width="100%" height={H} className="block overflow-visible" role="img" aria-label={label}>
            <defs>
              <linearGradient id="tc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--meridian-400)" stopOpacity="0.18" />
                <stop offset="100%" stopColor="var(--meridian-400)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="tc-fill-recon" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--meridian-400)" stopOpacity="0.10" />
                <stop offset="100%" stopColor="var(--meridian-400)" stopOpacity="0" />
              </linearGradient>
              <pattern id="tc-hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="5" stroke="var(--text-muted)" strokeWidth="1" strokeOpacity="0.30" />
              </pattern>
            </defs>

            {/* The unknown, drawn as a thing rather than as nothing. */}
            {geom.gaps.map((g, i) => (
              <g key={i}>
                <rect x={g.x0} y={PAD_T - 4} width={g.x1 - g.x0} height={H - PAD_T - PAD_B + 4} fill="url(#tc-hatch)" />
                <line x1={g.x0} y1={PAD_T - 4} x2={g.x0} y2={H - PAD_B} stroke="var(--border-hairline-strong)" strokeWidth="1" strokeDasharray="2 3" />
                <line x1={g.x1} y1={PAD_T - 4} x2={g.x1} y2={H - PAD_B} stroke="var(--border-hairline-strong)" strokeWidth="1" strokeDasharray="2 3" />
                <text x={(g.x0 + g.x1) / 2} y={H - PAD_B - 8} textAnchor="middle" className="fill-[var(--text-muted)] text-[9px] uppercase" style={{ letterSpacing: "0.08em" }}>
                  no data
                </text>
              </g>
            ))}

            {/* y-axis — subtle gridlines + compact value labels in the caller's currency. */}
            <g data-trend-y-axis="">
              {geom.ticks.map((t) => (
                <g key={t.v}>
                  <line x1={geom.padL} y1={geom.y(t.v)} x2={w} y2={geom.y(t.v)} stroke="var(--border-hairline)" strokeWidth="1" strokeOpacity="0.6" />
                  <text x={geom.padL - Y_LABEL_GAP} y={geom.y(t.v)} dy="0.32em" textAnchor="end" className="fill-[var(--text-muted)] text-[11px] tabular-nums">
                    {t.label}
                  </text>
                </g>
              ))}
            </g>

            {/* Baseline */}
            <line x1={geom.padL} y1={H - PAD_B} x2={w} y2={H - PAD_B} stroke="var(--border-hairline)" strokeWidth="1" />

            {geom.runs.map((run, i) => (
              <g key={i}>
                {run.points.length > 1 && RUN_STYLE[run.basis].fill && (
                  <path d={geom.area(run)} fill={RUN_STYLE[run.basis].fill!} />
                )}
                <path
                  d={geom.line(run)}
                  fill="none"
                  stroke="var(--meridian-400)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={RUN_STYLE[run.basis].opacity}
                  strokeDasharray={RUN_STYLE[run.basis].dash}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}

            {/* Every reconstructed / unreliable point gets a hollow marker, faded by
                its basis. (RWA-2A: a modeled or carried estimate is shown by its run's
                stroke alone — a marker per sampled day would read as many entries.) */}
            {geom.pts.filter((p) => basisOf(p) === "reconstructed" || basisOf(p) === "unreliable").map((p) => (
              <circle
                key={p.date} cx={geom.x(p.t)} cy={geom.y(p.value)} r="2.5"
                fill="var(--bg-base)" stroke="var(--meridian-400)" strokeWidth="1.25"
                strokeOpacity={basisOf(p) === "unreliable" ? 0.4 : 0.7}
              />
            ))}

            {/* RWA-2A — each value the user RECORDED is a solid dot: the anchors. */}
            {geom.pts.filter((p) => basisOf(p) === "recorded").map((p) => (
              <circle key={`rec-${p.date}`} cx={geom.x(p.t)} cy={geom.y(p.value)} r="3" fill="var(--meridian-400)" />
            ))}

            {/* The last point — the always-on marker. */}
            <circle cx={geom.x(geom.last.t)} cy={geom.y(geom.last.value)} r="3.5" fill="var(--meridian-400)" />
            <circle cx={geom.x(geom.last.t)} cy={geom.y(geom.last.value)} r="7" fill="var(--meridian-400)" fillOpacity="0.16" />

            {hover !== null && hoverPt && (
              <g pointerEvents="none">
                <line x1={geom.x(hoverPt.t)} y1={PAD_T - 4} x2={geom.x(hoverPt.t)} y2={H - PAD_B} stroke="var(--border-hairline-strong)" strokeWidth="1" />
                <circle cx={geom.x(hoverPt.t)} cy={geom.y(hoverPt.value)} r="4" fill={basisOf(hoverPt) === "observed" || basisOf(hoverPt) === "recorded" ? "var(--meridian-400)" : "var(--bg-base)"} stroke="var(--meridian-400)" strokeWidth="1.5" />
              </g>
            )}
          </svg>

          {/* HTML tooltip — real text, can sit outside the SVG clip. */}
          {hoverPt && (
            <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2" style={{ left: Math.min(Math.max(geom.x(hoverPt.t), 62), w - 62) }}>
              <div className="rounded-[var(--radius-sm)] border border-[var(--border-hairline-strong)] px-2.5 py-1.5 shadow-[var(--shadow-e3)]" style={{ background: "var(--glass-thick)" }}>
                <p className="text-sm font-medium tabular-nums text-[var(--text-primary)]">
                  {formatCompactCurrency(hoverPt.value, currency)}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                  {formatDate(hoverPt.date)}
                  {BASIS_SUFFIX[basisOf(hoverPt)] && (
                    <span className="text-[var(--text-secondary)]">· {BASIS_SUFFIX[basisOf(hoverPt)]}</span>
                  )}
                </p>
                {/* Disclosure the CALLER wrote. Rendered verbatim, never composed here. */}
                {hover !== null && points[hover]?.coverageLabel && (
                  <p className="mt-0.5 text-[11px] text-[var(--text-faint)]">{points[hover].coverageLabel}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Axis — three labels; the shape is the message, dates are orientation. */}
        <div className="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]" style={{ paddingLeft: geom.padL }}>
          <span>{formatDate(geom.pts[0].date)}</span>
          <span>{formatDate(geom.pts[Math.floor(geom.pts.length / 2)].date)}</span>
          <span>{formatDate(geom.last.date)}</span>
        </div>

        {/* Legend — v2.7: ONLY Observed / Reconstructed / Never observed, each only
            when present. No other legend items. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[var(--text-muted)]">
          {/* RWA-2A — a chart of user estimates has no observed values, so it never
              claims an "Observed" line; every other chart is unchanged. */}
          {geom.pts.some((p) => basisOf(p) === "observed") && !geom.pts.every((p) => ESTIMATE_BASES.has(basisOf(p))) && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke="var(--meridian-400)" strokeWidth="1.75" /></svg>
              Observed
            </span>
          )}
          {geom.pts.some((p) => basisOf(p) === "reconstructed") && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke="var(--meridian-400)" strokeWidth="1.75" strokeOpacity="0.6" strokeDasharray="4 3" /></svg>
              Reconstructed
            </span>
          )}
          {geom.gaps.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="16" height="8" aria-hidden><rect width="16" height="8" fill="url(#tc-hatch)" /></svg>
              Never observed
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
