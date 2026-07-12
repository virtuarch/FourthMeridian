"use client";

/**
 * components/space/widgets/debt/DebtHistoryPanel.tsx
 *
 * S3 — the Balance Over Time presenter (plan §2, §3.3). A honest upgrade of the
 * generic-path renderDebtHistory over the SAME host `Snapshot[]` array:
 *   - full snapshot depth (lifts the generic renderer's 24-point cap);
 *   - `fxMiss` points dropped (the hero-chart guard — those sit at a native,
 *     unconverted magnitude and would distort the ramp; types/index.ts:95–100);
 *   - `isEstimated` (backfilled) points DIMMED and disclosed in a single
 *     estimated-segment note, never labelled as reconstructed loan truth
 *     (plan §1.5 — the flat-hold is a pre-existing condition, carried honestly);
 *   - headline current figure + signed delta since the series start.
 *
 * This is a SNAPSHOT read (SpaceSnapshot.totalDebt), NOT an as-of account read —
 * the one sanctioned history source in this current-state-only workspace
 * (plan §1.5, stop condition 1). The registry `renderDebtHistory` stays the
 * generic-path renderer, untouched (the LiquidityLadderTiers precedent).
 */

import { CreditCard } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

export function DebtHistoryPanel({
  snapshots,
  ctx,
}: {
  snapshots: Snapshot[] | null | undefined;
  ctx?: ConversionContext;
}) {
  if (snapshots == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading history…</p>;
  }

  // Full series (no 24-point cap), fxMiss points dropped, chronological.
  const points = snapshots
    .filter((s) => typeof s.totalDebt === "number" && s.fxMiss !== true)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  if (points.length < 2 || points.every((p) => p.totalDebt === 0)) {
    return (
      <div className="text-center py-8">
        <CreditCard size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">Not enough history yet</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Total debt over time appears as daily snapshots accumulate.</p>
      </div>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.totalDebt));
  const current = points[points.length - 1].totalDebt;
  const first = points[0].totalDebt;
  const delta = current - first;
  const estimatedCount = points.filter((p) => p.isEstimated === true).length;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-2xl font-semibold text-[var(--accent-negative)] tabular-nums">{fmtMoney(current, ctx)}</p>
          <p className="text-[11px] text-[var(--text-muted)]">total debt now</p>
        </div>
        <p className={`text-xs font-medium tabular-nums ${delta <= 0 ? "text-[var(--accent-positive)]" : "text-[var(--accent-negative)]"}`}>
          {delta <= 0 ? "−" : "+"}{fmtMoney(Math.abs(delta), ctx)} over {points.length} snapshots
        </p>
      </div>

      <div className="flex items-end gap-0.5 h-24">
        {points.map((p, i) => {
          const ratio = p.totalDebt / max;
          const est = p.isEstimated === true;
          return (
            <div
              key={`${p.date}-${i}`}
              className="flex-1 rounded-t-sm"
              style={{
                height:          `${Math.max(2, ratio * 100)}%`,
                backgroundColor: "var(--accent-negative)",
                // Estimated (backfilled) points sit dimmer than observed ones so
                // the reconstructed segment reads as softer, not asserted.
                opacity:         est ? 0.22 : 0.4 + 0.6 * ratio,
              }}
              title={`${p.date}: ${fmtMoney(p.totalDebt, ctx)}${est ? " (estimated)" : ""}`}
            />
          );
        })}
      </div>

      {estimatedCount > 0 && (
        <p className="text-[10px] text-[var(--text-faint)]">
          {estimatedCount} earlier {estimatedCount === 1 ? "point is" : "points are"} estimated — backfilled history holds non-card loan balances flat.
        </p>
      )}
    </div>
  );
}
