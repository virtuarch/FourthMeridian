/**
 * components/space/widgets/debt/debt-trend-points.ts  (PB-8)
 *
 * The PURE projection DebtHistorySlice → TrendChart points for Debt Balance
 * History: totalDebt is the value, a backfilled row is reconstructed, and — PB-8,
 * owner ruling 2026-10-30 — a day before a liability's balance-history floor is
 * marked PARTIAL (the existing `unreliable` basis + coverage line), never left to
 * read as a complete total that silently counts the missing debt as $0 owed.
 * Values are never changed.
 */

import type { DebtHistorySlice } from "@/lib/debt-space-data";
import type { TrendPoint } from "@/components/space/widgets/charts/TrendChart";
import { markPartialBalanceCoverage, type BalanceCoverage } from "@/lib/connections/balance-coverage.core";

export function debtTrendPoints(history: DebtHistorySlice | null, balanceCoverage: BalanceCoverage | null): TrendPoint[] {
  return markPartialBalanceCoverage(
    (history?.points ?? []).map((p): TrendPoint => ({ date: p.date, value: p.totalDebt, estimated: p.isEstimated })),
    balanceCoverage,
    ["liability"],
  );
}
