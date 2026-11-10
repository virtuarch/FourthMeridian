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
 *
 * V25-SIDE-1: the numerator is the canonical amount OWED
 * (lib/debt/balance-semantics.ts), never the raw signed balance — a credit
 * balance is 0% used, never negative utilization.
 */

import { amountOwed } from "@/lib/debt/balance-semantics";
import { isInstallmentLoan, REVOLVING_DEBT_SUBTYPES } from "@/lib/debt/liability-kind";

export { REVOLVING_DEBT_SUBTYPES };

export interface UtilizationInputAccount {
  id:           string;
  name:         string;
  type:         string;
  balance:      number;
  creditLimit?: number | null;
  /** FM debtSubtype / Plaid providerSubtype — Mortgage F2: an installment loan
   *  (lib/debt/liability-kind.ts) is never a utilization row, whatever limit it carries. */
  debtSubtype?:     string | null;
  providerSubtype?: string | null;
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

/**
 * THE one source of truth for the utilization % a user sees: a whole percent.
 * Every surface renders the number through `formatUtilizationPct` (DebtHero,
 * the utilization rows, CreditHealthInputs, LiabilitiesLedger,
 * DebtAccountDetail, debt signals), and `utilizationLevel` grades THIS value,
 * so the band word / colour can never contradict the number beside it (29.9%
 * used to read "30% · Low"). Defined AS the `toFixed(0)` rendering, so there is
 * no second rounding rule to drift at a .5 boundary (pinned by a parity test).
 */
export function displayedUtilizationPct(pct: number): number {
  return Number(pct.toFixed(0)) + 0; // `+ 0` normalises −0 to 0
}

/** The utilization % text: "30%". Same value `utilizationLevel` grades. */
export function formatUtilizationPct(pct: number): string {
  return `${displayedUtilizationPct(pct)}%`;
}

/**
 * Level thresholds (utilization %, graded on the DISPLAYED whole percent):
 * <30 low, 30–69 moderate, 70–100 high, >100 over.
 */
export function utilizationLevel(pct: number): UtilizationLevel {
  const shown = displayedUtilizationPct(pct);
  if (shown > 100) return "over";
  if (shown >= 70) return "high";
  if (shown >= 30) return "moderate";
  return "low";
}

export interface CreditUtilizationResult {
  /** Revolving debts (have a positive credit limit), highest utilization first. */
  rows:         UtilizationRow[];
  /** Non-installment debt accounts WITHOUT a usable credit limit — surfaced for an
   *  "add limit" affordance. Mortgage F2: installment loans are never prompted. */
  missingLimit: { id: string; name: string }[];
}

/**
 * Utilization % for ONE revolving line, or null when it has no usable limit.
 *
 * v2.6-DEBT-1 — extracted so it is stated once. The ratio also lived in
 * `components/space/widgets/debt/debt-ledger-util.ts`, which meant "what counts
 * as a usable credit limit" had two definitions that happened to agree.
 *
 * V25-SIDE-1 — the numerator is the canonical amount OWED, so a credit balance
 * reads 0% used rather than a negative utilization. The result is NOT clamped:
 * a real over-limit position must be able to exceed 100 (`barPct` clamps for
 * display, and `utilizationLevel` reports "over").
 */

/**
 * REVIEW-3 C-4 — the ONE membership rule for "which lines participate in
 * utilization". Utilization is a REVOLVING-credit concept: a loan that happens
 * to carry a provider limit is not "utilized". A null subtype is admitted
 * (legacy rows predate subtypes; a limit-bearing untyped debt account is a
 * card in this corpus). Both the personal Credit page and the Space debt KPIs
 * consume this predicate — the two previously asked different populations
 * under the same word.
 */
/**
 * Mortgage F2 — the subtype rule is lib/debt/liability-kind.ts `isInstallmentLoan`:
 * an explicit non-revolving debtSubtype, or a Plaid `loan` providerSubtype
 * (mortgage/student/auto/…), is never revolving even when it carries a limit.
 */
export function isRevolvingLine(a: {
  type?: string | null; debtSubtype?: string | null; providerSubtype?: string | null; creditLimit?: number | null;
}): boolean {
  return !isInstallmentLoan(a) && a.creditLimit != null && a.creditLimit > 0;
}

export function utilizationPercent(
  account: { balance: number; creditLimit?: number | null },
): number | null {
  if (account.creditLimit == null || account.creditLimit <= 0) return null;
  return (amountOwed(account.balance) / account.creditLimit) * 100;
}

export function creditUtilization(accounts: UtilizationInputAccount[]): CreditUtilizationResult {
  // Mortgage F2 — installment loans take no part in utilization: no row, and
  // no "add a credit limit" prompt.
  const debts = accounts.filter((a) => a.type === "debt" && !isInstallmentLoan(a));

  const rows: UtilizationRow[] = debts
    .filter((a) => isRevolvingLine(a))
    .map((a) => {
      const limit = a.creditLimit as number;
      const pct = utilizationPercent(a) as number;
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
