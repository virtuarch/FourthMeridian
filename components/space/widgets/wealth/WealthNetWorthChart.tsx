"use client";

/**
 * components/space/widgets/wealth/WealthNetWorthChart.tsx
 *
 * Card 2 — "How has my net worth changed?" The dominant historical surface: a
 * net-worth line across the shared range, with the As Of date marked and the
 * Compare To date marked when present. Honesty: points are drawn ONLY at real
 * snapshot dates (no interpolation of missing history), estimated snapshots read
 * as hollow markers, and gaps between snapshots stay visible as time-proportional
 * spans. The range comes from the shared shell; this component holds no time
 * state of its own. Clicking a point sets the shared As Of through the injected
 * callback (no new shell contract).
 */

import { formatCurrency } from "@/lib/format";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable } from "./wealth-ui";

const PAD_X = 4;   // % horizontal padding
const TOP = 10;    // % top padding
const BOT = 88;    // % baseline

function ts(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function WealthNetWorthChart({
  result,
  currency,
  onSelectAsOf,
}: {
  result:        WealthResult;
  currency:      string;
  onSelectAsOf?: (date: string) => void;
}) {
  const pts = result.chart.points;

  const subtitle =
    result.chart.compareDate
      ? `${formatWealthDate(result.chart.asOfDate ?? result.asOf)} vs ${formatWealthDate(result.chart.compareDate)}`
      : result.chart.asOfDate
        ? `As of ${formatWealthDate(result.chart.asOfDate)}`
        : "Net worth over time";

  if (pts.length === 0) {
    return (
      <WealthCard title="How has my net worth changed?" subtitle={subtitle}>
        <WealthUnavailable message="No snapshot history in this range yet. Widen the range or connect accounts to build history." />
      </WealthCard>
    );
  }

  const times = pts.map((p) => ts(p.date));
  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tSpan = tMax - tMin || 1;
  const vals = pts.map((p) => p.netWorth);
  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const vSpan = vMax - vMin || 1;

  const xPct = (t: number) => (pts.length === 1 ? 50 : PAD_X + ((100 - 2 * PAD_X) * (t - tMin)) / tSpan);
  const yPct = (v: number) => BOT - ((BOT - TOP) * (v - vMin)) / vSpan;

  const linePoints = pts.map((p) => `${xPct(ts(p.date)).toFixed(2)},${yPct(p.netWorth).toFixed(2)}`).join(" ");

  const asOfX   = result.chart.asOfDate ? xPct(ts(result.chart.asOfDate)) : null;
  const compareX = result.chart.compareDate ? xPct(ts(result.chart.compareDate)) : null;

  const asOfValue    = result.asOfState.found ? result.asOfState.netWorth : null;
  const compareValue = result.compareState?.found ? result.compareState.netWorth : null;

  return (
    <WealthCard
      title="How has my net worth changed?"
      subtitle={subtitle}
      right={
        <div className="flex flex-col items-end gap-0.5 text-right">
          {asOfValue !== null && (
            <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{formatCurrency(asOfValue, currency)}</span>
          )}
          {compareValue !== null && (
            <span className="text-[11px] tabular-nums text-[var(--text-faint)]">
              was {formatCurrency(compareValue, currency)}
            </span>
          )}
        </div>
      }
    >
      <div className="relative w-full" style={{ height: 220 }}>
        {/* Line + markers (geometry scales to fill; strokes stay crisp). */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {compareX !== null && (
            <line x1={compareX} x2={compareX} y1={TOP - 2} y2={BOT + 2} stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          {asOfX !== null && (
            <line x1={asOfX} x2={asOfX} y1={TOP - 2} y2={BOT + 2} stroke="var(--accent-info)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          <polyline points={linePoints} fill="none" stroke="var(--accent-positive)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* Clickable snapshot dots (round, not distorted by the stretch). */}
        <div className="absolute inset-0">
          {pts.map((p) => {
            const left = xPct(ts(p.date));
            const top = yPct(p.netWorth);
            const isAsOf = p.date === result.chart.asOfDate;
            const isCompare = p.date === result.chart.compareDate;
            const dot = (
              <span
                className="block rounded-full"
                style={{
                  width: isAsOf ? 11 : 7,
                  height: isAsOf ? 11 : 7,
                  background: p.isEstimated ? "transparent" : isAsOf ? "var(--accent-info)" : isCompare ? "var(--text-secondary)" : "var(--accent-positive)",
                  border: p.isEstimated
                    ? "1.5px dashed var(--accent-positive)"
                    : isAsOf ? "2px solid var(--surface-inset)" : "none",
                  boxShadow: isAsOf ? "0 0 0 2px var(--accent-info)" : "none",
                }}
              />
            );
            const commonStyle: React.CSSProperties = { left: `${left}%`, top: `${top}%`, transform: "translate(-50%, -50%)" };
            const title = `${formatWealthDate(p.date)} · ${formatCurrency(p.netWorth, currency)}${p.isEstimated ? " · reconstructed" : ""}`;
            return onSelectAsOf ? (
              <button
                key={p.date}
                type="button"
                onClick={() => onSelectAsOf(p.date)}
                title={`Set As Of to ${title}`}
                aria-label={`Set As Of to ${title}`}
                className="absolute p-1 -m-1 rounded-full hover:scale-110 transition-transform"
                style={commonStyle}
              >
                {dot}
              </button>
            ) : (
              <span key={p.date} className="absolute" style={commonStyle} title={title}>{dot}</span>
            );
          })}
        </div>
      </div>

      {/* Legend — honest markers + gap note. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-[var(--text-faint)]">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "var(--accent-info)" }} /> As of</span>
        {result.chart.compareDate && (
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "var(--text-secondary)" }} /> Compare to</span>
        )}
        {pts.some((p) => p.isEstimated) && (
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-dashed" style={{ borderColor: "var(--accent-positive)" }} /> Reconstructed</span>
        )}
        <span>Gaps between points are real — history isn&apos;t interpolated.</span>
      </div>
    </WealthCard>
  );
}
