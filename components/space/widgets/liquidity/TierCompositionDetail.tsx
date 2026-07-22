"use client";

/**
 * components/space/widgets/liquidity/TierCompositionDetail.tsx
 *
 * The INSPECT body behind a LADDER TIER selection (UX-CLOSE-3) — "what makes up
 * my Available now?". Shown in a RightPanel, the same role every other detail
 * panel plays.
 *
 * This is the ledger's second interrogable level: a ROW answers "what is this
 * account", a TIER answers "what is this horizon composed of". The main ledger
 * shows only the most important sources, so the tier panel is also where the
 * complete membership of a horizon becomes visible.
 *
 * NO new partitioning. Rows are the SAME `LiquiditySourceRow[]` the ledger
 * already built (one FX pass, horizon assigned by the canonical account-type
 * rule), filtered to this horizon — so a tier's total is exactly the sum of the
 * rows shown, and it agrees with the ladder metrics upstream.
 *
 * PRESENT-DAY ONLY, by contract: per-account historical rows are not carried by
 * LiquiditySpaceData, so this surface exists only on the present-day branch. The
 * historical branch renders tier totals and says so instead of offering a drill
 * that cannot be honoured.
 */

import { formatCurrency } from "@/lib/format";
import { Surface } from "@/components/atlas/Surface";
import {
  HORIZON_META, HORIZON_COLOR,
  type SourceHorizon, type LiquiditySourceRow,
} from "./liquidity-sources-util";

export function TierCompositionDetail({
  horizon,
  rows,
  totalAssets,
  currency,
}: {
  horizon:     SourceHorizon;
  rows:        LiquiditySourceRow[];
  /** Denominator for share-of-assets, the same base the row bars use. */
  totalAssets: number;
  currency:    string;
}) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const share = totalAssets > 0 ? (total / totalAssets) * 100 : 0;
  const anyEstimated = rows.some((r) => r.estimated);

  return (
    <div className="space-y-3">
      <Surface className="px-4 py-3">
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">Reachable here</span>
          <span className="text-sm tabular-nums text-[var(--text-primary)]">
            {anyEstimated ? "≈ " : ""}{formatCurrency(total, currency)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">Share of assets</span>
          <span className="text-sm tabular-nums text-[var(--text-primary)]">{share.toFixed(1)}%</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">Sources</span>
          <span className="text-sm tabular-nums text-[var(--text-primary)]">
            {rows.length} {rows.length === 1 ? "account" : "accounts"}
          </span>
        </div>
        <p className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: HORIZON_COLOR[horizon] }} />
          {HORIZON_META[horizon]}
        </p>
      </Surface>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-hairline)]">
        {rows.map((r, i) => (
          <div
            key={r.account.id}
            className={`flex items-center gap-3 px-4 py-3 ${
              i > 0 ? "border-t border-[var(--border-hairline)]" : ""
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{r.account.name}</p>
              {r.account.institution && (
                <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{r.account.institution}</p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p className="tabular-nums text-sm text-[var(--text-primary)]">
                {r.estimated ? "≈ " : ""}{formatCurrency(r.value, currency)}
              </p>
              <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">
                {total > 0 ? ((r.value / total) * 100).toFixed(0) : "0"}% of tier
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
        Reachability is derived from account type — the schema carries no
        settlement or lock-up terms, so no penalty tier is inferred.
      </p>
    </div>
  );
}
