/**
 * lib/transactions/plaid-category.ts
 *
 * Pure, deterministic Plaid → TransactionCategory mapping.
 *
 * Extracted verbatim (then extended) from lib/plaid/syncTransactions.ts so it
 * can be unit-tested WITHOUT importing Prisma, the db client, or the Plaid API
 * client — mirroring the dependency-free extraction pattern of
 * lib/transactions/fingerprint.ts, merchant.ts, and plaid-flow-input.ts.
 *
 * ── Zero runtime dependencies ────────────────────────────────────────────────
 * Both imports are TYPE-ONLY (`import type`), so they are erased at compile time
 * and this module pulls in nothing at runtime. TransactionCategory's Prisma type
 * is a string-literal union, so returning the literal values (e.g.
 * "Subscriptions") is fully type-checked while keeping the module — and its tsx
 * test — free of `@prisma/client`, `@/lib/db`, and `@/lib/plaid/client` (the
 * last of which throws at module load when PLAID_* env vars are unset). The test
 * therefore runs with a plain `npx tsx` and needs no `prisma generate`.
 *
 * ── Subscription detection (v2.5 fix) ────────────────────────────────────────
 * The original mapper only produced `Subscriptions` when Plaid's PFC `detailed`
 * contained the token "SUBSCRIPTION". Confirmed against Plaid's published
 * taxonomy CSV (transactions-personal-finance-category-taxonomy.csv, retrieved
 * 2026-07-04): NO PFC detailed value contains that token, so that branch never
 * fired on real Plaid data and streaming/SaaS merchants fell through to
 * Other/Shopping.
 *
 * Detection is deterministic and MERCHANT-ALLOWLIST-DRIVEN (added BEFORE the
 * primary PFC switch). It deliberately does NOT allowlist whole PFC detailed
 * buckets: Plaid folds concerts, movie theaters, sporting events, and one-off
 * music/video purchases into the same ENTERTAINMENT_* detaileds as streaming
 * services, so classifying an entire bucket as Subscriptions would misclassify
 * those one-off purchases. Only merchants on SUBSCRIPTION_MERCHANTS become
 * Subscriptions. Everything else is byte-identical to the original behavior.
 */

import type { TransactionCategory } from "@prisma/client";
import type { Transaction as PlaidTransaction } from "plaid";
import { resolveMerchantCategory } from "@/lib/transactions/merchant-rules";

// Re-export so existing importers (e.g. scripts/reclassify-subscriptions.ts,
// which import isKnownSubscriptionMerchant from this module) keep working
// unchanged after the subscription allowlist moved to merchant-rules.ts —
// the SINGLE source of truth for merchant→category resolution.
export { isKnownSubscriptionMerchant } from "@/lib/transactions/merchant-rules";

/**
 * Input shape for the mapper. Widened from the original
 * Pick<PlaidTransaction, "personal_finance_category" | "category"> to also carry
 * merchant identity (`merchant_name`, `name`) for the deterministic merchant
 * fallback. Still a structural Pick — no new dependency.
 */
export type PlaidCategoryInput = Pick<
  PlaidTransaction,
  "personal_finance_category" | "category" | "merchant_name" | "name"
>;

/**
 * Maps a Plaid transaction's category info to our TransactionCategory enum.
 * Prefers the modern `personal_finance_category` taxonomy; falls back to the
 * legacy `category` string array; defaults to "Other". Never throws — an
 * unrecognized or missing category should never block a transaction import.
 */
export function mapPlaidCategory(txn: PlaidCategoryInput): TransactionCategory {
  const pfc = txn.personal_finance_category;
  if (pfc?.primary) {
    const detailed = pfc.detailed ?? "";

    // 1. Detailed-level overrides — more precise than the primary bucket alone.
    if (detailed.includes("INTEREST")) return "Interest";
    // CC-1: a credit-card payment is a Payment regardless of which primary
    // Plaid happened to tag. Self-identifying and institution-agnostic — this
    // rescues the destination (card-side) legs Plaid sometimes files under a
    // non-LOAN_PAYMENTS primary. (When primary IS LOAN_PAYMENTS this is a no-op,
    // since step 2 already returns Payment.)
    if (detailed.includes("CREDIT_CARD_PAYMENT")) return "Payment";

    // 2. FLOW-STRUCTURAL PFC primaries WIN over merchant rules. A merchant
    //    string must never override income/transfer/loan/fee structure — these
    //    are the flow-critical buckets the FlowType classifier depends on. This
    //    is why the merchant-rule branch (step 3) sits BELOW this switch.
    switch (pfc.primary) {
      case "INCOME":        return "Income";
      case "TRANSFER_IN":
      case "TRANSFER_OUT":  return "Transfer";
      case "LOAN_PAYMENTS": return "Payment";
      case "BANK_FEES":     return "Fee";
    }

    // 3. Global merchant → category rules (Merchant Intelligence Slice 1),
    //    including the folded subscription-brand allowlist. Positioned ABOVE
    //    the spend-bucket switch because Plaid frequently dumps regional/SaaS
    //    merchants into GENERAL_MERCHANDISE / an unmapped primary → Other; a
    //    curated rule is more precise there. Category-only; FlowType stays
    //    downstream in lib/transactions/flow-classifier.ts.
    const byMerchant = resolveMerchantCategory(txn.merchant_name, txn.name);
    if (byMerchant) return byMerchant;

    // 4. Defensive literal-token check. Confirmed to NEVER fire on real Plaid
    //    PFC (no detailed value contains "SUBSCRIPTION"), kept only to preserve
    //    the prior contract.
    if (detailed.includes("SUBSCRIPTION")) return "Subscriptions";

    // 5. Spend-bucket primaries — meaning comes from the PFC bucket.
    switch (pfc.primary) {
      case "FOOD_AND_DRINK":      return "Dining";
      case "GENERAL_MERCHANDISE": return "Shopping";
      case "RENT_AND_UTILITIES":  return "Utilities";
      case "TRAVEL":              return "Travel";
      default:                    return "Other";
    }
  }

  // No PFC at all (older Items / sparse rows): the merchant rules still apply,
  // checked before the legacy category-array fallback.
  const byMerchant = resolveMerchantCategory(txn.merchant_name, txn.name);
  if (byMerchant) return byMerchant;

  // Legacy fallback — Plaid's older `category` array, e.g. ["Food and Drink", "Restaurants"].
  const legacy = txn.category?.[0]?.toLowerCase() ?? "";
  if (legacy.includes("food") || legacy.includes("restaurant")) return "Dining";
  if (legacy.includes("shop"))                                  return "Shopping";
  if (legacy.includes("travel"))                                return "Travel";
  if (legacy.includes("transfer"))                              return "Transfer";
  if (legacy.includes("payment"))                               return "Payment";
  if (legacy.includes("interest"))                              return "Interest";
  if (legacy.includes("payroll") || legacy.includes("deposit")) return "Income";
  if (legacy.includes("utilities") || legacy.includes("rent"))  return "Utilities";
  if (legacy.includes("subscription"))                          return "Subscriptions";

  return "Other";
}

// ─────────────────────────────────────────────────────────────────────────────
// CC-1 — Credit-card payment classification correctness.
//
// The DESTINATION leg of a card payment is a positive credit sitting on the
// card's own account ("Payment Thank You-Mobile"). Plaid tags these
// inconsistently, so some fall through mapPlaidCategory's `default → Other`
// (see docs/investigations/CREDIT_CARD_PAYMENT_CLASSIFICATION_INVESTIGATION.md).
//
// mapPlaidCategory is account-blind and amount-blind, so the safe rescue for
// the Other legs (which carry no useful PFC — only a descriptor) lives at a
// seam that KNOWS the account side and sign: the Plaid sync write path and the
// historical backfill. Both import the SINGLE guarded predicate below so they
// can never drift. This is descriptor + account-side + sign gated — it is NOT a
// merchant rule and deliberately does NOT touch the Merchant Intelligence catalog.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generalized, INSTITUTION-AGNOSTIC card-payment acknowledgment phrases. These
 * are the descriptors issuers put on the card-side payment credit — Chase, Amex,
 * Citi, Discover, etc. all use one of these forms. Deliberately NOT tied to any
 * institution name (no "chase"): the pattern is the payment acknowledgment, not
 * the brand. Lowercased; matched as substrings against `${merchant} ${name}`.
 */
export const CARD_PAYMENT_DESCRIPTORS: readonly string[] = [
  "payment thank you",
  "thank you mobile",   // "Payment Thank You-Mobile"
  "cardmember payment",
  "cardmember serv",    // "CARDMEMBER SERV ... PAYMENT"
  "credit crd autopay",
  "card autopay",
  "autopay payment",
  "online payment",
  "payment received",
  "mobile payment",
  "epayment",
  "e-payment",
];

/**
 * True when either merchant field contains a generalized card-payment
 * descriptor. Descriptor-only — NOT sufficient on its own to classify a payment
 * (an ordinary account can carry "online payment" text); it MUST be combined
 * with the account-side + sign guard in isLiabilityCardPaymentLeg.
 */
export function isCardPaymentDescriptor(
  merchant: string | null | undefined,
  name?: string | null | undefined,
): boolean {
  const haystack = `${merchant ?? ""} ${name ?? ""}`.toLowerCase();
  return CARD_PAYMENT_DESCRIPTORS.some((token) => haystack.includes(token));
}

/** Inputs for the guarded card-payment-leg predicate. FM sign convention: amount > 0 = money into the row's own account. */
export interface CardPaymentLegInput {
  /**
   * FinancialAccount.type (AccountType value). `"debt"` is the PRIMARY liability
   * signal — Plaid `type: "credit"`/`"loan"` maps to AccountType.debt at import
   * (lib/plaid/exchangeToken.ts mapAccountType). This is the field actually
   * populated for Plaid-synced credit cards.
   */
  accountType: string | null | undefined;
  /**
   * FinancialAccount.debtSubtype — a SECONDARY accepted signal. Never populated
   * by the Plaid import path (only the flat legacy column; real debt data lives
   * on DebtProfile), so it is null for Plaid cards — but a non-null value (e.g.
   * a manually-entered liability) is still honored.
   */
  debtSubtype?: string | null | undefined;
  /** FM-signed amount already resolved by the caller. */
  amount:      number;
  merchant:    string | null | undefined;
  name?:       string | null | undefined;
}

/**
 * SINGLE source of truth for "this row is the destination leg of a credit-card
 * payment" — used by BOTH the live sync write path and the historical backfill
 * so they can never diverge.
 *
 * Deterministic guard, all three conditions required:
 *   1. the row sits on a LIABILITY account, AND
 *   2. amount > 0 (a credit INTO that liability — i.e. a payment received), AND
 *   3. the descriptor matches a generalized card-payment phrase.
 *
 * Liability is signalled PRIMARILY by `accountType === "debt"` (the field Plaid
 * actually populates — see CC-1 correction / the debtSubtype diagnosis) and
 * SECONDARILY by a non-null `debtSubtype` (manual liabilities). Either suffices.
 *
 * The liability + positive-sign guard is what prevents ordinary merchant rows
 * (or a checking-account "online payment") from ever being misread as a debt
 * payment, and prevents ANY card PURCHASE (amount < 0) from flipping to Payment.
 */
export function isLiabilityCardPaymentLeg(input: CardPaymentLegInput): boolean {
  const isLiability =
    input.accountType === "debt" ||
    (input.debtSubtype != null && input.debtSubtype !== "");
  return isLiability && input.amount > 0 && isCardPaymentDescriptor(input.merchant, input.name);
}
