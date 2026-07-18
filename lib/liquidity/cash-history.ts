/**
 * lib/liquidity/cash-history.ts
 *
 * The Liquidity Balance-History series — "how much money could I reach right now,
 * over time?" It is the cash analogue of the Debt Balance-Over-Time slice
 * (lib/debt-space-data.ts clipDebtHistory + lib/debt/display-conversion.ts): a
 * window-clipped, per-date FX-converted projection of the SAME Snapshot rows every
 * other workspace history reads, carrying NO new valuation authority.
 *
 * The series value is the `cashNow` tier — `Snapshot.totalCash` (checking) +
 * `Snapshot.totalSavings` (savings). This is EXACTLY computeLiquidity's `cashNow`
 * (CASH_TYPES = {checking, savings}, lib/perspective-engine/lenses/liquidity.core.ts)
 * and the Hero's present-day figure of record (classifyAccounts.totalLiquid), so the
 * curve, the Ladder's "Available now" endpoint, and the headline share one basis. The
 * snapshot cash walk-back and the as-of Ladder endpoint (getAccountsAsOf) reconstruct
 * from the SAME posted-only anchor (lib/snapshots/reconstruction-basis.test.ts), so
 * this plotted series is basis-consistent with the reconstructed Ladder above it.
 *
 * PURE — no DB, no clock, no network. Presentation-scoped (this is not the
 * LensResult-composition contract, which is space-data-core.ts): the cashNow series
 * is derived from snapshots, not from a lens endpoint, so it lives on its own.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

/** One clipped point — the cashNow (checking + savings) projection of a Snapshot. */
export interface CashHistoryPoint {
  date: string;
  /** totalCash (checking) + totalSavings (savings) — the "Available now" tier. */
  cashNow: number;
  /** True for a reconstructed/backfilled row (Snapshot.isEstimated). */
  isEstimated: boolean;
}

/** The window-clipped Balance-History slice for accessible cash. */
export interface CashHistorySlice {
  /** Points clipped to [compareTo ?? earliest, asOf], fxMiss dropped, ascending. */
  points: CashHistoryPoint[];
  /** The snapshot currency basis — NOT necessarily the display currency (a display
   *  switch reconverts current figures but historical totals are pre-stamped). Kept
   *  explicit so no consumer pretends one currency spans both axes. */
  currency: string;
  /** The applied lower bound (compareTo), or null for "full history up to asOf". */
  windowStart: string | null;
  /** The applied upper bound (asOf). */
  windowAsOf: string;
}

/**
 * Clip a Snapshot series to the cashNow history window. PURE: keeps rows whose
 * totalCash + totalSavings are numeric with fxMiss dropped (invariant 8 — mixed-
 * magnitude points never plotted), inside [compareTo ?? −∞, asOf], sorted ascending,
 * projected to the cashNow point shape. Returns null when nothing survives (the
 * workspace applies its own "not enough history yet" presentation gate on top).
 */
export function clipCashHistory(
  snapshots: Snapshot[],
  asOf: string,
  compareTo: string | null,
  currency: string,
): CashHistorySlice | null {
  const points: CashHistoryPoint[] = snapshots
    .filter((s) => typeof s.totalCash === "number" && typeof s.totalSavings === "number" && s.fxMiss !== true)
    .filter((s) => s.date <= asOf && (compareTo === null || s.date >= compareTo))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((s) => ({ date: s.date, cashNow: s.totalCash + s.totalSavings, isEstimated: s.isEstimated === true }));

  if (points.length === 0) return null;
  return { points, currency, windowStart: compareTo, windowAsOf: asOf };
}

/**
 * Convert a reporting-currency cashNow history slice into `ctx.target`, per-date.
 * Identity when the target already is the slice currency, or when `ctx` is absent
 * (the kill-switch path — no conversion, no relabel). A rate miss on a date makes
 * that point mixed-unit relative to the converted series, so it is DROPPED (the
 * Wealth/Debt fxMiss-drop semantics for a plotted series) rather than blended in.
 * PURE — mirrors convertDebtHistory exactly.
 */
export function convertCashHistory(
  slice: CashHistorySlice | null,
  ctx?: ConversionContext,
): CashHistorySlice | null {
  if (!slice) return null;
  if (!ctx || ctx.target === slice.currency) return slice;

  const from = slice.currency;
  const points = slice.points.flatMap((p) => {
    const c = convertMoney({ amount: p.cashNow, currency: from }, p.date, ctx);
    if (c.estimated) return [];
    return [{ ...p, cashNow: c.amount }];
  });
  return { ...slice, points, currency: ctx.target };
}
