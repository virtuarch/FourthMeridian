"use client";

/**
 * components/space/widgets/investments/PortfolioValueChart.tsx
 *
 * SD-4 FU-CHART — "Portfolio Value Over Time", the dominant analytical visual of the
 * Investments Workspace. Presentation ONLY: it plots the canonical PortfolioValuePoint
 * series (from the persisted SpaceSnapshot window, value = investments + crypto), which
 * the Workspace has already display-converted through the canonical money seam. It does
 * NO valuation, NO reconstruction, NO FX math — it renders points.
 *
 * Responds to canonical time: the series is CLIPPED to the shell window
 * [compareTo ?? earliest, asOf] — never plots the future, and follows Compare To as the
 * window start. Fully responsive: a viewBox area/line (non-scaling stroke) fills the
 * container width at a fixed height; value/date labels are HTML overlays so nothing
 * distorts. Reconstructed/estimated history is disclosed, never hidden.
 */

import { useMemo } from "react";
import type { PortfolioValuePoint } from "@/lib/investments/portfolio-series";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";

const VB = 1000; // viewBox units (square; preserveAspectRatio none stretches to the box)

export function PortfolioValueChart({
  points,
  currency,
  asOf,
  compareTo,
}: {
  points:    PortfolioValuePoint[];
  currency:  string;
  asOf:      string;
  compareTo: string | null;
}) {
  const view = useMemo(() => {
    // Clip to the shell window: date ≤ asOf (never future) and ≥ compareTo when set.
    const clipped = points
      .filter((p) => p.date <= asOf && (compareTo == null || p.date >= compareTo))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (clipped.length < 2) return null;

    const t = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
    const tMin = t(clipped[0].date);
    const tMax = t(clipped[clipped.length - 1].date);
    const tSpan = Math.max(1, tMax - tMin);
    const yMax = Math.max(...clipped.map((p) => p.value), 1) * 1.1;

    const xy = clipped.map((p) => ({
      x: ((t(p.date) - tMin) / tSpan) * VB,
      y: VB - (p.value / yMax) * VB,
    }));
    const line = xy.map((q, i) => `${i === 0 ? "M" : "L"}${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(" ");
    const area = `${line} L${VB},${VB} L0,${VB} Z`;

    return {
      line, area, yMax,
      first: clipped[0], last: clipped[clipped.length - 1],
      anyEstimated: clipped.some((p) => p.estimated),
      count: clipped.length,
    };
  }, [points, asOf, compareTo]);

  if (!view) {
    return (
      <div className="flex items-center justify-center h-40 text-sm" style={{ color: "var(--text-muted)" }}>
        Not enough history to chart this window yet.
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {/* Header: latest value + window. */}
      <div className="flex items-end justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0">
          <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
            {formatCurrency(view.last.value, currency)}
          </p>
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>
            {view.first.date} → {view.last.date}
            {view.anyEstimated && <span> · includes reconstructed history</span>}
          </p>
        </div>
        <p className="text-xs tabular-nums shrink-0" style={{ color: "var(--text-muted)" }}>peak {formatCompactCurrency(view.yMax / 1.1, currency)}</p>
      </div>

      {/* The area/line — responsive, non-distorting stroke. */}
      <div className="relative w-full h-52">
        <svg viewBox={`0 0 ${VB} ${VB}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden>
          <defs>
            <linearGradient id="pvt-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-positive, #34d399)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--accent-positive, #34d399)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={view.area} fill="url(#pvt-fill)" />
          <path d={view.line} fill="none" stroke="var(--accent-positive, #34d399)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </div>
      {/* Baseline label. */}
      <div className="flex items-center justify-between mt-1 text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
        <span>{view.first.date}</span>
        <span>{formatCompactCurrency(0, currency)} baseline</span>
        <span>{view.last.date}</span>
      </div>
    </div>
  );
}
