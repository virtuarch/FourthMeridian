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
import { changeComparability, markPartialBalanceCoverage, type BalanceCoverageRead } from "@/lib/connections/balance-coverage.core";
import { formatDate } from "@/lib/format";

export function debtTrendPoints(history: DebtHistorySlice | null, balanceCoverage: BalanceCoverageRead): TrendPoint[] {
  return markPartialBalanceCoverage(
    (history?.points ?? []).map((p): TrendPoint => ({ date: p.date, value: p.totalDebt, estimated: p.isEstimated })),
    balanceCoverage,
    ["liability"],
  );
}

/** The balance-history window delta, ready for the badge (snapshot basis). */
export interface DebtWindowChange {
  /** last − first over the in-window snapshot series (positive = debt grew). */
  abs: number;
  /** % of the opening balance, or null when the opening is 0/unknown. */
  pct: number | null;
  /** The window's opening date (formatted), for the "vs {date}" label. */
  fromLabel: string;
  /** PB-8b — an endpoint includes a held-flat liability (no history): the change is labelled estimated. */
  estimated?: boolean;
}

/**
 * PB-8b — the hero's balance-history WINDOW change (last − first over the
 * in-window snapshot series), or the reason it is withheld. Never measured
 * across the coverage floor: when the opening day is before a liability's
 * balance-history floor the debts missing from it would read as paid off, so
 * the change is withheld with the PB-8 wording instead of a meaningless
 * "↑ $316k · 2553.8%". A held-flat (estimated) endpoint keeps the change,
 * labelled estimated. Only real when ≥2 in-window points exist; never invented.
 */
export function debtWindowChange(
  history: DebtHistorySlice | null,
  balanceCoverage: BalanceCoverageRead,
): { change: DebtWindowChange | null; withheld: string | null } {
  const pts = history?.points ?? [];
  if (pts.length < 2) return { change: null, withheld: null };
  const first = pts[0];
  const last = pts[pts.length - 1];
  const gate = changeComparability(balanceCoverage, ["liability"], {
    fromISO: first.date, toISO: last.date, fromEstimated: first.isEstimated, toEstimated: last.isEstimated,
  });
  if (gate.state === "withheld") return { change: null, withheld: gate.message };
  const abs = last.totalDebt - first.totalDebt;
  const pct = first.totalDebt !== 0 ? (abs / first.totalDebt) * 100 : null;
  return {
    change: { abs, pct, fromLabel: formatDate(first.date), ...(gate.state === "estimated" ? { estimated: true } : {}) },
    withheld: null,
  };
}
