/**
 * components/charts/EstimatedHistoryBadge.tsx
 *
 * D2.x Slice 4 — small, honest label shown on a chart whose series contains
 * reconstructed/backfilled points (SpaceSnapshot.isEstimated). Keeps the
 * codebase's "never present an estimate as fact" contract: cash is real
 * (reconstructed from transactions) but investments/loans/manual assets are
 * held flat, so the historical curve is partly estimated.
 *
 * Presentational only; reuses existing tokens, no new material.
 */

import { Info } from "lucide-react";

export function EstimatedHistoryBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]"
      title="Estimated history — cash reconstructed from transactions; investments and other assets held flat."
    >
      <Info size={11} className="shrink-0 opacity-70" />
      Estimated history
    </span>
  );
}
