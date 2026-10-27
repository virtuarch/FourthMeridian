/**
 * components/space/widgets/cashflow/spending-distribution.ts  (v2.7 — Spending donut)
 *
 * The Spending page's distribution donut, as a PURE model over figures the
 * composition contract already computed (buildCashFlowSpaceData):
 *
 *   categories — data.outflowByCategory: each category's NET spending (refunds
 *                absorbed by their own category; a category netting ≤ 0 is already
 *                dropped by rankCategorySpend, so the ring never draws a negative
 *                or zero slice — the ledger beneath still lists what it lists);
 *   spending   — data.spending: `net` is THE Total spending (economicSpend), and
 *                `refundsUnapplied` is the refunds no listed category could absorb.
 *
 * RECONCILIATION (owner rule). Σ slices − refundsUnapplied = Total spending. So:
 *   • refundsUnapplied = 0 ⇒ the slices sum EXACTLY to Total spending; the centre
 *     shows Total spending and every slice % is a share of it;
 *   • refundsUnapplied > 0 ⇒ the ring must NOT claim to sum to the total: its centre
 *     shows what the slices sum to ("Category spending") and the adjustment line
 *     states the gap — "Less refunds with no matching purchase −X = Total spending Y".
 * Comparisons are made in whole cents (no float drift can flip the branch).
 *
 * No calculation authority lives here — it selects and labels contract figures.
 */

import { assignStableColors } from "@/lib/charts/chart-palette";
import type { CashFlowContribution } from "@/lib/transactions/cash-flow";
import type { CashFlowSpending } from "@/lib/transactions/cash-flow-space-data";

export interface SpendingSlice { id: string; label: string; value: number; color: string }

export interface SpendingDonutModel {
  slices:      SpendingSlice[];
  /** The ring's centre figure — Total spending when the slices reconcile, else Σ slices. */
  centerValue: number;
  centerLabel: string;
  /** Σ slices === Total spending (to the cent). */
  reconciles:  boolean;
  /** THE Total spending (data.spending.net). */
  total:       number;
  /** Refunds no category absorbed (0 when none) — stated beside the ring when > 0. */
  adjustment:  number;
}

const cents = (v: number) => Math.round(v * 100);

export function spendingDonutModel(categories: readonly CashFlowContribution[], spending: CashFlowSpending): SpendingDonutModel {
  const positive = categories.filter((c) => cents(c.value) > 0);
  const colors = assignStableColors(positive.map((c) => c.id));
  const slices = positive.map((c, i) => ({ id: c.id, label: c.label, value: c.value, color: colors[i] }));
  const sum = slices.reduce((s, x) => s + x.value, 0);
  const reconciles = cents(sum) === cents(spending.net);
  const adjustment = cents(spending.refundsUnapplied) > 0 ? spending.refundsUnapplied : 0;
  return {
    slices,
    centerValue: reconciles ? spending.net : sum,
    centerLabel: reconciles ? "Total spending" : "Category spending",
    reconciles,
    total: spending.net,
    adjustment,
  };
}

/** Each slice's share of the centre figure, in percent (what the ring draws). */
export function sliceShares(model: SpendingDonutModel): { id: string; pct: number }[] {
  const base = model.slices.reduce((s, x) => s + x.value, 0);
  return model.slices.map((s) => ({ id: s.id, pct: base > 0 ? (s.value / base) * 100 : 0 }));
}
