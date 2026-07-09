/**
 * lib/accounts/credit-utilization.ts
 *
 * Pure credit-utilization math for the Debt Perspective (UX-PER-3).
 *
 * Utilization = balance / creditLimit, expressed as a percentage:
 *   0.35 → 35% (NOT 3500%).
 * The bar width is clamped to 0–100% for display, but the reported `pct` keeps
 * the true value (which can exceed 100% when over-limit). Colour is by LEVEL,
 * not rank — low utilization is never red.
 *
 * Currency-agnostic: a balance/limit ratio is unitless (both native to the same
 * account), so no ConversionContext is needed here.
 */

export interface UtilizationInputAccount {
  id:           string;
  name:         string;
  type:         string;
  balance:      number;
  creditLimit?: number | null;
}

export type UtilizationLevel = "low" | "moderate" | "high" | "over";

export interface UtilizationRow {
  id:      string;
  name:    string;
  balance: number;
  limit:   number;
  pct:     number;   // true utilization %, may exceed 100
  barPct:  number;   // clamped 0–100 for bar width
  level:   UtilizationLevel;
}

/** Level thresholds (utilization %): <30 low, 30–70 moderate, 70–100 high, >100 over. */
export function utilizationLevel(pct: number): UtilizationLevel {
  if (pct > 100) return "over";
  if (pct >= 70) return "high";
  if (pct >= 30) return "moderate";
  return "low";
}

export interface CreditUtilizationResult {
  /** Revolving debts (have a positive credit limit), highest utilization first. */
  rows:         UtilizationRow[];
  /** Debt accounts WITHOUT a usable credit limit — surfaced for an "add limit" affordance. */
  missingLimit: { id: string; name: string }[];
}

export function creditUtilization(accounts: UtilizationInputAccount[]): CreditUtilizationResult {
  const debts = accounts.filter((a) => a.type === "debt");

  const rows: UtilizationRow[] = debts
    .filter((a) => a.creditLimit != null && a.creditLimit > 0)
    .map((a) => {
      const limit = a.creditLimit as number;
      const pct = (Math.max(0, a.balance) / limit) * 100;
      return {
        id:      a.id,
        name:    a.name,
        balance: a.balance,
        limit,
        pct,
        barPct:  Math.min(100, Math.max(0, pct)),
        level:   utilizationLevel(pct),
      };
    })
    .sort((x, y) => y.pct - x.pct);

  const missingLimit = debts
    .filter((a) => a.creditLimit == null || a.creditLimit <= 0)
    .map((a) => ({ id: a.id, name: a.name }));

  return { rows, missingLimit };
}
