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
 *   - the line BREAKS at real gaps AND at a basis change (observed↔reconstructed);
 *   - reconstructed runs are dashed + faint with HOLLOW markers;
 *   - the unknown is a hatched "NO DATA" band, not an absence;
 *   - y-scale from real points ONLY (no interpolation across the hole);
 *   - three axis labels; an HTML tooltip that won't snap across a gap; honest legend.
 *
 * This core is domain-free: it takes points `{date,value,estimated}`, a currency, and
 * presentation slots (title / subtitle / headerRight). The consumer owns what the
 * series MEANS (net worth vs invested value) and any metric switcher (headerRight).
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatCompactCurrency } from "@/lib/format";

export interface TrendPoint {
  /** YYYY-MM-DD. */
  date:      string;
  value:     number;
  /** True when reconstructed / display-estimated (drawn as a different KIND of fact). */
  estimated: boolean;
}

const H = 264;
const PAD_T = 16;
const PAD_B = 26;

/** Default date label — "Jan 1, 2025" (UTC), matching the Net Worth chart exactly. */
function defaultFormatDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function ts(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Median day-spacing across consecutive points — a robust gap scale. */
function medianSpacingDays(times: number[]): number {
  if (times.length < 2) return 1;
  const diffs = times.slice(1).map((t, i) => (t - times[i]) / 86_400_000).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

interface Pt { date: string; t: number; value: number; estimated: boolean }
interface Run { points: Pt[]; basis: "observed" | "reconstructed" }

/**
 * Split into contiguous runs, breaking on (a) a real date hole and (b) a change of
 * basis. Adjacent runs SHARE the boundary point across a basis change (the line stays
 * connected where knowledge is, only its character changes) but NEVER across a hole.
 */
function toRuns(pts: Pt[], gapDays: number): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const hole = prev ? (p.t - prev.t) / 86_400_000 > gapDays : false;
    const basis: Run["basis"] = p.estimated ? "reconstructed" : "observed";
    const basisChanged = prev ? (prev.estimated ? "reconstructed" : "observed") !== basis : false;
    if (!cur || hole || basisChanged) {
      cur = { points: [p], basis };
      runs.push(cur);
      if (basisChanged && !hole && prev) cur.points.unshift(prev);
    } else {
      cur.points.push(p);
    }
  }
  return runs.filter((r) => r.points.length > 0);
}

export function TrendChart({
  points,
  currency,
  title = "Balance history",
  subtitle,
  headerRight,
  emptyMessage = "No history in this range yet. Widen the range or connect accounts to build history.",
  ariaLabel,
  formatDate = defaultFormatDate,
}: {
  points:       TrendPoint[];
  currency:     string;
  title?:       ReactNode;
  subtitle?:    ReactNode;
  /** Optional control opposite the title (e.g. a metric switcher). */
  headerRight?: ReactNode;
  emptyMessage?: string;
  ariaLabel?:   string;
  formatDate?:  (iso: string) => string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const label = ariaLabel ?? (typeof title === "string" ? title : "trend");

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
    const pts: Pt[] = points.map((p) => ({ date: p.date, t: ts(p.date), value: p.value, estimated: p.estimated }));
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

    const x = (t: number) => (pts.length === 1 ? w / 2 : ((t - tMin) / tSpan) * w);
    const y = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD_T - PAD_B);

    const gapDays = Math.max(medianSpacingDays(times) * 3, medianSpacingDays(times) + 2);
    const runs = toRuns(pts, gapDays);

    const line = (run: Run) =>
      run.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const area = (run: Run) => {
      if (run.points.length < 2) return "";
      const first = run.points[0];
      const last = run.points[run.points.length - 1];
      return `${line(run)} L${x(last.t).toFixed(1)},${H - PAD_B} L${x(first.t).toFixed(1)},${H - PAD_B} Z`;
    };

    const gaps: Array<{ x0: number; x1: number }> = [];
    for (let i = 1; i < pts.length; i++) {
      if ((pts[i].t - pts[i - 1].t) / 86_400_000 > gapDays) gaps.push({ x0: x(pts[i - 1].t), x1: x(pts[i].t) });
    }

    return { pts, x, y, runs, line, area, gaps, last: pts[pts.length - 1] };
  }, [points, w]);

  function onMove(e: React.PointerEvent) {
    if (!geom) return;
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    let best: number | null = null;
    let bestD = Infinity;
    geom.pts.forEach((p, i) => {
      const d = Math.abs(geom.x(p.t) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    // Don't snap across the hole — inside a gap the honest answer is "nothing".
    setHover(bestD < 20 ? best : null);
  }

  const header = (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      {headerRight}
    </div>
  );

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
        <div ref={wrap} className="relative touch-pan-y" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
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

            {/* Baseline */}
            <line x1="0" y1={H - PAD_B} x2={w} y2={H - PAD_B} stroke="var(--border-hairline)" strokeWidth="1" />

            {geom.runs.map((run, i) => (
              <g key={i}>
                {run.points.length > 1 && (
                  <path d={geom.area(run)} fill={run.basis === "observed" ? "url(#tc-fill)" : "url(#tc-fill-recon)"} />
                )}
                <path
                  d={geom.line(run)}
                  fill="none"
                  stroke="var(--meridian-400)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={run.basis === "observed" ? 1 : 0.6}
                  strokeDasharray={run.basis === "reconstructed" ? "4 3" : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}

            {/* Reconstructed points get hollow markers. */}
            {geom.pts.filter((p) => p.estimated).map((p) => (
              <circle key={p.date} cx={geom.x(p.t)} cy={geom.y(p.value)} r="2.5" fill="var(--bg-base)" stroke="var(--meridian-400)" strokeWidth="1.25" strokeOpacity="0.7" />
            ))}

            {/* The last point — the always-on marker. */}
            <circle cx={geom.x(geom.last.t)} cy={geom.y(geom.last.value)} r="3.5" fill="var(--meridian-400)" />
            <circle cx={geom.x(geom.last.t)} cy={geom.y(geom.last.value)} r="7" fill="var(--meridian-400)" fillOpacity="0.16" />

            {hover !== null && hoverPt && (
              <g pointerEvents="none">
                <line x1={geom.x(hoverPt.t)} y1={PAD_T - 4} x2={geom.x(hoverPt.t)} y2={H - PAD_B} stroke="var(--border-hairline-strong)" strokeWidth="1" />
                <circle cx={geom.x(hoverPt.t)} cy={geom.y(hoverPt.value)} r="4" fill={hoverPt.estimated ? "var(--bg-base)" : "var(--meridian-400)"} stroke="var(--meridian-400)" strokeWidth="1.5" />
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
                  {hoverPt.estimated && <span className="text-[var(--text-secondary)]">· rebuilt</span>}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Axis — three labels; the shape is the message, dates are orientation. */}
        <div className="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]">
          <span>{formatDate(geom.pts[0].date)}</span>
          <span>{formatDate(geom.pts[Math.floor(geom.pts.length / 2)].date)}</span>
          <span>{formatDate(geom.last.date)}</span>
        </div>

        {/* Legend — honest markers only (Observed / Reconstructed / Never observed). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke="var(--meridian-400)" strokeWidth="1.75" /></svg>
            Observed
          </span>
          {geom.pts.some((p) => p.estimated) && (
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
