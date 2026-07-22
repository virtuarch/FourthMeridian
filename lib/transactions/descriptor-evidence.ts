/**
 * lib/transactions/descriptor-evidence.ts
 *
 * SR-2 — deterministic DESCRIPTOR-EVIDENCE category resolution, run at the
 * ingesting seams BEFORE classifyFlow.
 *
 * ── Where this sits in the pipeline ──────────────────────────────────────────
 *     descriptor evidence  (merchant + description text)
 *             ↓  THIS MODULE (+ liability-payment.ts, the sibling rescue)
 *     category resolution  (Other → Income / Payment / …)
 *             ↓
 *     classifyFlow()       (lib/transactions/flow-classifier.ts — descriptor-BLIND)
 *             ↓
 *     economic semantics   (flowType / flowDirection)
 *
 * The flow classifier is descriptor-blind by contract; a descriptor rule that
 * decides "this positive Other is actually income" belongs HERE, in the category
 * layer, so ONE decision produces both the persisted `category` and the
 * `flowType` that follows from it (never category='Other' beside a rescued
 * flowType). This mirrors, and deliberately reuses, the card-payment rescue in
 * lib/transactions/liability-payment.ts — same philosophy:
 *   • RESCUE-ONLY: acts ONLY on the "Other" sentinel, never downgrades or
 *     overrides a category a provider or a user decided.
 *   • PROMOTE-FROM-UNKNOWN: the only movement is Other → a real category.
 *   • Word-boundary matching over NORMALIZED descriptors (the primitives are
 *     imported from liability-payment.ts, not re-implemented).
 *
 * ── Zero Prisma dependency ───────────────────────────────────────────────────
 * Like resolveLiabilityPaymentCategory, the caller supplies the concrete
 * TransactionCategory value (`incomeCategory`) rather than this module naming the
 * enum, so the module stays runnable under plain `tsx` and the call site stays
 * fully type-checked (T is inferred as TransactionCategory).
 */

import { descriptorWords, containsPhrase } from "./liability-payment";

/**
 * The only category the resolver may overwrite — the same "provider told us
 * nothing" sentinel liability-payment.ts and flow-classifier.ts key on.
 */
const UNRESOLVED_CATEGORY = "Other";

/**
 * ATTESTED payroll / earned-income descriptor phrases. Word-boundary matched
 * against the normalized merchant + description text.
 *
 * Scope discipline (mirrors CARD_PAYMENT_DESCRIPTORS): these are the phrases a
 * PAYROLL / DIRECT-DEPOSIT credit actually carries. They are matched only on a
 * POSITIVE amount (an inflow), so an outbound row carrying "payroll" in its text
 * (a deduction, a garnishment) can never be promoted to income by the sign guard
 * alone — and the explicit negative vocabulary below rejects the rare positive
 * "payroll deduction/tax reversal" as well.
 *
 * COVERAGE DELIBERATELY CONSERVATIVE: a bare "PPD" ACH rail token is NOT here —
 * a PPD credit is not necessarily income (it is also how bill payments and
 * transfers move), so promoting on the rail alone would re-introduce a
 * fabrication of a different kind. Only descriptors that NAME earned income
 * rescue. When real institution descriptors arrive that these miss, add the
 * phrase they actually use and pin it in descriptor-evidence.test.ts.
 */
export const PAYROLL_INCOME_DESCRIPTORS: readonly string[] = [
  "payroll",         // "VECTRUS SYSTEMS PAYROLL", "ACME CORP PAYROLL SEC PPD"
  "direct dep",      // abbreviated "DIRECT DEP" (exact word match, so it needs the token "dep")
  "direct deposit",  // spelled-out "COMPANY DIRECT DEPOSIT" — a separate entry: "dep" ≠ "deposit"
  "salary",          // "MONTHLY SALARY"
];

/**
 * Phrases that VETO a payroll rescue even when a payroll word is present and the
 * amount is positive. A "payroll deduction" or "payroll tax" is a WITHHOLDING,
 * not earned income; it is normally an outflow (rejected by the inflow guard),
 * but a positive-signed deduction reversal must not be mislabeled income either.
 */
const PAYROLL_NEGATIVE_DESCRIPTORS: readonly string[] = [
  "deduction",
  "tax",
  "garnish",
  "garnishment",
];

/** Evidence for the payroll rescue. FM sign convention: amount > 0 = money IN. */
export interface PayrollIncomeEvidence {
  /** FM sign convention: + into the row's own account, − out of it. */
  amount:      number;
  /** Plaid enriched merchant name (or raw fallback). */
  merchant:    string | null;
  /** Raw issuer descriptor (Plaid txn.name / CSV description). */
  description: string | null;
}

/**
 * True when the combined merchant + description evidence attests earned income
 * on an INFLOW. Both fields are searched together (they differ on ~50% of rows —
 * see isCardPaymentDescriptor for the same combined-evidence contract), and the
 * negative vocabulary vetoes withholdings.
 *
 * Descriptor-only — NOT sufficient to classify on its own. It MUST be combined
 * with the amount > 0 guard in resolvePayrollIncomeCategory, exactly as the
 * card-payment predicate is combined with the liability + positive-sign guard.
 */
export function isPayrollIncomeDescriptor(
  merchant: string | null | undefined,
  name?: string | null | undefined,
): boolean {
  const words = descriptorWords(`${merchant ?? ""} ${name ?? ""}`);
  if (words.length === 0) return false;
  if (PAYROLL_NEGATIVE_DESCRIPTORS.some((token) => containsPhrase(words, token))) return false;
  return PAYROLL_INCOME_DESCRIPTORS.some((token) => containsPhrase(words, token));
}

/**
 * SINGLE authority for "should this row's category be rescued to Income on
 * payroll descriptor evidence?".
 *
 * RESCUE-ONLY by construction — returns `category` UNCHANGED unless it is the
 * unresolved sentinel AND the amount is a positive inflow AND the descriptor
 * attests earned income. It can therefore never contradict a provider category,
 * never overwrite a user override/rule (those never carry the Other sentinel),
 * and never flip an outflow. After the rescue, classifyFlow maps the resulting
 * `Income` category → INCOME with no classifier change and no special payroll
 * flow type.
 *
 * `incomeCategory` is supplied by the caller (the TransactionCategory `Income`
 * value) so this module stays Prisma-free — same contract as
 * resolveLiabilityPaymentCategory.
 */
export function resolvePayrollIncomeCategory<T extends string>(
  category: T,
  incomeCategory: T,
  evidence: PayrollIncomeEvidence,
): T {
  if (category !== UNRESOLVED_CATEGORY) return category;
  if (!(evidence.amount > 0)) return category; // inflow guard — payroll is money IN
  return isPayrollIncomeDescriptor(evidence.merchant, evidence.description)
    ? incomeCategory
    : category;
}
