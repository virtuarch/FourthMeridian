"use client";

/**
 * components/space/widgets/debt/DebtHistoryPanel.tsx
 *
 * S3 — the Balance Over Time presenter (plan §2, §3.3). SD-6A rewired it onto the
 * canonical DebtSpaceData contract: it now renders the ALREADY-CLIPPED
 * `DebtHistorySlice` (lib/debt-space-data.ts) instead of the raw host `Snapshot[]`.
 * The window clip to [compareTo ?? start, asOf], the `fxMiss` drop, and the
 * chronological sort all happen ONCE in the pure `assembleDebtSpaceData` — this
 * presenter no longer owns any of that logic. It only:
 *   - dims `isEstimated` (backfilled) points and discloses them in a single note
 *     (plan §1.5 — the flat-hold is a pre-existing condition, carried honestly);
 *   - shows the headline current figure + signed delta since the window start.
 *
 * The series totals are pre-stamped in the SNAPSHOT currency (slice.currency — the
 * Space reporting currency), a DISTINCT axis from the KPI/display currency. Labels
 * reuse the existing ConversionContext formatting exactly as before (no new FX
 * path, no reconversion of pre-stamped historical totals — DEC-safe).
 */

import { CreditCard } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { DebtHistorySlice } from "@/lib/debt-space-data";

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

export function DebtHistoryPanel({
  history,
  loading,
  ctx,
}: {
  /** The window-clipped Balance-Over-Time slice (assembleDebtSpaceData). null ⇒ no usable in-window history. */
  history: DebtHistorySlice | null;
  /** True while the as-of lens fetch is in flight before the first result. */
  loading?: boolean;
  ctx?: ConversionContext;
}) {
  // Points are already clipped to [compareTo ?? start, asOf], fxMiss-dropped, and
  // sorted ascending by the pure contract — no further filtering here.
  const points = history?.points ?? [];

  if (loading && points.length === 0) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading history…</p>;
  }

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
