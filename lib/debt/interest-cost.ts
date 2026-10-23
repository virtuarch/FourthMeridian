/**
 * lib/debt/interest-cost.ts
 *
 * THE estimated-monthly-interest authority: "what does carrying this balance
 * cost a month?"
 *
 * Pure: no React, no DB, no FX. Rows arrive already converted into one currency
 * and already visibility-filtered (the same contract as `lib/debt/aggregates`).
 *
 * `owed × apr/100/12` was written out at three sites (the Interest Cost widget,
 * the Liabilities ledger row, the debt KPIs) that agreed by coincidence. One of
 * them filtered `apr > 0` and so reported a 0% promotional card as "missing an
 * APR". Stated once, here:
 *
 *   - the estimate is the MEAN-MONTH figure (APR/12) — a run-rate, deliberately
 *     not the ACT/365 accrual `lib/debt/payoff.ts` uses for a dated schedule;
 *   - a rate of exactly 0 is KNOWN: it costs 0.00 and is not "missing";
 *   - `null` is UNKNOWN: the row has NO interest figure (never 0), is excluded
 *     from the total, and is counted so a surface can say the total is partial;
 *   - a row that owes nothing accrues nothing and is not reported as unknown.
 */

import { amountOwed } from "@/lib/debt/balance-semantics";

/** Estimated interest for one month on one balance, or null when the rate is unknown. */
export function estimatedMonthlyInterest(balance: number, aprPct: number | null | undefined): number | null {
  if (aprPct == null) return null;
  return amountOwed(balance) * (aprPct / 100) / 12;
}

export interface InterestCostInput {
  id:      string;
  /** Signed balance in ONE currency. Normalised via `amountOwed`. */
  balance: number;
  /** Effective APR percent, or null/undefined when not on file. */
  aprPct:  number | null | undefined;
}

export interface InterestCostRow {
  id:      string;
  owed:    number;
  /** null = UNKNOWN. */
  aprPct:  number | null;
  /** null when the rate is unknown — never 0 for an unknown rate. */
  monthly: number | null;
}

export interface InterestCost {
  /** Every row that OWES something — rated or not — costliest first, unknowns last. */
  rows:         InterestCostRow[];
  /** Σ monthly over rows with a KNOWN rate. */
  totalMonthly: number;
  /** Owing rows with no rate on file (excluded from `totalMonthly`). */
  unknownCount: number;
}

export function computeInterestCost(inputs: readonly InterestCostInput[]): InterestCost {
  const rows: InterestCostRow[] = [];
  for (const i of inputs) {
    const owed = amountOwed(i.balance);
    if (!(owed > 0)) continue;
    const aprPct = i.aprPct ?? null;
    rows.push({ id: i.id, owed, aprPct, monthly: estimatedMonthlyInterest(owed, aprPct) });
  }
  rows.sort((a, b) => {
    if (a.monthly === null || b.monthly === null) {
      if (a.monthly === b.monthly) return b.owed - a.owed;
      return a.monthly === null ? 1 : -1;
    }
    return b.monthly - a.monthly || b.owed - a.owed;
  });
  return {
    rows,
    totalMonthly: rows.reduce((s, r) => s + (r.monthly ?? 0), 0),
    unknownCount: rows.filter((r) => r.monthly === null).length,
  };
}
