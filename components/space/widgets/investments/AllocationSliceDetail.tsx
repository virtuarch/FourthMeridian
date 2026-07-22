"use client";

/**
 * components/space/widgets/investments/AllocationSliceDetail.tsx
 *
 * The INSPECT body behind an Allocation segment (UX-CLOSE-3), shown in a
 * RightPanel — "what positions make up this slice?".
 *
 * Role, not content, decides the edge: this renders a list, but the question is
 * "what produced this number", so it docks right like every other detail panel.
 *
 * SPINE UNTOUCHED. Rows come from `holdingsInSlice`, which selects through the
 * same `ALLOCATION_KEY_OF` functions `computeAllocation` reduces through — so
 * these rows sum to the segment's value by construction. No valuation, FX,
 * historical, or aggregation arithmetic is performed here; every figure is the
 * canonical per-holding `reportingValue` the valuation service already produced.
 * Deliberately NO price history and NO per-asset chart: that is the v2.6 asset
 * explorer, not this slice.
 *
 * Honesty: unvalued positions cannot appear, because they contribute to no
 * slice. The panel says so rather than letting the list imply completeness.
 */

import { formatCurrency } from "@/lib/format";
import { Surface } from "@/components/atlas/Surface";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { rowKey, rowLabel, tierDotColor } from "./holdings-util";

export function AllocationSliceDetail({
  rows,
  sliceValue,
  valuedTotal,
  reportingCurrency,
  accountName,
  showAccount,
}: {
  rows:              ValuedHoldingRow[];
  sliceValue:        number;
  valuedTotal:       number;
  reportingCurrency: string;
  /** accountId → display name, for the per-row account line. */
  accountName:       (id: string) => string;
  /** Hidden on the by-account axis, where every row shares one account. */
  showAccount:       boolean;
}) {
  const share = valuedTotal > 0 ? (sliceValue / valuedTotal) * 100 : 0;

  return (
    <div className="space-y-3">
      <Surface className="px-4 py-3">
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">Value</span>
          <span className="text-sm tabular-nums text-[var(--text-primary)]">
            {formatCurrency(sliceValue, reportingCurrency)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">Share of valued holdings</span>
          <span className="text-sm tabular-nums text-[var(--text-primary)]">{share.toFixed(1)}%</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">Positions</span>
          <span className="text-sm tabular-nums text-[var(--text-primary)]">
            {rows.length} {rows.length === 1 ? "position" : "positions"}
          </span>
        </div>
      </Surface>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-hairline)]">
        {rows.map((row, i) => {
          const value = row.reportingValue as number;
          const label = rowLabel(row);
          const secondary = row.symbol && row.name ? row.name : null;
          return (
            <div
              key={rowKey(row)}
              className={`flex items-center gap-3 px-4 py-3 ${
                i > 0 ? "border-t border-[var(--border-hairline)]" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--text-primary)]">
                  {label}
                  {row.overallTier !== "observed" && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: tierDotColor(row.overallTier) }}
                      aria-hidden
                    />
                  )}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                  {secondary && <span>{secondary} · </span>}
                  <span className="tabular-nums">{row.quantity ?? "—"}</span> units
                  {showAccount && <span> · {accountName(row.accountId)}</span>}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="tabular-nums text-sm text-[var(--text-primary)]">
                  {formatCurrency(value, reportingCurrency)}
                </p>
                <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">
                  {sliceValue > 0 ? ((value / sliceValue) * 100).toFixed(0) : "0"}% of slice
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
        Positions that couldn&apos;t be valued contribute to no slice and are not
        listed here.
      </p>
    </div>
  );
}
