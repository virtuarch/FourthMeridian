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
 * RULING (F2 + S2 HELOC follow-up): Plaid installment loan types are never
 * revolving; Plaid "line of credit"/"overdraft" are, and "home equity" is
 * revolving only with a positive limit. For an installment loan the
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
 * Plaid `loan` account subtypes (lowercased, as stored in providerSubtype) — the
 * full set. Source: plaid-node `LoanAccountSubtype` enum
 * (node_modules/plaid/dist/api.d.ts — auto, business, commercial, construction,
 * consumer, home equity, loan, mortgage, overdraft, line of credit, student,
 * other), minus the `all` filter value, which is never an account's subtype.
 *
 * S2 HELOC ruling — not every Plaid loan subtype is installment:
 *   • "line of credit", "overdraft" ⇒ REVOLVING always
 *     (PLAID_REVOLVING_LOAN_SUBTYPES);
 *   • "home equity" ⇒ REVOLVING only with a positive creditLimit, else
 *     INSTALLMENT — Plaid uses it for both HELOCs and closed-end home-equity
 *     loans, and the limit is the discriminator (PLAID_LIMIT_DISCRIMINATED_SUBTYPES);
 *   • every other loan subtype ⇒ INSTALLMENT, even with a limit (H5).
 */
export const PLAID_LOAN_SUBTYPES: ReadonlySet<string> = new Set([
  "auto", "business", "commercial", "construction", "consumer", "home equity",
  "loan", "mortgage", "overdraft", "line of credit", "student", "other",
]);
/** Plaid loan subtypes that are revolving lines regardless of limit. */
export const PLAID_REVOLVING_LOAN_SUBTYPES: ReadonlySet<string> = new Set(["line of credit", "overdraft"]);
/** Plaid loan subtypes whose kind is decided by the presence of a positive limit. */
export const PLAID_LIMIT_DISCRIMINATED_SUBTYPES: ReadonlySet<string> = new Set(["home equity"]);

function norm(s: string | null | undefined): string | null {
  const t = s?.trim().toLowerCase();
  return t ? t : null;
}

export interface LiabilityKindInput {
  /** FinancialAccount.type. When supplied and not "debt", the kind is "unknown". */
  type?: string | null;
  /** FinancialAccount.debtSubtype — FM's own (user-set) classification. */
  debtSubtype?: string | null;
  /** FinancialAccount.providerSubtype — Plaid `subtype` (lowercased evidence). */
  providerSubtype?: string | null;
  /** FinancialAccount.creditLimit — discriminates Plaid "home equity" only. */
  creditLimit?: number | null;
}

export type LiabilityKind = "revolving" | "installment" | "unknown";

/**
 * The liability's kind:
 *
 *   1. An explicit FM debtSubtype decides: credit_card / line_of_credit / heloc
 *      ⇒ revolving; anything else (mortgage, auto_loan, student_loan,
 *      personal_loan, an unknown loan kind) ⇒ installment.
 *   2. Otherwise the Plaid subtype decides:
 *        credit card, paypal, line of credit, overdraft ⇒ revolving;
 *        home equity ⇒ revolving with a positive creditLimit, else installment;
 *        any other Plaid loan subtype ⇒ installment (limit ignored).
 *   3. No evidence (legacy untyped row, unknown subtype) ⇒ "unknown" — callers
 *      keep their existing rules (e.g. a limit-bearing untyped row is a card).
 */
export function liabilityKind(a: LiabilityKindInput): LiabilityKind {
  if (a.type != null && a.type !== "debt") return "unknown";
  const ds = norm(a.debtSubtype);
  if (ds !== null) return REVOLVING_DEBT_SUBTYPES.has(ds) ? "revolving" : "installment";
  const sub = norm(a.providerSubtype);
  if (sub === null) return "unknown";
  if (PLAID_CREDIT_SUBTYPES.has(sub) || PLAID_REVOLVING_LOAN_SUBTYPES.has(sub)) return "revolving";
  if (PLAID_LIMIT_DISCRIMINATED_SUBTYPES.has(sub)) {
    return a.creditLimit != null && a.creditLimit > 0 ? "revolving" : "installment";
  }
  if (PLAID_LOAN_SUBTYPES.has(sub)) return "installment";
  return "unknown";
}

/** True when the liability is an installment loan, so any creditLimit it carries
 *  is NOT revolving-credit evidence. */
export function isInstallmentLoan(a: LiabilityKindInput): boolean {
  return liabilityKind(a) === "installment";
}

/** The creditLimit a revolving-credit consumer may use: null for an installment loan. */
export function revolvingCreditLimit(a: LiabilityKindInput): number | null {
  if (isInstallmentLoan(a)) return null;
  return a.creditLimit ?? null;
}
