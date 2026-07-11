"use client";

/**
 * components/space/widgets/wealth/WealthKpiStrip.tsx
 *
 * Section A — the compact four-card Wealth KPI strip. Each card shows the
 * selected-date value (As Of), the delta vs Compare To when a comparison exists,
 * the percentage where valid, and a compact sparkline only when real historical
 * points exist. Before-coverage As Of renders an honest incomplete value.
 * Point-in-time only — the shared range never touches these cards.
 */

import { formatCurrency } from "@/lib/format";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { DeltaBadge, Sparkline } from "./wealth-ui";

type MetricKey = "netWorth" | "totalAssets" | "totalLiabilities" | "liquidNetWorth";

const CARDS: { key: MetricKey; label: string; good: "up" | "down" }[] = [
  { key: "netWorth",         label: "Net Worth",       good: "up" },
  { key: "totalAssets",      label: "Total Assets",    good: "up" },
  { key: "totalLiabilities", label: "Total Liabilities", good: "down" },
  { key: "liquidNetWorth",   label: "Liquid Net Worth", good: "up" },
];

export function WealthKpiStrip({
  result,
  currency,
  compareLabel,
}: {
  result:        WealthResult;
  currency:      string;
  compareLabel?: string;
}) {
  const { asOfState, deltas, chart } = result;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {CARDS.map(({ key, label, good }) => {
        const value = asOfState[key];
        const d = deltas ? deltas[key] : null;
        const series = chart.points.map((p) => p[key]);
        return (
          <div
            key={key}
            className="rounded-2xl border p-3 sm:p-4 flex flex-col gap-1.5 min-w-0"
            style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-[11px] font-medium text-[var(--text-muted)] truncate">{label}</span>
              {asOfState.found && <Sparkline values={series} goodDirection={good} />}
            </div>
            {asOfState.found ? (
              <>
                <span className="text-xl sm:text-2xl font-semibold tabular-nums text-[var(--text-primary)] leading-tight">
                  {formatCurrency(value, currency)}
                </span>
                {d ? (
                  <DeltaBadge abs={d.abs} pct={d.pct} currency={currency} goodDirection={good} compareLabel={compareLabel} />
                ) : (
                  <span className="text-[11px] text-[var(--text-faint)]">&nbsp;</span>
                )}
              </>
            ) : (
              <>
                <span className="text-xl sm:text-2xl font-semibold tabular-nums text-[var(--text-faint)] leading-tight">—</span>
                <span className="text-[11px] text-[var(--text-faint)]">No history for this date</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
