/**
 * lib/transactions/needs-classification.ts
 *
 * TE-2B — the canonical "does this transaction genuinely need a human to say what
 * it was?" predicate. Pure, deterministic, provider-neutral, Prisma-free — usable
 * by any future surface (review inbox, AI, Cash Flow) without importing UI or DB.
 *
 * DOCTRINE (earned in the TE-2 / TE-2A investigations):
 *  - This is SEMANTIC ambiguity ("unknown purpose / unknown source"), NOT low
 *    numeric confidence. It must NEVER be equivalent to `confidence <= 0.5`: the
 *    ~1,520 sign-default grocery/restaurant/fuel purchases are known facts (a
 *    resolved merchant + a spend category) and must stay invisible here.
 *  - It surfaces only the two earned clusters:
 *      A. Payment-app movement whose PURPOSE is unknown (Venmo/Zelle/Cash App/…):
 *         Fourth Meridian knows money moved over a payment-app rail but cannot tell
 *         whether it was a purchase, a repayment, a gift, or received income.
 *      B. Inflow with no identifiable SOURCE: money arrived, was recorded as income
 *         only by its sign, and no merchant/source could be resolved.
 *  - No first-class purpose/Assertion model exists yet, so cluster A uses the
 *    narrowest honest proxy: a payment-app rail is attested AND no stronger canonical
 *    meaning exists (i.e. it was not resolved to an owned-account internal transfer).
 *  - Self-healing: a row drops out automatically as Fourth Meridian learns —
 *    owned-account matching (sets a counterparty) resolves A into an internal
 *    transfer; merchant normalization (sets a merchant) resolves B; future
 *    Party/Assertion resolve both. The predicate shrinks toward zero; it never
 *    hard-codes a count or a confidence threshold.
 */

/** Why a transaction needs classification — drives the user-facing wording. */
export type NeedsClassificationReason =
  | "UNKNOWN_PAYMENT_APP_PURPOSE" // A — payment-app rail, purpose unresolved
  | "UNKNOWN_INFLOW_SOURCE";      // B — inflow, no identifiable source

/**
 * The minimal canonical facts the predicate reads. All provider-neutral: the raw
 * values are Fourth Meridian's own enums/booleans, never provider category strings.
 */
export interface NeedsClassificationInput {
  /** Canonical economic kind (FlowType value), e.g. "INCOME" | "TRANSFER" | …. */
  flowType: string | null;
  /** Canonical classifier reason (FlowClassificationReason), e.g. "SIGN_DEFAULT_INFLOW". */
  classificationReason: string | null;
  /** Canonical transfer rail (TransferRail), e.g. "PAYMENT_APP". null when none attested. */
  transferRail: string | null;
  /** True when a Merchant identity was resolved for the row (Transaction.merchantId set). */
  hasResolvedMerchant: boolean;
  /** True when the movement was resolved to an owned counterparty account (an internal
   *  transfer / stronger known meaning). Payment-app peer payments never have one. */
  hasResolvedCounterparty: boolean;
}

export interface NeedsClassificationResult {
  needsClassification: boolean;
  /** The specific reason when true; null when false. */
  reason: NeedsClassificationReason | null;
}

const NOT_NEEDED: NeedsClassificationResult = { needsClassification: false, reason: null };

/**
 * Decide whether a transaction should be surfaced as needing human classification.
 * Pure and total — same input → same output, never throws.
 */
export function shouldSurfaceAsNeedsClassification(tx: NeedsClassificationInput): NeedsClassificationResult {
  // A — payment-app movement, purpose unknown. A payment-app rail is attested, but
  // the movement was NOT resolved to an owned-account internal transfer, so no
  // stronger economic meaning exists. We claim only "money moved, purpose unknown".
  if (tx.transferRail === "PAYMENT_APP" && !tx.hasResolvedCounterparty) {
    return { needsClassification: true, reason: "UNKNOWN_PAYMENT_APP_PURPOSE" };
  }

  // B — inflow with no identifiable source: recorded as income by SIGN ONLY, with
  // no resolved merchant. Identified income, refunds, and merchant-resolved inflows
  // are excluded because their source/nature is known.
  if (
    tx.flowType === "INCOME" &&
    tx.classificationReason === "SIGN_DEFAULT_INFLOW" &&
    !tx.hasResolvedMerchant
  ) {
    return { needsClassification: true, reason: "UNKNOWN_INFLOW_SOURCE" };
  }

  return NOT_NEEDED;
}
