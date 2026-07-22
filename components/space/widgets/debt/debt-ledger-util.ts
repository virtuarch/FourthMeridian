/**
 * components/space/widgets/debt/debt-ledger-util.ts
 *
 * Pure presentation helpers for the editorial Liabilities ledger — the debt analogue
 * of investments/holdings-util.ts. No math authority: the figures of record are still
 * computeDebtKpis over the accounts array (dual-authority, plan §1.4). These helpers
 * only CLASSIFY and LABEL for grouping/rows — they never sum, convert, or value.
 *
 * The liability CLASS is derived from the honest fields the DTO carries: the raw Plaid
 * `debtSubtype` when present, else the revolving signal (a credit limit ⇒ a card-like
 * line). Unknown ⇒ "Other" — we never guess from the name (a claim is a claim).
 */

import { amountOwed, type LiabilityState } from "@/lib/debt/balance-semantics";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

/**
 * A liability prepared for the ledger + detail — display figures computed ONCE by the
 * ledger (one FX pass, mirroring debt-kpis' inDisp), so the ledger row and its detail
 * panel can never disagree. `utilizationPct` stays native (a unitless ratio).
 */
export interface LiabilityRow {
  account:        DebtPerspectiveAccount;
  cls:            DebtClass;
  /** V25-SIDE-1 — the canonical state of this liability (owed / settled / credit).
   *  Decides how the row PRESENTS; never whether the row exists. */
  state:          LiabilityState;
  /** Display-currency amount OWED (`amountOwed`) — zero for settled and credit
   *  rows. This is the figure of record for totals, shares, and interest. */
  value:          number;
  /** Display-currency CREDIT held with the issuer, as a positive magnitude.
   *  Zero unless `state === "credit"`. Never a negative `value`. */
  credit:         number;
  /** value / total-owed, clamped 0–1 (the weight-bar length). */
  share:          number;
  /** Display-currency credit limit, or null. */
  limit:          number | null;
  /** Display-currency minimum payment, or null. */
  minPayment:     number | null;
  /** Display-currency estimated monthly interest (balance × APR/12), or null. */
  estInterest:    number | null;
  /** Native utilization % (balance / limit), or null. May exceed 100. */
  utilizationPct: number | null;
  /** True when any display figure above was FX-estimated. */
  estimated:      boolean;
}

/** The three editorial groups, in display order. */
export type DebtClass = "cards" | "loans" | "other";

export const DEBT_CLASS_LABEL: Record<DebtClass, string> = {
  cards: "Credit cards",
  loans: "Loans",
  other: "Other liabilities",
};

/** Ordered so a stable group sequence is trivial to iterate. */
export const DEBT_CLASS_ORDER: DebtClass[] = ["cards", "loans", "other"];

const LOAN_SUBTYPES = new Set([
  "line_of_credit", "heloc", "auto_loan", "mortgage", "personal_loan", "student_loan",
]);

/** Human label for a specific subtype (detail panel eyebrow), else the class label. */
export function debtSubtypeLabel(a: DebtPerspectiveAccount): string {
  switch (a.debtSubtype) {
    case "credit_card":    return "Credit card";
    case "line_of_credit": return "Line of credit";
    case "heloc":          return "HELOC";
    case "auto_loan":      return "Auto loan";
    case "mortgage":       return "Mortgage";
    case "personal_loan":  return "Personal loan";
    case "student_loan":   return "Student loan";
    default:               return DEBT_CLASS_LABEL[classifyDebt(a)];
  }
}

/** Classify a liability into one of the three editorial groups (honest fields only). */
export function classifyDebt(a: DebtPerspectiveAccount): DebtClass {
  if (a.debtSubtype === "credit_card") return "cards";
  if (a.debtSubtype && LOAN_SUBTYPES.has(a.debtSubtype)) return "loans";
  // No subtype on file — fall back to the revolving signal: a positive credit
  // limit reads as a card-like line, everything else is "other".
  if (a.creditLimit != null && a.creditLimit > 0) return "cards";
  return "other";
}

/** Utilization % for a revolving line (owed / limit), or null when no usable
 *  limit exists. Currency-agnostic (both native to the same account).
 *  V25-SIDE-1 — the numerator is `amountOwed`, so a credit balance reads 0%
 *  used rather than a negative utilization. */
export function accountUtilization(a: DebtPerspectiveAccount): number | null {
  if (a.creditLimit == null || a.creditLimit <= 0) return null;
  return (amountOwed(a.balance) / a.creditLimit) * 100;
}
