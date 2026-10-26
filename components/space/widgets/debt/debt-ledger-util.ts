/**
 * components/space/widgets/debt/debt-ledger-util.ts
 *
 * Pure presentation helpers for the editorial Liabilities ledger — the debt analogue
 * of investments/holdings-util.ts. No math authority: the figures of record are still
 * computeDebtKpis over the accounts array (dual-authority, plan §1.4). These helpers
 * only CLASSIFY and LABEL for grouping/rows — they never sum, convert, or value.
 *
 * The liability CLASS is derived from the honest fields the DTO carries
 * (`presentationDebtClass`, v2.7 R2 — DISPLAY ONLY):
 *   1. the stored `debtSubtype` when present — it ALWAYS wins;
 *   2. else the normalized provider `providerSubtype` (Plaid's own account subtype,
 *      `normalizeProviderSubtype`), mapped through an owner-approved table;
 *   3. else "Other". A credit limit alone is NOT evidence of a card (owner D-5):
 *      the old "limit ⇒ card-like" fallback put HELOCs and unknown rows under
 *      Credit cards, so it is gone. We never guess from the name either.
 * Nothing here feeds totals, utilization, interest, payoff, or stored data.
 */

import { type LiabilityState } from "@/lib/debt/balance-semantics";
import { utilizationPercent } from "@/lib/accounts/credit-utilization";
import { normalizeProviderSubtype } from "@/lib/account-classifier";
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

/**
 * STORED `debtSubtype` → (class, label). Today's grouping is preserved EXCEPT
 * `line_of_credit`: owner direction is that a revolving line presents under
 * Credit, so stored "line_of_credit" → cards. Stored "heloc" stays a loan (a
 * home-equity line is secured borrowing; owner D-4 groups it with Loans).
 */
const STORED_SUBTYPE: Record<string, { cls: DebtClass; label: string }> = {
  credit_card:    { cls: "cards", label: "Credit card" },
  line_of_credit: { cls: "cards", label: "Line of credit" },
  heloc:          { cls: "loans", label: "HELOC" },
  auto_loan:      { cls: "loans", label: "Auto loan" },
  mortgage:       { cls: "loans", label: "Mortgage" },
  personal_loan:  { cls: "loans", label: "Personal loan" },
  student_loan:   { cls: "loans", label: "Student loan" },
};

/**
 * Normalized PROVIDER subtype (lowercase, trimmed — `normalizeProviderSubtype`)
 * → (class, label). Consulted only when no stored `debtSubtype` exists. Anything
 * not listed (incl. "overdraft", "business", null) ⇒ "other" (owner D-5).
 */
const PROVIDER_SUBTYPE: Record<string, { cls: DebtClass; label: string }> = {
  "credit card":                { cls: "cards", label: "Credit card" },
  "paypal":                     { cls: "cards", label: "Credit card" },
  "line of credit":             { cls: "cards", label: "Line of credit" },
  "home equity":                { cls: "loans", label: "HELOC" },
  "mortgage":                   { cls: "loans", label: "Mortgage" },
  "student":                    { cls: "loans", label: "Student loan" },
  "auto":                       { cls: "loans", label: "Auto loan" },
  "consumer":                   { cls: "loans", label: "Personal loan" },
  "loan":                       { cls: "loans", label: "Personal loan" },
  "personal":                   { cls: "loans", label: "Personal loan" },
  "installment personal loans": { cls: "loans", label: "Personal loan" },
};

/** The fields presentation classification reads — nothing else. */
type DebtClassInput = Pick<DebtPerspectiveAccount, "debtSubtype" | "providerSubtype" | "aggregate">;

function presentationEntry(a: DebtClassInput): { cls: DebtClass; label: string } | null {
  if (a.debtSubtype) return STORED_SUBTYPE[a.debtSubtype] ?? null;
  // A privacy-aggregated row merges members WITHOUT keying on providerSubtype
  // (lib/account-privacy.ts), so the subtype it carries is one member's — it
  // cannot speak for the group. Such a row presents as "Other".
  if (a.aggregate) return null;
  const sub = normalizeProviderSubtype(a.providerSubtype);
  return sub !== null ? PROVIDER_SUBTYPE[sub] ?? null : null;
}

/**
 * v2.7 R2 — the ONE presentation class for a liability (ledger grouping, detail
 * eyebrow, compact Credit/Loans counts all read this). Stored `debtSubtype`
 * wins; else the normalized provider subtype; else "other". Never inferred from
 * a credit limit. DISPLAY ONLY — no total, ratio, or stored value depends on it.
 */
export function presentationDebtClass(a: DebtClassInput): DebtClass {
  return presentationEntry(a)?.cls ?? "other";
}

/** v2.7 R2 — human label for the liability's specific kind, else its class label. */
export function presentationDebtLabel(a: DebtClassInput): string {
  const e = presentationEntry(a);
  return e ? e.label : DEBT_CLASS_LABEL.other;
}

/** Human label for a specific subtype (detail panel eyebrow), else the class label. */
export function debtSubtypeLabel(a: DebtPerspectiveAccount): string {
  return presentationDebtLabel(a);
}

/** Classify a liability into one of the three editorial groups (honest fields only). */
export function classifyDebt(a: DebtPerspectiveAccount): DebtClass {
  return presentationDebtClass(a);
}

/** Utilization % for a revolving line, or null when no usable limit exists.
 *  Currency-agnostic (both native to the same account).
 *
 *  v2.6-DEBT-1 — this had transcribed the ratio itself
 *  (`amountOwed(balance) / creditLimit * 100`) rather than calling the module
 *  that owns it. Same formula, second site: a later change to what counts as a
 *  usable limit would have landed in one of them. `lib/accounts/credit-utilization.ts`
 *  is the owner (it also owns the LEVEL bands the KPI strip and signals read),
 *  so this is now a thin adapter from the ledger's row shape onto it. */
export function accountUtilization(a: DebtPerspectiveAccount): number | null {
  return utilizationPercent({ balance: a.balance, creditLimit: a.creditLimit });
}
