/**
 * lib/debt/liability-kind.ts
 *
 * Mortgage F2 (S2 ruling) — the ONE answer to "is this liability an installment
 * loan?", and therefore "must its creditLimit be ignored?".
 *
 * A Plaid `loan` account (mortgage, student, auto, …) can arrive carrying
 * `balances.limit` (stored as FinancialAccount.creditLimit). Before F2 every
 * revolving-credit consumer read that limit as evidence of a credit card: a
 * $300k mortgage with a $400k limit showed 75% "high" utilization, $100k of
 * "available credit", and had its history replayed like a card. A limit-less
 * mortgage was listed under "add a credit limit".
 *
 * RULING: Plaid loan types are NEVER revolving. For an installment loan the
 * creditLimit is ignored by credit utilization, available credit, history
 * replay, and the "add a credit limit" prompt. Revolving lines and credit cards
 * are unchanged.
 *
 * Every affected site imports this module; no other file keeps its own subtype
 * list for this decision.
 *
 * Pure: no DB, no server-only imports (client components import it).
 */

/**
 * FM's own `FinancialAccount.debtSubtype` values that are revolving lines.
 * (Vocabulary: app/api/accounts/[id]/route.ts PATCH; schema comment on
 * FinancialAccount.debtSubtype.)
 */
export const REVOLVING_DEBT_SUBTYPES: ReadonlySet<string> = new Set(["credit_card", "line_of_credit", "heloc"]);

/** FM `debtSubtype` values that amortise (named for documentation; any explicit
 *  non-revolving debtSubtype is treated as installment — see isInstallmentLoan). */
export const INSTALLMENT_DEBT_SUBTYPES: ReadonlySet<string> = new Set(["mortgage", "auto_loan", "student_loan", "personal_loan"]);

/**
 * Plaid `credit` account subtypes (lowercased, as stored in providerSubtype):
 * revolving, transaction-driven lines. Source: plaid-node `CreditAccountSubtype`
 * (node_modules/plaid/dist/api.d.ts), minus the `all` filter value.
 */
export const PLAID_CREDIT_SUBTYPES: ReadonlySet<string> = new Set(["credit card", "paypal"]);

/**
 * Plaid `loan` account subtypes (lowercased, as stored in providerSubtype).
 * Source: plaid-node `LoanAccountSubtype` enum (node_modules/plaid/dist/api.d.ts
 * — auto, business, commercial, construction, consumer, home equity, loan,
 * mortgage, overdraft, line of credit, student, other), minus the `all` filter
 * value, which is never an account's subtype. Plaid's own Account Types table
 * lists the same loan subtypes.
 *
 * `home equity` and `line of credit` are Plaid LOAN subtypes too, so per the
 * ruling they are not revolving when they arrive from Plaid with no FM
 * debtSubtype. A user who sets debtSubtype "heloc" / "line_of_credit" (an
 * explicit FM classification) still gets the revolving treatment.
 */
export const PLAID_LOAN_SUBTYPES: ReadonlySet<string> = new Set([
  "auto", "business", "commercial", "construction", "consumer", "home equity",
  "loan", "mortgage", "overdraft", "line of credit", "student", "other",
]);

function norm(s: string | null | undefined): string | null {
  const t = s?.trim().toLowerCase();
  return t ? t : null;
}

export interface LiabilityKindInput {
  /** FinancialAccount.type. When supplied and not "debt", the answer is false. */
  type?: string | null;
  /** FinancialAccount.debtSubtype — FM's own (user-set) classification. */
  debtSubtype?: string | null;
  /** FinancialAccount.providerSubtype — Plaid `subtype` (lowercased evidence). */
  providerSubtype?: string | null;
}

/**
 * True when the liability is an installment loan, so any creditLimit it carries
 * is NOT revolving-credit evidence.
 *
 *   1. An explicit FM debtSubtype decides: revolving (credit_card,
 *      line_of_credit, heloc) ⇒ false; anything else (mortgage, auto_loan,
 *      student_loan, personal_loan, or an unknown loan kind) ⇒ true.
 *   2. Otherwise the Plaid subtype decides: a Plaid `loan` subtype ⇒ true.
 *   3. No evidence either way (legacy untyped row, Plaid credit subtype) ⇒ false
 *      — callers keep their existing revolving rules for those rows.
 */
export function isInstallmentLoan(a: LiabilityKindInput): boolean {
  if (a.type != null && a.type !== "debt") return false;
  const ds = norm(a.debtSubtype);
  if (ds !== null) return !REVOLVING_DEBT_SUBTYPES.has(ds);
  const sub = norm(a.providerSubtype);
  return sub !== null && PLAID_LOAN_SUBTYPES.has(sub);
}

/** The creditLimit a revolving-credit consumer may use: null for an installment loan. */
export function revolvingCreditLimit(a: LiabilityKindInput & { creditLimit?: number | null }): number | null {
  if (isInstallmentLoan(a)) return null;
  return a.creditLimit ?? null;
}
