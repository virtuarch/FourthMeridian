/**
 * lib/debt/display-conversion.ts
 *
 * Per-date display-currency conversion of the Debt Balance-Over-Time slice — the
 * Debt analogue of `convertWealthSnapshots` (SD-5). It closes the LAST symbol-only
 * relabel in the Perspective workspaces: `DebtSpaceData.history` carries snapshot
 * (reporting)-currency totals, but the Balance-history presenter (now DebtBalanceHistory,
 * the shared TrendChart) formats them with the selected DISPLAY symbol. Without this pass,
 * a non-USD display showed reporting magnitudes under a display symbol (e.g. USD 10,000
 * rendered "€10,000") — sitting right beside figures that DO convert via `ctx`. This
 * converts each point at ITS OWN date
 * through the ONE canonical money authority (`convertMoney` / `ConversionContext`,
 * lib/money) so the chart reads CONVERTED magnitudes, matching the KPIs beside it.
 *
 * Series semantics mirror the Wealth net-worth chart (this is a plotted series, not a
 * pair of single endpoints like Liquidity): a rate miss / walk-back on a date would
 * make that point mixed-unit relative to the converted series, so it is DROPPED — the
 * exact fxMiss-drop guard `convertWealthSnapshots` applies. A shorter honest trend
 * beats a silently mixed-magnitude one; we never fabricate a rate (`convertMoney`
 * owns the lookup) and never blend a native magnitude into a converted series.
 *
 * IDENTITY: when the display target already IS the slice's currency (the common case —
 * display defaults to the Space reporting currency), the transform returns the slice
 * unchanged (byte-identical, no rate lookups). PURE: no DB, no clock, no network.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { DebtHistorySlice } from "@/lib/debt-space-data";

/**
 * Convert a reporting-currency Debt history slice into `ctx.target`, per-date.
 * Identity when the target already is the slice currency, or when `ctx` is absent
 * (the kill-switch path — no conversion, no relabel change). Pure.
 */
export function convertDebtHistory(
  slice: DebtHistorySlice | null,
  ctx?: ConversionContext,
): DebtHistorySlice | null {
  if (!slice) return null;
  // Identity fast path — no conversion, no rate lookups (all-single-currency path).
  if (!ctx || ctx.target === slice.currency) return slice;

  const from = slice.currency;
  const points = slice.points.flatMap((p) => {
    const c = convertMoney({ amount: p.totalDebt, currency: from }, p.date, ctx);
    // Estimated (rate walked back) or UNAVAILABLE (no rate ⇒ amount null) ⇒
    // mixed-unit relative to the converted series; drop the point (Wealth's
    // fxMiss-drop semantics) rather than blend a native magnitude or a fake 0.
    if (c.amount === null || c.estimated) return [];
    return [{ ...p, totalDebt: c.amount }];
  });
  return { ...slice, points, currency: ctx.target };
}
