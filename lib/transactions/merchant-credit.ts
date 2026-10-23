/**
 * lib/transactions/merchant-credit.ts   (REFUND-1)
 *
 * THE canonical answer to exactly one question:
 *
 *     A credit landed on a LIABILITY account and the provider called it INCOME.
 *     It cannot be income. Which spend category, if any, does it reverse?
 *
 * Pure: no DB, no React, no clock, no descriptor matching. The caller supplies
 * the evidence; this module only decides.
 *
 * ── Where this sits ──────────────────────────────────────────────────────────
 *
 *     provider category          (mapPlaidCategory: PFC INCOME → "Income")
 *             ↓  THIS MODULE — sibling of liability-payment.ts / descriptor-evidence.ts
 *     category resolution        ("Income" on a card → Travel | … | Other)
 *             ↓
 *     classifyFlow()             (REFUND-1 veto: liability inflow is never INCOME;
 *                                 genuine spend category ⇒ REFUND, else UNKNOWN)
 *             ↓
 *     the ONE economic fold      (foldEconomicRow / outflowByCategory — refunds
 *                                 net their category; nothing downstream changes)
 *
 * One decision produces BOTH persisted columns (`category` and, through the
 * classifier, `flowType`) — the same layering CCPAY-2C and SR-2 established.
 *
 * ── The defect, measured (live corpus, 2026-09-20) ───────────────────────────
 *
 * Plaid's personal_finance_category models "a merchant paid this person" as
 * INCOME and picks the detail from the BRAND: Airbnb → INCOME_RENTAL, Uber →
 * INCOME_GIG_ECONOMY. On a depository account that can be right. On a credit
 * card it is a refund:
 *
 *     2026-09-09  AIRBNB * HMEZRPZZYQ   −1,098.88   TRAVEL_LODGING   Travel / SPENDING
 *     2026-09-14  AIRBNB * HMEZRPZZYQ     +339.96   INCOME_RENTAL    Income / INCOME   ← refund
 *     2026-09-14  AIRBNB * HMT3XASAMQ     −732.48   TRAVEL_LODGING   Travel / SPENDING
 *     2026-09-18  AIRBNB * HMT3XASAMQ     +521.34   INCOME_RENTAL    Income / INCOME   ← refund
 *
 * Travel read $1,831.36 of Airbnb where $970.06 was spent. Six such rows exist
 * ($1,356.95). Plaid's transaction object has NO refund flag and NO
 * original-transaction reference; `transaction_code` (which can say
 * "adjustment") is populated for European institutions only and left no trace
 * on these rows (their derived paymentMethod is UNKNOWN). The only explicit
 * relationship Plaid gives is `pending_transaction_id`, which links a refund to
 * its OWN pending observation, never to the purchase.
 *
 * ── What is ESTABLISHED, and what is only ATTRIBUTED ─────────────────────────
 *
 *   ESTABLISHED (structural, certain):  the row is not income. A liability
 *     account cannot receive earnings. This needs no merchant evidence at all and
 *     is enforced in the classifier, not here.
 *
 *   ATTRIBUTED (evidence, conservative): WHICH category the credit reverses.
 *     The provider's family is void (it said INCOME), so the category comes from
 *     the one thing the ledger itself knows: what this cardholder buys from this
 *     merchant ON THIS ACCOUNT. If every prior purchase from the same merchant on
 *     the same account sits in ONE genuine spend category, the credit reverses
 *     that category. This is exactly the inference the provider makes for an
 *     ordinary refund (a positive TRAVEL_LODGING row is labelled from the merchant,
 *     not from a link to the booking) — applied where the provider's own label
 *     is structurally impossible.
 *
 * ⚠️ CATEGORY-LEVEL NETTING, NOT PURCHASE PAIRING. No refund is linked to a
 * specific purchase, no amount is compared, no date window is searched. The
 * evidence cannot support pairing (one Airbnb booking code is shared by a charge
 * and its refund, but HUNGERSTATION's refund shares its descriptor with fourteen
 * purchases), and category netting does not need it.
 *
 * ⚠️ NOT "same merchant + positive amount = refund". Merchant history never
 * decides that a row IS a refund — the account structure and the provider family
 * did that. History only chooses the category, requires UNANIMITY, and falls back
 * to `Other` (⇒ the classifier's honest UNKNOWN valve: excluded from income AND
 * from refunds) whenever it is silent or split:
 *
 *     no prior purchases on this account        → Other
 *     prior purchases in two spend categories   → Other
 *     prior purchases only in `Other`           → Other   (EasyTime +151.73,
 *                                                          MICROSOFT +280.45)
 *
 * Measured over the six live rows: Airbnb ×2 → Travel (10 prior purchases, all
 * Travel), Uber → Travel (72), HUNGERSTATION → Dining (14); EasyTime and
 * MICROSOFT → Other. $924.77 attributed, $432.18 left honestly unattributed.
 *
 * RESCUE-ONLY by construction: acts on nothing but the `Income` claim on a
 * liability inflow. It never touches a purchase, a payment, a depository
 * deposit, or a category a user corrected (the ingest seam preserves
 * USER_OVERRIDE / USER_RULE before this value is written).
 */

import { isLiabilityInflow, type LiabilityMovementInput } from "./liability-payment";
import { isGenuineSpendCategory } from "./flow-classifier";

/** How the category was reached. Recorded so a repair / audit can say why. */
export type MerchantCreditBasis =
  /** Not a liability inflow claimed as income — nothing to decide. */
  | "NOT_APPLICABLE"
  /** Every prior purchase from this merchant on this account shares one spend category. */
  | "MERCHANT_SPEND_HISTORY_UNANIMOUS"
  /** No prior purchase from this merchant on this account. */
  | "NO_MERCHANT_SPEND_HISTORY"
  /** Prior purchases span more than one category, or only the unresolved one. */
  | "MERCHANT_SPEND_HISTORY_NOT_DECISIVE";

export interface MerchantCreditEvidence extends LiabilityMovementInput {
  /**
   * The categories of the SAME merchant's PRIOR PURCHASES on the SAME account —
   * one entry per purchase (duplicates expected), as the caller read them:
   * active rows, amount < 0, classified SPENDING, dated on or before the credit.
   *
   * "Same merchant" is the caller's identity evidence, by EXACT equality only:
   * the provider's stable merchant entity id, the stored merchant name, or the
   * raw issuer descriptor (merchant-credit-evidence.ts). Never a fuzzy match —
   * unanimity below is only meaningful over an exact set.
   */
  priorPurchaseCategories: readonly string[];
}

export interface MerchantCreditResolution<T extends string> {
  category: T;
  basis: MerchantCreditBasis;
}

/**
 * Resolve the category of a liability inflow the provider filed as income.
 *
 * `incomeCategory` / `unresolvedCategory` are supplied by the caller for the same
 * reason resolveLiabilityPaymentCategory takes `paymentCategory`: this module is
 * Prisma-free, and the generic keeps the call site type-checked against the real
 * TransactionCategory enum.
 */
export function resolveLiabilityMerchantCreditCategory<T extends string>(
  category: T,
  incomeCategory: T,
  unresolvedCategory: T,
  evidence: MerchantCreditEvidence,
): MerchantCreditResolution<T> {
  if (category !== incomeCategory || !isLiabilityInflow(evidence)) {
    return { category, basis: "NOT_APPLICABLE" };
  }
  const prior = evidence.priorPurchaseCategories;
  if (prior.length === 0) {
    return { category: unresolvedCategory, basis: "NO_MERCHANT_SPEND_HISTORY" };
  }
  const distinct = new Set(prior);
  const only = distinct.size === 1 ? prior[0] : null;
  if (only !== null && isGenuineSpendCategory(only)) {
    return { category: only as T, basis: "MERCHANT_SPEND_HISTORY_UNANIMOUS" };
  }
  return { category: unresolvedCategory, basis: "MERCHANT_SPEND_HISTORY_NOT_DECISIVE" };
}

/**
 * Whether a row needs the evidence read at all. The ingest seam calls this FIRST
 * so the (rare) history query runs only for the population it can affect — six
 * rows in 4,400 — and never on a purchase, a payment or a depository deposit.
 */
export function needsMerchantCreditEvidence<T extends string>(
  category: T,
  incomeCategory: T,
  movement: LiabilityMovementInput,
): boolean {
  return category === incomeCategory && isLiabilityInflow(movement);
}
