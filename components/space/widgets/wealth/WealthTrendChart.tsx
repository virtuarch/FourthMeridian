"use client";

/**
 * components/space/widgets/wealth/WealthTrendChart.tsx
 *
 * Surface ② — the dominant historical chart (upgraded from WealthNetWorthChart).
 * A metric trajectory across the shared range, marking As Of and Compare To. It
 * owns NO time state: the range is the shell's; clicking a point sets the shared
 * As Of through the injected callback.
 *
 * Honesty (regression-critical, preserved):
 *   - points ONLY at real snapshot dates — never interpolated;
 *   - real gaps stay visible: the line AND the area fill break at genuine gaps
 *     (contiguous daily history renders as one unbroken run, so this is a no-op
 *     for dense data and an honest break for sparse data);
 *   - estimated snapshots read as hollow dashed markers;
 *   - As Of solid guide + Compare To dashed guide;
 *   - honest legend + "gaps are real" note; non-scaling strokes.
 *
 * Added (S7): responsive dominant height; low-alpha Meridian area fill under the
 * PRIMARY series only; minimal y-ticks + gridlines + month x-labels; a pointer/
 * touch-scrub tooltip (replacing title-attr tooltips; aria-labels kept); the
 * Compare-period overlay (result.chart.compareSeries) mapped by offset onto the
 * primary x-range so the two shapes superimpose; and a metric switcher whose
 * choice is surfaced via onMetricChange so the host can URL-sync it.
 */

import { useState } from "react";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { WealthCard, WealthUnavailable } from "./wealth-ui";

const PAD_X = 5;   // % horizontal padding
const TOP = 10;    // % top padding
const BOT = 84;    // % baseline (x-labels live below in the overlay)

export type WealthMetricKey = "netWorth" | "totalAssets" | "totalLiabilities" | "liquidNetWorth";

const METRICS: { key: WealthMetricKey; label: string; title: string; good: "up" | "down" }[] = [
  { key: "netWorth",         label: "Net Worth",   title: "net worth",       good: "up" },
  { key: "totalAssets",      label: "Assets",      title: "total assets",    good: "up" },
  { key: "totalLiabilities", label: "Liabilities", title: "total liabilities", good: "down" },
  { key: "liquidNetWorth",   label: "Liquid NW",   title: "liquid net worth", good: "up" },
];

function ts(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Median day-spacing across consecutive points (robust gap scale). */
function medianSpacingDays(times: number[]): number {
  if (times.length < 2) return 1;
  const diffs = times.slice(1).map((t, i) => (t - times[i]) / 86_400_000).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

/** Contiguous runs of point indices; a new run starts at a genuine time gap. */
function detectRuns(times: number[]): number[][] {
  if (times.length === 0) return [];
  const median = medianSpacingDays(times);
  const gapDays = Math.max(median * 3, median + 2);
  const runs: number[][] = [[0]];
  for (let i = 1; i < times.length; i++) {
    const spanDays = (times[i] - times[i - 1]) / 86_400_000;
    if (spanDays > gapDays) runs.push([i]);
    else runs[runs.length - 1].push(i);
  }
  return runs;
}

export function WealthTrendChart({
  result,
  currency,
  onSelectAsOf,
  metric: controlledMetric,
  onMetricChange,
}: {
  result:         WealthResult;
  currency:       string;
  onSelectAsOf?:  (date: string) => void;
  /** Controlled metric (host URL-syncs it in S8); falls back to internal state. */
  metric?:        WealthMetricKey;
  onMetricChange?: (m: WealthMetricKey) => void;
}) {
  const [internalMetric, setInternalMetric] = useState<WealthMetricKey>("netWorth");
  const [hover, setHover] = useState<number | null>(null);

  const metric = controlledMetric ?? internalMetric;
  const metricDef = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  const setMetric = (m: WealthMetricKey) => {
    setInternalMetric(m);
    onMetricChange?.(m);
  };
  // Both WealthChartPoint and WealthState carry the four metric fields.
  const sel = (p: Record<WealthMetricKey, number>) => p[metric];

  const pts = result.chart.points;
  const compareSeries = result.chart.compareSeries;

  const switcher = (
    <SegmentedControl<WealthMetricKey>
      options={METRICS.map((m) => ({ id: m.key, label: m.label }))}
      value={metric}
      onChange={setMetric}
      aria-label="Chart metric"
      className="max-w-full"
    />
  );

  const subtitle =
    result.chart.compareDate
      ? `${formatWealthDate(result.chart.asOfDate ?? result.asOf)} vs ${formatWealthDate(result.chart.compareDate)}`
      : result.chart.asOfDate
        ? `As of ${formatWealthDate(result.chart.asOfDate)}`
        : `${metricDef.title} over time`;

  if (pts.length === 0) {
    return (
      <WealthCard title={`How has my ${metricDef.title} changed?`} subtitle={subtitle} right={switcher}>
        <WealthUnavailable message="No snapshot history in this range yet. Widen the range or connect accounts to build history." />
      </WealthCard>
    );
  }

  const times = pts.map((p) => ts(p.date));
  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tSpan = tMax - tMin || 1;

  // Shared y-scale across BOTH series so the overlay's shape is comparable.
  const allVals = [...pts.map(sel), ...compareSeries.map(sel)];
  const vMin = Math.min(...allVals);
  const vMax = Math.max(...allVals);
  const vSpan = vMax - vMin || 1;

  const xPct = (t: number) => (pts.length === 1 ? 50 : PAD_X + ((100 - 2 * PAD_X) * (t - tMin)) / tSpan);
  const yPct = (v: number) => BOT - ((BOT - TOP) * (v - vMin)) / vSpan;

  // Compare overlay: map its own window onto the primary x-range (offset align).
  const cTimes = compareSeries.map((p) => ts(p.date));
  const cMin = cTimes[0];
  const cMax = cTimes[cTimes.length - 1];
  const cSpan = (cMax ?? 0) - (cMin ?? 0) || 1;
  const xPctCompare = (t: number) =>
    compareSeries.length === 1 ? 50 : PAD_X + ((100 - 2 * PAD_X) * (t - cMin)) / cSpan;

  const runs = detectRuns(times);

  const asOfX    = result.chart.asOfDate ? xPct(ts(result.chart.asOfDate)) : null;
  const compareX = result.chart.compareDate ? xPct(ts(result.chart.compareDate)) : null;

  // Minimal axes — 4 y-ticks + month x-labels (first point of each new month).
  const yTicks = Array.from({ length: 4 }, (_, i) => vMin + (vSpan * i) / 3);
  const monthLabels: { x: number; label: string }[] = [];
  let lastMonth = "";
  for (const p of pts) {
    const ym = p.date.slice(0, 7);
    if (ym !== lastMonth) {
      lastMonth = ym;
      const d = new Date(`${p.date}T00:00:00.000Z`);
      const label = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) +
        (times.length && (tMax - tMin) / 86_400_000 > 400 ? ` '${String(d.getUTCFullYear()).slice(2)}` : "");
      monthLabels.push({ x: xPct(ts(p.date)), label });
    }
  }
  const thinnedLabels = monthLabels.length > 7
    ? monthLabels.filter((_, i) => i % Math.ceil(monthLabels.length / 7) === 0)
    : monthLabels;

  const asOfValue    = result.asOfState.found ? sel(result.asOfState) : null;
  const compareValue = result.compareState?.found ? sel(result.compareState) : null;

  const hoverPt = hover !== null ? pts[hover] : null;

  function handlePointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const xTarget = ((e.clientX - rect.left) / rect.width) * 100;
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(xPct(ts(p.date)) - xTarget);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  }

  return (
    <WealthCard
      title={`How has my ${metricDef.title} changed?`}
      subtitle={subtitle}
      right={switcher}
    >
      {/* Compact readout — the As Of value and, when present, the "was" value. */}
      <div className="flex items-baseline justify-end gap-2 mb-2 min-h-[1.25rem]">
        {asOfValue !== null && (
          <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
            {formatCurrency(asOfValue, currency)}
          </span>
        )}
        {compareValue !== null && (
          <span className="text-[11px] tabular-nums text-[var(--text-faint)]">
            was {formatCurrency(compareValue, currency)}
          </span>
        )}
      </div>

      <div
        className="relative w-full h-[260px] sm:h-[380px]"
        onPointerMove={handlePointer}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: "pan-y" }}
      >
        {/* Gridlines + line + fill + guides (stretched viewBox; strokes stay crisp). */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {/* Hairline gridlines at each y-tick. */}
          {yTicks.map((v, i) => (
            <line key={i} x1={PAD_X} x2={100 - PAD_X} y1={yPct(v)} y2={yPct(v)}
              stroke="var(--border-hairline)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}

          {/* Compare-period overlay — dashed, faint, no fill (only when honest). */}
          {compareSeries.length >= 2 && (
            <polyline
              points={compareSeries.map((p) => `${xPctCompare(ts(p.date)).toFixed(2)},${yPct(sel(p)).toFixed(2)}`).join(" ")}
              fill="none" stroke="var(--text-faint)" strokeWidth={1.25} strokeDasharray="3 3"
              strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Primary series — per-run area fill (never bridges a real gap). */}
          {runs.map((run, ri) => {
            if (run.length < 2) return null;
            const first = pts[run[0]], last = pts[run[run.length - 1]];
            const d = [
              `M ${xPct(ts(first.date)).toFixed(2)},${yPct(sel(first)).toFixed(2)}`,
              ...run.slice(1).map((idx) => `L ${xPct(ts(pts[idx].date)).toFixed(2)},${yPct(sel(pts[idx])).toFixed(2)}`),
              `L ${xPct(ts(last.date)).toFixed(2)},${BOT}`,
              `L ${xPct(ts(first.date)).toFixed(2)},${BOT}`,
              "Z",
            ].join(" ");
            return <path key={`fill-${ri}`} d={d} fill="var(--meridian-400)" fillOpacity={0.1} stroke="none" />;
          })}

          {/* Primary series — per-run line (breaks at genuine gaps). */}
          {runs.map((run, ri) =>
            run.length >= 2 ? (
              <polyline key={`line-${ri}`}
                points={run.map((idx) => `${xPct(ts(pts[idx].date)).toFixed(2)},${yPct(sel(pts[idx])).toFixed(2)}`).join(" ")}
                fill="none" stroke="var(--meridian-400)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                vectorEffect="non-scaling-stroke" />
            ) : null
          )}

          {/* Compare To dashed guide + As Of solid guide. */}
          {compareX !== null && (
            <line x1={compareX} x2={compareX} y1={TOP - 2} y2={BOT + 2} stroke="var(--text-faint)"
              strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          {asOfX !== null && (
            <line x1={asOfX} x2={asOfX} y1={TOP - 2} y2={BOT + 2} stroke="var(--accent-info)"
              strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          )}
        </svg>

        {/* y-tick labels (compact currency), top-anchored to each gridline. */}
        <div className="absolute inset-0 pointer-events-none">
          {yTicks.map((v, i) => (
            <span key={i} className="absolute left-0 -translate-y-1/2 text-[10px] tabular-nums text-[var(--text-faint)]"
              style={{ top: `${yPct(v)}%` }}>
              {formatCompactCurrency(v, currency)}
            </span>
          ))}
          {/* month x-labels along the baseline. */}
          {thinnedLabels.map((m, i) => (
            <span key={i} className="absolute -translate-x-1/2 text-[10px] text-[var(--text-faint)]"
              style={{ left: `${m.x}%`, top: `${BOT + 4}%` }}>
              {m.label}
            </span>
          ))}
        </div>

        {/* Clickable snapshot dots (round; aria-labels only — no title tooltips). */}
        <div className="absolute inset-0">
          {pts.map((p, i) => {
            const left = xPct(ts(p.date));
            const top = yPct(sel(p));
            const isAsOf = p.date === result.chart.asOfDate;
            const isCompare = p.date === result.chart.compareDate;
            const isHover = i === hover;
            const dot = (
              <span
                className="block rounded-full"
                style={{
                  width: isAsOf || isHover ? 11 : 7,
                  height: isAsOf || isHover ? 11 : 7,
                  background: p.isEstimated ? "transparent" : isAsOf ? "var(--accent-info)" : isCompare ? "var(--text-secondary)" : "var(--meridian-400)",
                  border: p.isEstimated
                    ? "1.5px dashed var(--meridian-400)"
                    : isAsOf ? "2px solid var(--surface-inset)" : "none",
                  boxShadow: isAsOf ? "0 0 0 2px var(--accent-info)" : isHover ? "0 0 0 2px var(--meridian-400)" : "none",
                }}
              />
            );
            const commonStyle: React.CSSProperties = { left: `${left}%`, top: `${top}%`, transform: "translate(-50%, -50%)" };
            const label = `${formatWealthDate(p.date)} · ${formatCurrency(sel(p), currency)}${p.isEstimated ? " · reconstructed" : ""}`;
            return onSelectAsOf ? (
              <button key={p.date} type="button" onClick={() => onSelectAsOf(p.date)}
                aria-label={`Set As Of to ${label}`}
                className="absolute p-1 -m-1 rounded-full hover:scale-110 transition-transform"
                style={commonStyle}>
                {dot}
              </button>
            ) : (
              <span key={p.date} className="absolute" style={commonStyle} aria-label={label}>{dot}</span>
            );
          })}
        </div>

        {/* Pointer/touch tooltip — date · value · Reconstructed. */}
        {hoverPt && (
          <div
            className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full rounded-lg border px-2 py-1 text-[11px] whitespace-nowrap shadow-lg"
            style={{
              left: `${xPct(ts(hoverPt.date))}%`,
              top: `${yPct(sel(hoverPt)) - 3}%`,
              background: "var(--surface-raised, var(--surface-inset))",
              borderColor: "var(--border-hairline-strong)",
            }}
          >
            <span className="text-[var(--text-muted)]">{formatWealthDate(hoverPt.date)}</span>
            <span className="mx-1.5 font-semibold tabular-nums text-[var(--text-primary)]">
              {formatCurrency(sel(hoverPt), currency)}
            </span>
            {hoverPt.isEstimated && <span className="text-[var(--accent-warning)]">Reconstructed</span>}
          </div>
        )}
      </div>

      {/* Legend — honest markers + gap note. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-[var(--text-faint)]">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "var(--accent-info)" }} /> As of</span>
        {result.chart.compareDate && (
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "var(--text-secondary)" }} /> Compare to</span>
        )}
        {compareSeries.length >= 2 && (
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t border-dashed" style={{ borderColor: "var(--text-faint)" }} /> Compare period</span>
        )}
        {pts.some((p) => p.isEstimated) && (
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-dashed" style={{ borderColor: "var(--meridian-400)" }} /> Reconstructed</span>
        )}
        <span>Gaps between points are real — history isn&apos;t interpolated.</span>
      </div>
    </WealthCard>
  );
}
