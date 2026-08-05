/**
 * lib/transactions/liability-inflow.ts   (v2.6-TRUTH-3)
 *
 * THE canonical answer to exactly one question:
 *
 *     May this positive liability-side movement be asserted as a DEBT PAYMENT?
 *
 * Pure: no DB, no React, no clock, no provider vocabulary beyond a family name
 * the caller supplies. Derived only — nothing is written.
 *
 * ── The false rule this replaces ────────────────────────────────────────────
 *
 * `maturityForEvidence` said: money INTO a liability is a debt payment, full
 * stop. That is true of a payment and false of everything else that lands on a
 * card as a positive amount:
 *
 *     POINTS FOR AMEX TRVL          +363.80   rewards redemption
 *     TSA Global Entry Fee Credit   +120.00   issuer statement credit
 *     AplPay Hunger Statio…           +4.00   purchase reversal
 *
 * All three reduce what you owe. None is a payment you made. Filing them as
 * debt payments overstates money you moved toward your debt, which is a
 * Financial Truth error even though the balance arithmetic is unaffected.
 *
 * ── Why the provider family, and not the descriptor ─────────────────────────
 *
 * Measured over all 160 positive-amount rows on liability accounts in the
 * corpus, `pfcPrimary` separates the two populations with ZERO overlap:
 *
 *     LOAN_PAYMENTS         60  ┐ 118 rows — exactly the stored DEBT_PAYMENT set
 *     LOAN_DISBURSEMENTS    58  ┘
 *     OTHER                  7  ┐
 *     GOVERNMENT_AND_NON_…   1  ┘  the 8 disagreements
 *     GENERAL_MERCHANDISE/TRAVEL/FOOD_AND_DRINK/…  22 — already stored REFUND
 *     INCOME 4 · BANK_FEES 1                        — already stored INCOME/INTEREST
 *
 * No merchant string is consulted, deliberately. "POINTS FOR AMEX TRVL" and
 * "Payment Thank You-Mobile" are both Amex-authored descriptors; matching on
 * them would encode one issuer's copywriting as a financial rule, and would
 * silently mis-handle every issuer that words it differently.
 *
 * `LOAN_DISBURSEMENTS` is in the payment set and looks wrong at first glance —
 * a disbursement is money OUT of a loan. Plaid nonetheless files Chase's
 * "Payment Thank You-Mobile" under it, 58 times in this corpus and never once on
 * a non-payment. It is recorded here as an observed provider behaviour rather
 * than a semantic endorsement; see PAYMENT_FAMILIES.
 *
 * ── What this authority deliberately does NOT do ────────────────────────────
 *
 * It answers only the debt-payment question. It never re-labels a row that is
 * already classified as something else — INCOME, INTEREST, REFUND, SPENDING.
 * Those rows never reach it, because `isTransferCandidate` excludes them from
 * the transfer corpus entirely, and a standing test pins that.
 */

/** Can this positive liability-side movement be asserted as a debt payment? */
export type LiabilityInflowVerdict =
  /** Yes — the provider attests a payment family, or an owned funding leg proves it. */
  | "YES"
  /** No — the provider attests a family that is not a payment. */
  | "NO"
  /** No usable family evidence and no owned-counterparty proof. NOT a "no", and
   *  emphatically not a "yes": the claim simply is not available. */
  | "UNDETERMINED";

/**
 * Provider families that attest a CUSTOMER PAYMENT to a liability.
 *
 * Provider-neutral by contract: the caller passes whatever its adapter produced.
 * These two names happen to be Plaid's `personal_finance_category.primary`
 * values; another provider's adapter maps its own vocabulary onto the same set.
 */
export const PAYMENT_FAMILIES: ReadonlySet<string> = new Set([
  "LOAN_PAYMENTS",
  "LOAN_DISBURSEMENTS",
]);

/**
 * Families that attest a MOVEMENT but not its ORIGIN — so they answer neither
 * way.
 *
 * `TRANSFER_IN` on a card says money arrived by transfer. That is not an issuer
 * credit (an issuer does not "transfer in" a rewards redemption), but neither
 * does it prove the customer funded it. Reading it as NO would file a branch
 * cash payment as a statement credit; reading it as YES would resurrect the
 * assumption this authority exists to remove. UNDETERMINED is the honest answer,
 * and an owned funding leg can still lift it to YES.
 *
 * The corpus contains ZERO liability inflows in these families today, so this is
 * a forward guard rather than a measured population — recorded as such rather
 * than dressed up as evidence.
 */
export const NON_ATTESTING_FAMILIES: ReadonlySet<string> = new Set([
  "TRANSFER_IN",
  "TRANSFER_OUT",
]);

export interface LiabilityInflowEvidence {
  /**
   * The provider's classification FAMILY for this row (Plaid's
   * `personal_finance_category.primary`). Null when the provider gave none.
   */
  providerFamily: string | null | undefined;
  /**
   * A counterparty account id persisted on the row — a provider-confirmed or
   * previously-approved link. Its mere existence proves the money came from an
   * account the customer owns, which is a customer-funded payment.
   */
  persistedCounterpartyAccountId?: string | null;
  /**
   * True when the canonical transfer authority reached ACCOUNT_CERTAIN for this
   * row — a MUTUALLY deterministic owned funding leg. Supplied by the caller
   * from `DestinationEvidence.persistableCounterparty`; this module never
   * re-derives matching.
   */
  hasMutuallyMatchedOwnedCounterparty?: boolean;
}

export interface LiabilityInflowResolution {
  verdict: LiabilityInflowVerdict;
  /** Always present, so a refusal is never silent. */
  reason: string;
}

/**
 * Resolve whether a positive liability-side movement is a customer payment.
 *
 * Precedence, and why:
 *   1. An OWNED funding leg outranks the family. If the money demonstrably came
 *      from an account the customer owns, it is a payment they made, whatever
 *      the provider filed it under. This is evidence about the movement itself,
 *      not a label applied to it.
 *   2. Otherwise the attested family decides.
 *   3. Otherwise UNDETERMINED — and the caller must not force a debt payment.
 */
export function liabilityInflowIsCustomerPayment(
  e: LiabilityInflowEvidence,
): LiabilityInflowResolution {
  if (e.persistedCounterpartyAccountId != null) {
    return {
      verdict: "YES",
      reason: "A persisted counterparty names the owned account this money came from, so it is a payment the customer funded.",
    };
  }
  if (e.hasMutuallyMatchedOwnedCounterparty === true) {
    return {
      verdict: "YES",
      reason: "The transfer authority matched a mutually deterministic owned funding leg, so the money came from an account the customer owns.",
    };
  }

  const family = (e.providerFamily ?? "").trim();
  if (family === "") {
    return {
      verdict: "UNDETERMINED",
      reason: "The provider attested no classification family and no owned funding leg was matched, so whether this is a payment cannot be established — and is not assumed.",
    };
  }
  if (PAYMENT_FAMILIES.has(family)) {
    return {
      verdict: "YES",
      reason: `The provider attests the ${family} family, which names a payment to a liability.`,
    };
  }
  if (NON_ATTESTING_FAMILIES.has(family)) {
    return {
      verdict: "UNDETERMINED",
      reason: `The provider attests the ${family} family, which names how the money moved but not where it came from, and no owned funding leg was matched — so this is neither established as a payment nor as an issuer credit.`,
    };
  }
  return {
    verdict: "NO",
    reason: `The provider attests the ${family} family, which is not a payment: money arriving at a liability from a non-payment family is an issuer-originated credit (rewards, a statement credit, a fee reimbursement or a purchase reversal), not money the customer moved toward the debt.`,
  };
}
