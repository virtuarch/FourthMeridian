/**
 * lib/balances/quantities.ts   (V27-L2 — BALANCE AUTHORITY)
 *
 * THE vocabulary of current-balance quantities. Pure: no DB, no React, no clock.
 *
 * ── Why a vocabulary comes before a value ────────────────────────────────────
 *
 * `FinancialAccount.availableBalance` is ONE column carrying at least three
 * unrelated economic quantities, and the live corpus proves each of them:
 *
 *   CHASE COLLEGE   checking    balance 5,106.77   available  1,106.77   reachable cash
 *   Schwab Individual investment balance  901.66   available      0.00   settled cash
 *                                                                        (all six holdings
 *                                                                         are securities)
 *   Chase CREDIT CARD debt      balance   562.37   available 33,022.48   available CREDIT
 *
 * A consumer that reads the column uniformly is wrong for two of the three, and
 * on the credit card it is wrong by **$32,460** — it would report the user's
 * unused credit line as if it were their money. That is the single most
 * dangerous accessor in the corpus, and it is why no surface may read the column
 * at all: they ask this module what the number MEANS, and it either names a
 * quantity or refuses.
 *
 * ── Refusal is a first-class answer ─────────────────────────────────────────
 *
 * `AvailableClaim` is a discriminated union, and the UNAVAILABLE arm has NO
 * `amount` field at all. That is deliberate and stronger than `amount: number |
 * null`: a consumer cannot read a number that is not in the type, so "null
 * available silently became the observed balance" is not a mistake this codebase
 * can make. Three distinct refusals, because they are different facts:
 *
 *   PROVIDER_DID_NOT_REPORT  the provider sent nothing (availableBalance null)
 *   SEMANTICS_UNATTESTED     the provider sent a number, but nothing attests what
 *                            it means for this account shape — so we decline to
 *                            name it rather than guess
 *   NOT_APPLICABLE           this account has no "available" quantity at all
 *                            (an installment loan, a self-custodied wallet)
 */

// ── Quantities ────────────────────────────────────────────────────────────────

export type BalanceQuantity =
  /** What the provider last said the account's ledger balance was. Raw sign
   *  preserved — on a liability, positive means owed (see lib/debt/balance-semantics). */
  | "OBSERVED_LEDGER"
  /** Provider-reported reachable cash on a depository account. */
  | "AVAILABLE_CASH"
  /** Provider-reported UNUSED CREDIT LINE on a revolving liability. Never money
   *  the user holds; never a cash, asset, or liquidity quantity. */
  | "AVAILABLE_CREDIT"
  /** Provider-reported settled/uninvested cash inside an investment account.
   *  Never the account's value — Schwab Individual is $901.66 of value and
   *  $0.00 of settled cash. */
  | "SETTLED_CASH"
  /** Debt exposure derived from the observed ledger balance, through the
   *  existing lib/debt/balance-semantics authority. */
  | "AMOUNT_OWED"
  /** A negative liability balance as a positive magnitude — the issuer owes the
   *  user. Not an asset: spendable only at that issuer. */
  | "ISSUER_CREDIT"
  /**
   * V27-L3 — observed ledger balance PLUS provider-observed pending movements.
   * Licensed ONLY when at least one pending row exists; with no pending evidence
   * there is nothing to predict from and the observed balance stands as itself.
   */
  | "PREDICTED_CASH"
  /** V27-L3 — amount owed plus provider-observed pending charges, same licence. */
  | "PREDICTED_AMOUNT_OWED"
  /**
   * V27-L3 — the cash a liquidity surface may claim is reachable. Resolved from
   * the provider's attested available cash where it exists, else the predicted
   * figure. NEVER the observed ledger balance: on CHASE COLLEGE those differ by
   * $4,000, and the ledger figure is the one that overstates.
   */
  | "REACHABLE_CASH";

/** Full wording, for detail surfaces with room for a sentence. */
export const QUANTITY_LABEL: Record<BalanceQuantity, string> = {
  OBSERVED_LEDGER:  "Observed ledger balance",
  AVAILABLE_CASH:   "Available cash",
  AVAILABLE_CREDIT: "Available credit",
  SETTLED_CASH:     "Settled cash",
  AMOUNT_OWED:      "Amount owed",
  ISSUER_CREDIT:    "Credit in your favour",
  PREDICTED_CASH:       "Predicted from pending activity",
  PREDICTED_AMOUNT_OWED: "Predicted amount owed",
  REACHABLE_CASH:       "Available now",
};

/** Compact wording for cards and rows. Must never be LESS specific than the
 *  full label in a way that changes the meaning — only shorter. */
export const QUANTITY_SHORT_LABEL: Record<BalanceQuantity, string> = {
  OBSERVED_LEDGER:  "Observed balance",
  AVAILABLE_CASH:   "Available cash",
  AVAILABLE_CREDIT: "Available credit",
  SETTLED_CASH:     "Settled cash",
  AMOUNT_OWED:      "Owed",
  ISSUER_CREDIT:    "Credit",
  PREDICTED_CASH:       "Predicted",
  PREDICTED_AMOUNT_OWED: "Predicted owed",
  REACHABLE_CASH:       "Available now",
};

/** Plural wording for an aggregate over several accounts. */
export const QUANTITY_PLURAL_LABEL: Record<BalanceQuantity, string> = {
  OBSERVED_LEDGER:  "Observed ledger balances",
  AVAILABLE_CASH:   "Available cash",
  AVAILABLE_CREDIT: "Available credit",
  SETTLED_CASH:     "Settled cash",
  AMOUNT_OWED:      "Amounts owed",
  ISSUER_CREDIT:    "Credits in your favour",
  PREDICTED_CASH:       "Predicted from pending activity",
  PREDICTED_AMOUNT_OWED: "Predicted amounts owed",
  REACHABLE_CASH:       "Available now",
};

// ── Refusals ──────────────────────────────────────────────────────────────────

export type UnavailableReason =
  /** availableBalance is null — the provider sent nothing. */
  | "PROVIDER_DID_NOT_REPORT"
  /** A number arrived, but nothing attests what it means for this account shape. */
  | "SEMANTICS_UNATTESTED"
  /** This account has no "available" quantity to report. */
  | "NOT_APPLICABLE";

export const UNAVAILABLE_LABEL: Record<UnavailableReason, string> = {
  PROVIDER_DID_NOT_REPORT: "Available amount not reported",
  SEMANTICS_UNATTESTED:    "Available amount unattested",
  NOT_APPLICABLE:          "No available amount for this account",
};

export const UNAVAILABLE_SHORT_LABEL: Record<UnavailableReason, string> = {
  PROVIDER_DID_NOT_REPORT: "Not reported",
  SEMANTICS_UNATTESTED:    "Unattested",
  NOT_APPLICABLE:          "Not applicable",
};

/** The sentence that explains a refusal to a reader. */
export const UNAVAILABLE_EXPLANATION: Record<UnavailableReason, string> = {
  PROVIDER_DID_NOT_REPORT:
    "The institution did not report an available amount for this account.",
  SEMANTICS_UNATTESTED:
    "The institution reported a figure, but nothing attests what it represents for this kind of account, so it is not shown.",
  NOT_APPLICABLE:
    "This kind of account does not carry an available amount.",
};

// ── Claims ────────────────────────────────────────────────────────────────────

/** A named quantity with a value. The label is not decoration: a figure without
 *  its quantity is the defect this module exists to prevent. */
export interface QuantityClaim {
  quantity:   BalanceQuantity;
  /** In the account's NATIVE currency. FX conversion is a separate layer and
   *  composes in either order (rates are positive, so signs survive). */
  amount:     number;
  label:      string;
  shortLabel: string;
}

/**
 * The account-type-aware interpretation of `availableBalance` — the ONLY way a
 * consumer may learn anything about that column.
 *
 * Note the shape: on UNAVAILABLE there is no `amount` key, so
 * `claim.amount ?? account.balance` does not type-check and cannot be written.
 */
export type AvailableClaim =
  | ({ status: "AVAILABLE" } & QuantityClaim)
  | {
      status:      "UNAVAILABLE";
      reason:      UnavailableReason;
      label:       string;
      shortLabel:  string;
      explanation: string;
    };

export function claim(quantity: BalanceQuantity, amount: number): QuantityClaim {
  return {
    quantity,
    amount,
    label:      QUANTITY_LABEL[quantity],
    shortLabel: QUANTITY_SHORT_LABEL[quantity],
  };
}

export function availableClaim(quantity: BalanceQuantity, amount: number): AvailableClaim {
  return { status: "AVAILABLE", ...claim(quantity, amount) };
}

export function unavailable(reason: UnavailableReason): AvailableClaim {
  return {
    status:      "UNAVAILABLE",
    reason,
    label:       UNAVAILABLE_LABEL[reason],
    shortLabel:  UNAVAILABLE_SHORT_LABEL[reason],
    explanation: UNAVAILABLE_EXPLANATION[reason],
  };
}
