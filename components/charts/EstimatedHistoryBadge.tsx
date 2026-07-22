/**
 * components/charts/EstimatedHistoryBadge.tsx
 *
 * D2.x Slice 4 — small, honest label shown on a chart whose series contains
 * reconstructed/backfilled points (SpaceSnapshot.isEstimated). Keeps the
 * codebase's "never present an estimate as fact" contract: cash is real
 * (reconstructed from transactions) but investments/loans/manual assets are
 * held flat, so the historical curve is partly estimated.
 *
 * MC1 Phase 4 Slice 4 — the same badge now also covers currency-display
 * estimation: points stamped in a different reporting currency are converted
 * at each snapshot's own date on the read path (lib/data/snapshots.ts) and
 * join this badge via the same per-point flag. One badge, both causes.
 *
 * Presentational only; reuses existing tokens, no new material.
 */

import { Info } from "lucide-react";

export function EstimatedHistoryBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]"
      title="Estimated history — some points are reconstructed (cash walked back from transactions; other assets held flat) or converted from a different reporting currency at that day's exchange rate."
    >
      <Info size={11} className="shrink-0 opacity-70" />
      Estimated history
    </span>
  );
}
