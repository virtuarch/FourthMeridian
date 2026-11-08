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

// ─────────────────────────────────────────────────────────────────────────────
// Owner 2026-11-08 — ONE fine-grained debt-type model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fine-grained debt type (owner requirement 2026-11-08): mortgages and
 * installment loans share some accounting behaviour but remain DISTINCT types.
 * `debtType` is the ONE classifier; `liabilityKind` is DEFINED from it (the
 * revolving / installment partition below), so the two can never disagree.
 *
 * Mortgage-specific behaviour (mortgage rate label, equity, amortization,
 * escrow) keys on `debtType(a) === "mortgage"` — never on `isInstallmentLoan`
 * or a raw subtype comparison (pinned by lib/debt/debt-type.test.ts).
 */
export type DebtType =
  | "credit_card"
  | "personal_installment"
  | "auto_loan"
  | "student_loan"
  | "mortgage"
  | "heloc"
  | "personal_line_of_credit"
  | "overdraft"
  | "other_revolving"
  | "other_installment"
  | "unknown";

/** Every DebtType, in a stable display order. */
export const DEBT_TYPES: readonly DebtType[] = [
  "credit_card", "personal_line_of_credit", "heloc", "overdraft", "other_revolving",
  "mortgage", "auto_loan", "student_loan", "personal_installment", "other_installment",
  "unknown",
];

/** The revolving debt types — the ONLY ones that take part in utilization / available credit. */
export const REVOLVING_DEBT_TYPES: ReadonlySet<DebtType> = new Set<DebtType>([
  "credit_card", "personal_line_of_credit", "heloc", "overdraft", "other_revolving",
]);
/** The installment (amortising) debt types. */
export const INSTALLMENT_DEBT_TYPES: ReadonlySet<DebtType> = new Set<DebtType>([
  "mortgage", "auto_loan", "student_loan", "personal_installment", "other_installment",
]);

/** Human label for a debt type — what the UI and the AI name the liability. */
export const DEBT_TYPE_LABEL: Readonly<Record<DebtType, string>> = {
  credit_card:             "Credit card",
  personal_installment:    "Personal loan",
  auto_loan:               "Auto loan",
  student_loan:            "Student loan",
  mortgage:                "Mortgage",
  heloc:                   "HELOC",
  personal_line_of_credit: "Line of credit",
  overdraft:               "Overdraft line",
  other_revolving:         "Revolving credit",
  other_installment:       "Installment loan",
  unknown:                 "Debt",
};

/** FM `debtSubtype` (explicit, user-set) → DebtType. Any other non-empty value ⇒ other_installment. */
const DEBT_SUBTYPE_TO_TYPE: Readonly<Record<string, DebtType>> = {
  credit_card:    "credit_card",
  line_of_credit: "personal_line_of_credit",
  heloc:          "heloc",
  mortgage:       "mortgage",
  auto_loan:      "auto_loan",
  student_loan:   "student_loan",
  personal_loan:  "personal_installment",
};

/**
 * Plaid subtype (lowercased) → DebtType, for every subtype in PLAID_CREDIT_SUBTYPES
 * ∪ PLAID_LOAN_SUBTYPES except the limit-discriminated "home equity" (handled in
 * `debtType`). Pinned by test to cover both sets exactly.
 */
const PLAID_SUBTYPE_TO_TYPE: Readonly<Record<string, DebtType>> = {
  "credit card":    "credit_card",
  "paypal":         "other_revolving",
  "line of credit": "personal_line_of_credit",
  "overdraft":      "overdraft",
  "mortgage":       "mortgage",
  "auto":           "auto_loan",
  "student":        "student_loan",
  "consumer":       "personal_installment",
  "loan":           "other_installment",
  "business":       "other_installment",
  "commercial":     "other_installment",
  "construction":   "other_installment",
  "other":          "other_installment",
};

/**
 * THE debt type of a liability. Evidence order (unchanged from F2):
 *
 *   0. `type` supplied and not "debt" ⇒ unknown.
 *   1. An explicit FM debtSubtype decides (credit_card, line_of_credit, heloc,
 *      mortgage, auto_loan, student_loan, personal_loan; any other non-empty
 *      value ⇒ other_installment).
 *   2. Otherwise the Plaid subtype decides; "home equity" is a HELOC only with
 *      a positive creditLimit, else a closed-end home-equity loan
 *      (other_installment — NOT a mortgage: no mortgage behaviour applies).
 *   3. No evidence / unrecognised subtype ⇒ unknown (callers keep their legacy
 *      rules, e.g. a limit-bearing untyped row is treated as a card).
 */
export function debtType(a: LiabilityKindInput): DebtType {
  if (a.type != null && a.type !== "debt") return "unknown";
  const ds = norm(a.debtSubtype);
  if (ds !== null) return DEBT_SUBTYPE_TO_TYPE[ds] ?? "other_installment";
  const sub = norm(a.providerSubtype);
  if (sub === null) return "unknown";
  if (PLAID_LIMIT_DISCRIMINATED_SUBTYPES.has(sub)) {
    return a.creditLimit != null && a.creditLimit > 0 ? "heloc" : "other_installment";
  }
  return PLAID_SUBTYPE_TO_TYPE[sub] ?? "unknown";
}

/** The coarse kind of a debt type. */
export function kindOfDebtType(t: DebtType): LiabilityKind {
  if (REVOLVING_DEBT_TYPES.has(t)) return "revolving";
  if (INSTALLMENT_DEBT_TYPES.has(t)) return "installment";
  return "unknown";
}

/** The human label for ONE liability ("Auto loan", "HELOC", "Mortgage", …). */
export function debtTypeLabel(a: LiabilityKindInput): string {
  return DEBT_TYPE_LABEL[debtType(a)];
}

// ─────────────────────────────────────────────────────────────────────────────
// S2 PRIVACY ruling P1 (2026-11-08) — a debt TYPE label never discloses more
// than the viewer's visibility allows.
// ─────────────────────────────────────────────────────────────────────────────
//
// A balance-only co-member must never learn "Mortgage" / "HELOC" (home
// ownership + secured debt). For any account the viewer neither owns nor holds
// at FULL visibility, every type label in UI and AI payloads is the COARSE kind
// only: installment → "Loan", revolving → "Credit line", unknown → "Debt".
// Classification and arithmetic are unchanged — `debtType` / `liabilityKind`
// still read the full evidence; only the NAME is coarsened.
//
// THE rule: `viewerDebtLabel(account, access)`. `debtTypeLabel` /
// DEBT_TYPE_LABEL[...] are called nowhere else (source-scan pinned,
// lib/debt/viewer-debt-label.test.ts).

/** What the viewer may see of a debt's TYPE: the fine type, or its coarse kind only. */
export type DebtLabelAccess = "FINE" | "COARSE";

/** The visibility facts a row carries about its viewer. */
export interface DebtLabelViewer {
  /** SpaceAccountLink.visibilityLevel of the row (FULL / BALANCE_ONLY / …). */
  visibilityLevel?: string | null;
  /** True when the viewer owns the account. */
  viewerIsOwner?: boolean | null;
}

/**
 * FINE only for the owner or a FULL-visibility viewer. Everything else — a
 * BALANCE_ONLY row, an unknown tier, a row that does not say — FAILS CLOSED to
 * COARSE.
 */
export function debtLabelAccess(v: DebtLabelViewer | null | undefined): DebtLabelAccess {
  return v?.viewerIsOwner === true || v?.visibilityLevel === "FULL" ? "FINE" : "COARSE";
}

/** The coarse names, by kind (S2 vocabulary). */
export const COARSE_DEBT_LABEL: Readonly<Record<LiabilityKind, string>> = {
  installment: "Loan",
  revolving:   "Credit line",
  unknown:     "Debt",
};

/** The kind-preserving generic DebtType a COARSE viewer may be told. */
const COARSE_DEBT_TYPE: Readonly<Record<LiabilityKind, DebtType>> = {
  installment: "other_installment",
  revolving:   "other_revolving",
  unknown:     "unknown",
};

/**
 * The debt TYPE a viewer may be told: the fine type at FINE access; at COARSE,
 * the generic type of the same kind (other_installment / other_revolving /
 * unknown) — so `kindOfDebtType` of the answer is unchanged.
 */
export function viewerDebtType(a: LiabilityKindInput, access: DebtLabelAccess): DebtType {
  const t = debtType(a);
  return access === "FINE" ? t : COARSE_DEBT_TYPE[kindOfDebtType(t)];
}

/** THE debt-type label a viewer sees ("Mortgage" at FINE; "Loan" at COARSE). */
export function viewerDebtLabel(a: LiabilityKindInput, access: DebtLabelAccess): string {
  return access === "FINE" ? debtTypeLabel(a) : COARSE_DEBT_LABEL[liabilityKind(a)];
}

/** True ONLY for a mortgage — the gate for every mortgage-specific behaviour
 *  (mortgage rate label, equity, amortization schedule, escrow). */
export function isMortgageDebt(a: LiabilityKindInput): boolean {
  return debtType(a) === "mortgage";
}

/**
 * The liability's kind — DEFINED from `debtType` (owner 2026-11-08), so the two
 * classifications cannot disagree:
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
  return kindOfDebtType(debtType(a));
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

// ─────────────────────────────────────────────────────────────────────────────
// Mortgage F10 (S2 ruling) — payments to an installment loan that is NOT connected
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plaid personal_finance_category DETAILED codes that name an INSTALLMENT-loan
 * payee: the provider positively says what kind of loan was paid. A strict
 * subset of the transfer authority's LIABILITY_PAYMENT_DETAILS
 * (lib/transactions/transfer-debt-payment-correction.ts — the unpaired legs the
 * write-time correction KEEPS as DEBT_PAYMENT), pinned by test, so the read-time
 * F10 leaf can never fire on a row the correction would rewrite to TRANSFER.
 *
 * Deliberately absent:
 *   • LOAN_PAYMENTS_CREDIT_CARD_PAYMENT — a card is revolving, not a loan whose
 *     payment carries principal + interest + escrow; and card-payment tags are
 *     the family Plaid mislabels by brand (CCPAY-2B).
 *   • LOAN_PAYMENTS_OTHER_PAYMENT — names no liability (the issuer-pull tag the
 *     transfer authority rewrites to TRANSFER).
 */
export const INSTALLMENT_LOAN_PAYMENT_DETAILS: ReadonlySet<string> = new Set([
  "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
  "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
  "LOAN_PAYMENTS_CAR_PAYMENT",
  "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
]);

/** True when the provider's detailed category names an installment-loan payee. */
export function isInstallmentLoanPaymentDetail(pfcDetailed: string | null | undefined): boolean {
  const d = pfcDetailed?.trim().toUpperCase();
  return d ? INSTALLMENT_LOAN_PAYMENT_DETAILS.has(d) : false;
}

/**
 * Owner F6 (approved 2026-11-08) + S2 ruling D3 — the label for a loan payment
 * whose components are not individually known. Until exact payment components
 * are available a payment is shown UNSPLIT, saying plainly that its parts have
 * not been individually verified — never an invented allocation, never the
 * whole payment as principal reduction.
 *
 * D3: the label is TYPE-AWARE. Escrow is a MORTGAGE concept; naming it on an
 * auto, student or personal loan payment is false. One constant per variant (no
 * string building), chosen by ONE selector (`unsplitLoanPaymentLabel`). Every
 * surface that names such a payment (Mortgage F10's untracked-loan Cash Out
 * line, the resolved-nature description / AI natureNote, the transfer
 * authority's leaf wording) reads these.
 */
export const UNSPLIT_MORTGAGE_PAYMENT_LABEL = "loan payment (principal + interest + escrow, not split)";
/** Auto / student / personal (and any other non-mortgage installment) loan. */
export const UNSPLIT_INSTALLMENT_LOAN_PAYMENT_LABEL = "loan payment (principal + interest, not split)";
/** Loan type not established — names no component it cannot vouch for. */
export const UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL = "loan payment (not split)";

/** Which unsplit-label variant a payment takes. */
export type UnsplitLoanKind = "mortgage" | "installment" | "unknown";

export const UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND: Readonly<Record<UnsplitLoanKind, string>> = {
  mortgage:    UNSPLIT_MORTGAGE_PAYMENT_LABEL,
  installment: UNSPLIT_INSTALLMENT_LOAN_PAYMENT_LABEL,
  unknown:     UNSPLIT_UNKNOWN_LOAN_PAYMENT_LABEL,
};

/** Provider detailed category → variant. Exactly INSTALLMENT_LOAN_PAYMENT_DETAILS (pinned by test). */
const PFC_DETAIL_TO_UNSPLIT_KIND: Readonly<Record<string, UnsplitLoanKind>> = {
  LOAN_PAYMENTS_MORTGAGE_PAYMENT:      "mortgage",
  LOAN_PAYMENTS_CAR_PAYMENT:           "installment",
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT:  "installment",
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: "installment",
};

/** DebtType → variant (fallback when the row names no loan type): mortgage ⇒
 *  escrow; every other installment type ⇒ P+I; revolving / unknown ⇒ neutral. */
const DEBT_TYPE_TO_UNSPLIT_KIND: Readonly<Record<DebtType, UnsplitLoanKind>> = {
  mortgage:                "mortgage",
  auto_loan:               "installment",
  student_loan:            "installment",
  personal_installment:    "installment",
  other_installment:       "installment",
  credit_card:             "unknown",
  heloc:                   "unknown",
  personal_line_of_credit: "unknown",
  overdraft:               "unknown",
  other_revolving:         "unknown",
  unknown:                 "unknown",
};

/**
 * The variant for one payment. Evidence order: the row's provider detailed
 * category (pfcDetailed) when it names a loan type; otherwise the destination
 * account's `debtType` (e.g. a connected servicer leg identified by account
 * type): mortgage ⇒ mortgage; any other installment type ⇒ installment;
 * anything else / no evidence ⇒ unknown (neutral).
 */
export function unsplitLoanKind(
  pfcDetailed: string | null | undefined,
  fallbackDebtType?: DebtType | null,
): UnsplitLoanKind {
  const d = pfcDetailed?.trim().toUpperCase();
  const fromPfc = d ? PFC_DETAIL_TO_UNSPLIT_KIND[d] : undefined;
  if (fromPfc) return fromPfc;
  return fallbackDebtType != null ? DEBT_TYPE_TO_UNSPLIT_KIND[fallbackDebtType] : "unknown";
}

/** THE selector: the unsplit-payment label for one payment (see `unsplitLoanKind`). */
export function unsplitLoanPaymentLabel(
  pfcDetailed: string | null | undefined,
  fallbackDebtType?: DebtType | null,
): string {
  return UNSPLIT_LOAN_PAYMENT_LABEL_BY_KIND[unsplitLoanKind(pfcDetailed, fallbackDebtType)];
}

/**
 * The variant for an AGGREGATE of payments (a Cash Out line). One kind ⇒ that
 * kind; none or a mix ⇒ unknown — a mortgage + auto total is neither "with
 * escrow" nor "without", so it names no component.
 */
export function unsplitLoanKindOf(kinds: Iterable<UnsplitLoanKind>): UnsplitLoanKind {
  const set = new Set(kinds);
  return set.size === 1 ? [...set][0] : "unknown";
}

/**
 * The AI-facing disclosure for unsplit payments (F6): attached wherever the AI
 * receives an unsplit loan-payment figure, so the model never narrates the
 * payment as principal reduction or invents a split.
 */
export const UNSPLIT_LOAN_PAYMENT_AI_NOTE =
  "Unsplit loan payments: principal, interest and (for a mortgage) escrow have NOT been individually verified. "
  + "Do not present any part of such a payment as principal reduction or paydown, and do not estimate a split.";
