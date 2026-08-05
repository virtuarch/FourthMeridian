/**
 * lib/transactions/income-source.ts   (v2.6-TRUTH-4)
 *
 * THE canonical income taxonomy. One authority, feeding Cash Flow, Investments
 * Activity, income cards, drawers, AI payloads and exports.
 *
 * Pure: no DB, no React, no clock. Derived only.
 *
 * ── The problem, measured (live corpus, 2026-08-04) ─────────────────────────
 *
 * "Income: $274,198.40" is one number standing for four different things:
 *
 *     INCOME_SALARY           54 rows   $255,648.69   payroll
 *     INCOME_CONTRACTOR        8 rows    $18,435.75   contract work
 *     INCOME_GIG_ECONOMY       1 row         $45.09   gig work
 *     INCOME_INTEREST_EARNED  45 rows        $68.63   ← NOT earned income
 *     (no provider family)    28 rows         $0.24   ← "Bitcoin received"
 *
 * Interest is presented today as though it were earned. It is not: $68.63 of
 * that total is what deposits paid, from HYSA, CHASE SAVINGS and Rewards
 * Checking — and the source account is known for every one of them.
 *
 * Dividends are missing from the number entirely. They live as InvestmentEvent
 * rows (25 · $27.76), so Cash Flow's income total and Investments Activity
 * disagree about what income is. One authority has to cover both.
 *
 * And at least one row is not income at all: +$280.45 "MICROSOFT" on a CREDIT
 * CARD, filed INCOME. A positive amount on a liability from a non-payment family
 * is an issuer credit — v2.6-TRUTH-3 already established that — so the income
 * authority must consult that verdict rather than take `flowType` at face value.
 *
 * ── Why the provider FAMILY and never a descriptor ─────────────────────────
 *
 * Same doctrine as the liability-inflow authority: "VECTRUS SYSTEMS PAYROLL PPD
 * ID: 22215228" is one employer's ACH descriptor, and matching on it would
 * encode a payroll processor's string format as a financial rule. The provider's
 * classification detail (INCOME_SALARY, INCOME_INTEREST_EARNED, …) carries the
 * same information in a vocabulary that survives a change of employer.
 *
 * Cadence is not evidence either. Something arriving every two weeks is not
 * thereby a salary — a standing transfer does that too. Nothing in this module
 * looks at intervals, and a probe enforces it.
 */

/** The four top-level income classes, plus the explicit not-income answer. */
export type IncomeClass =
  | "EARNED_INCOME"
  | "INTEREST_INCOME"
  | "DIVIDEND_INCOME"
  | "OTHER_INCOME"
  /** An inflow that is NOT income. Named, so it can be excluded on purpose. */
  | "NOT_INCOME";

export type IncomeSubtype =
  // EARNED_INCOME
  | "SALARY" | "WAGES" | "CONTRACT" | "BUSINESS"
  // INTEREST_INCOME
  | "DEPOSIT_INTEREST" | "CASH_SWEEP_INTEREST"
  // DIVIDEND_INCOME
  | "SECURITY_DIVIDEND" | "FUND_DISTRIBUTION"
  // OTHER_INCOME
  | "REWARDS_AS_INCOME" | "MISC_INFLOW" | "UNRESOLVED_INCOME"
  // NOT_INCOME — each named rather than lumped, so a surface can say which
  | "INTERNAL_TRANSFER" | "REFUND_REVERSAL" | "ISSUER_CREDIT"
  | "LOAN_PROCEEDS" | "SALE_PROCEEDS" | "CAPITAL_CONTRIBUTION";

/** Provider detail → the subtype it attests. Provider-neutral by contract: an
 *  adapter maps its own vocabulary onto these keys. */
const DETAIL_SUBTYPE: Record<string, IncomeSubtype> = {
  INCOME_WAGES:           "WAGES",
  INCOME_SALARY:          "SALARY",
  INCOME_CONTRACTOR:      "CONTRACT",
  INCOME_GIG_ECONOMY:     "CONTRACT",
  INCOME_FREELANCE:       "CONTRACT",
  INCOME_BUSINESS:        "BUSINESS",
  INCOME_INTEREST_EARNED: "DEPOSIT_INTEREST",
  INCOME_DIVIDENDS:       "SECURITY_DIVIDEND",
  INCOME_RETIREMENT_PENSION: "MISC_INFLOW",
  INCOME_UNEMPLOYMENT:    "MISC_INFLOW",
  INCOME_TAX_REFUND:      "MISC_INFLOW",
  INCOME_OTHER_INCOME:    "MISC_INFLOW",
  LOAN_DISBURSEMENTS_STUDENT_LOAN_DISBURSEMENT: "LOAN_PROCEEDS",
};

const CLASS_OF: Record<IncomeSubtype, IncomeClass> = {
  SALARY: "EARNED_INCOME", WAGES: "EARNED_INCOME", CONTRACT: "EARNED_INCOME", BUSINESS: "EARNED_INCOME",
  DEPOSIT_INTEREST: "INTEREST_INCOME", CASH_SWEEP_INTEREST: "INTEREST_INCOME",
  SECURITY_DIVIDEND: "DIVIDEND_INCOME", FUND_DISTRIBUTION: "DIVIDEND_INCOME",
  REWARDS_AS_INCOME: "OTHER_INCOME", MISC_INFLOW: "OTHER_INCOME", UNRESOLVED_INCOME: "OTHER_INCOME",
  INTERNAL_TRANSFER: "NOT_INCOME", REFUND_REVERSAL: "NOT_INCOME", ISSUER_CREDIT: "NOT_INCOME",
  LOAN_PROCEEDS: "NOT_INCOME", SALE_PROCEEDS: "NOT_INCOME", CAPITAL_CONTRIBUTION: "NOT_INCOME",
};

export function classOfSubtype(s: IncomeSubtype): IncomeClass { return CLASS_OF[s]; }

export interface IncomeEvidence {
  /** Stored FlowType. Supporting evidence — never the last word (see rule 1). */
  flowType: string | null | undefined;
  /** Provider classification family (e.g. Plaid pfcPrimary). */
  providerFamily?: string | null;
  /** Provider classification detail (e.g. Plaid pfcDetailed). */
  providerDetail?: string | null;
  /** The account the money landed in: checking | savings | debt | investment | … */
  accountType: string;
  /** Signed amount. Income is an inflow; a negative amount is never income. */
  amount: number;
  /** True when the transfer authority established an OWNED counterparty. */
  isOwnedInternalTransfer?: boolean;
  /**
   * v2.6-TRUTH-3's verdict for a positive liability-side movement. Passed in, not
   * re-derived: an issuer credit must not be counted as income, and this module
   * does not own that question.
   */
  liabilityInflowIsIssuerCredit?: boolean;
  /** Set for an InvestmentEvent-sourced row — the paying security. */
  instrumentId?: string | null;
  /** Set for a dividend/interest row whose paying ACCOUNT is known. */
  sourceAccountId?: string | null;
}

export interface IncomeAttribution {
  incomeClass: IncomeClass;
  subtype: IncomeSubtype;
  /** The security that paid a dividend, when evidence names one. */
  instrumentId: string | null;
  /** The account that paid interest, when evidence names one. */
  sourceAccountId: string | null;
  /** Always present — a classification is never silent. */
  reason: string;
}

/**
 * Attribute one inflow to the canonical taxonomy.
 *
 * Precedence, strongest structural evidence first. Provider classification only
 * decides once the structural questions are answered, which is what "provider
 * may support but must not override stronger evidence" means concretely.
 */
export function attributeIncome(e: IncomeEvidence): IncomeAttribution {
  const mk = (subtype: IncomeSubtype, reason: string, extra?: Partial<IncomeAttribution>): IncomeAttribution => ({
    incomeClass: CLASS_OF[subtype], subtype,
    instrumentId: extra?.instrumentId ?? null,
    sourceAccountId: extra?.sourceAccountId ?? null,
    reason,
  });

  // 1. An owned internal transfer is money you already had. Structural, and it
  //    outranks any provider label — a transfer tagged INCOME is still a transfer.
  if (e.isOwnedInternalTransfer === true) {
    return mk("INTERNAL_TRANSFER", "The transfer authority established an owned counterparty, so this is money moving between your own accounts, not new money.");
  }
  // 2. An issuer credit on a liability is not income. v2.6-TRUTH-3 decided it.
  if (e.liabilityInflowIsIssuerCredit === true) {
    return mk("ISSUER_CREDIT", "A positive movement on a liability from a non-payment family is an issuer-originated credit, not income.");
  }
  // 3. A stored REFUND is a reversal of spending, whatever its family says.
  if (e.flowType === "REFUND") {
    return mk("REFUND_REVERSAL", "The row is classified as a refund, which reverses spending rather than adding income.");
  }
  // 4. Income is an inflow. A negative amount is a cost — notably INTEREST
  //    CHARGED on a card, which shares the word "interest" and nothing else.
  if (e.amount < 0) {
    return mk("MISC_INFLOW", "A negative amount is not an inflow; interest CHARGED on a liability is a cost, not interest income.");
  }

  // 5. The provider's DETAIL, where it attests one.
  const detail = (e.providerDetail ?? "").trim();
  const mapped = DETAIL_SUBTYPE[detail];
  if (mapped) {
    // Interest and dividends carry their source when evidence names one.
    if (CLASS_OF[mapped] === "INTEREST_INCOME") {
      return mk(mapped, `The provider attests ${detail}: interest paid by a deposit account, not earned income.`,
        { sourceAccountId: e.sourceAccountId ?? null });
    }
    if (CLASS_OF[mapped] === "DIVIDEND_INCOME") {
      return mk(mapped, `The provider attests ${detail}: a distribution from a holding, not earned income.`,
        { instrumentId: e.instrumentId ?? null, sourceAccountId: e.sourceAccountId ?? null });
    }
    return mk(mapped, `The provider attests ${detail}.`);
  }

  // 6. A dividend sourced from investment activity names its security directly.
  if (e.instrumentId) {
    return mk("SECURITY_DIVIDEND", "An investment event attributed this distribution to a specific holding.",
      { instrumentId: e.instrumentId, sourceAccountId: e.sourceAccountId ?? null });
  }

  // 7. Nothing attested. UNKNOWN is preserved rather than guessed — and it is
  //    OTHER_INCOME, never EARNED_INCOME.
  return mk("UNRESOLVED_INCOME", "No provider classification and no structural evidence, so the source of this inflow is not established.");
}

/** A canonical rollup. Broad income is the SUM of its parts, by construction. */
export interface IncomeBreakdown {
  broad: number;
  earned: number;
  interest: number;
  dividends: number;
  other: number;
  /** Inflows deliberately EXCLUDED, so the exclusion is visible not silent. */
  excluded: number;
  counts: Record<IncomeClass, number>;
}

/**
 * Fold attributed rows into the canonical rollup.
 *
 * `broad = earned + interest + dividends + other` holds by construction — the
 * total is computed FROM the parts, never alongside them, so a surface cannot
 * show a headline that disagrees with its own breakdown.
 */
export function foldIncome(
  rows: readonly { amount: number; attribution: IncomeAttribution }[],
): IncomeBreakdown {
  const b: IncomeBreakdown = {
    broad: 0, earned: 0, interest: 0, dividends: 0, other: 0, excluded: 0,
    counts: { EARNED_INCOME: 0, INTEREST_INCOME: 0, DIVIDEND_INCOME: 0, OTHER_INCOME: 0, NOT_INCOME: 0 },
  };
  for (const r of rows) {
    const c = r.attribution.incomeClass;
    b.counts[c]++;
    switch (c) {
      case "EARNED_INCOME":   b.earned    += r.amount; break;
      case "INTEREST_INCOME": b.interest  += r.amount; break;
      case "DIVIDEND_INCOME": b.dividends += r.amount; break;
      case "OTHER_INCOME":    b.other     += r.amount; break;
      case "NOT_INCOME":      b.excluded  += r.amount; break;
    }
  }
  b.broad = b.earned + b.interest + b.dividends + b.other;
  return b;
}

/** Presentation wording. One place; React composes nothing. */
export const INCOME_CLASS_LABEL: Record<IncomeClass, string> = {
  EARNED_INCOME:   "Earned income",
  INTEREST_INCOME: "Interest",
  DIVIDEND_INCOME: "Dividends",
  OTHER_INCOME:    "Other income",
  NOT_INCOME:      "Not income",
};

export const INCOME_SUBTYPE_LABEL: Record<IncomeSubtype, string> = {
  SALARY: "Salary", WAGES: "Wages", CONTRACT: "Contract & freelance", BUSINESS: "Business income",
  DEPOSIT_INTEREST: "Deposit interest", CASH_SWEEP_INTEREST: "Cash-sweep interest",
  SECURITY_DIVIDEND: "Security dividend", FUND_DISTRIBUTION: "Fund distribution",
  REWARDS_AS_INCOME: "Rewards", MISC_INFLOW: "Miscellaneous inflow", UNRESOLVED_INCOME: "Unresolved income",
  INTERNAL_TRANSFER: "Internal transfer", REFUND_REVERSAL: "Refund", ISSUER_CREDIT: "Issuer credit",
  LOAN_PROCEEDS: "Loan proceeds", SALE_PROCEEDS: "Sale proceeds", CAPITAL_CONTRIBUTION: "Capital contribution",
};
