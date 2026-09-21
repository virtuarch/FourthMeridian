/**
 * lib/transactions/category-vocabulary.ts — FM-AUDIT-003 / FM-AUDIT-005
 *
 * THE ONE CATEGORY VOCABULARY: for every `TransactionCategory`, whether it is a
 * spending line at all, whether ingestion can actually PRODUCE it, and what it
 * really contains. Provider taxonomy, the stored enum, the Cash Flow category
 * list, the AI's category lines, `measure_flows`, and (later) S1's category-rate
 * transforms all read this — so they cannot silently diverge.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * The enum has Groceries, Medical, Entertainment, Transport, PersonalCare,
 * Services and Education. Bank sync (lib/transactions/plaid-category.ts and the
 * merchant resolver) never writes any of them: Plaid FOOD_AND_DRINK — groceries
 * included — becomes Dining, and MEDICAL, TRANSPORTATION, ENTERTAINMENT,
 * PERSONAL_CARE, GENERAL_SERVICES, HOME_IMPROVEMENT and GOVERNMENT fall to
 * Other. Yet `measure_flows` advertised "Groceries, … Medical, Entertainment,
 * Transport", and a category with no rows measured as a real $0.00 at observed
 * completeness — a confident, false answer to "how much did I spend on
 * groceries?". A measure of a category the ledger cannot identify is not zero;
 * it is UNAVAILABLE.
 *
 * ── OBSERVABILITY ───────────────────────────────────────────────────────────
 *   SUPPORTED    bank sync produces it; it means what its name says.
 *   DERIVED      bank sync produces it, but as a provider bucket whose contents
 *                differ from the name (Dining holds groceries; Utilities holds
 *                rent; Other is the residual of seven Plaid primaries). Measurable
 *                — and every surface that measures it states `meaning`.
 *   UNSUPPORTED  bank sync never produces it. Rows can carry the label only from a
 *                CSV import or a manual correction, so no total over it is a
 *                measure of the user's spending on that thing. Refused, by name.
 *
 * ── ROLE ────────────────────────────────────────────────────────────────────
 * SPENDING categories are the only valid keys of the category-spend ledger.
 * NOT_SPENDING labels (Income, Transfer, Payment, investment activity) name a
 * STRUCTURE, not a thing bought; a cost/refund row that still carries one — a
 * card purchase the classifier vetoed out of "Payment" (CCPAY-2B), a Transfer-
 * labelled charge (CF-4) — is spending the vocabulary cannot place, and the
 * ledger files it under Other rather than inventing a "Payment" spending line
 * (`spendCategoryKey`). Membership in spending is still the classifier's flow
 * verdict (lib/transactions/cash-flow.ts `economicSideOf`); this module only
 * decides which LINE a spending row lands on.
 *
 * ⚠️ Enum additions (and a future PFC-detailed producer for Groceries etc.) change
 * a category's observability HERE, in one place — and nowhere else.
 *
 * Pure. No I/O.
 */

import type { TransactionCategory } from "@prisma/client";

export type CategoryRole = "SPENDING" | "NOT_SPENDING";
export type CategoryObservability = "SUPPORTED" | "DERIVED" | "UNSUPPORTED";

export interface CategoryDefinition {
  role: CategoryRole;
  /** Meaningful only for SPENDING categories. */
  observability: CategoryObservability;
  /** What the line actually contains — stated by every surface that measures it. */
  meaning: string;
  /**
   * S1 — set when a line is MEASURABLE but its future is determined by another
   * model, so a spending change must not transform it. The value names that model.
   */
  governedBy?: string;
}

const spend = (observability: CategoryObservability, meaning: string, governedBy?: string): CategoryDefinition =>
  ({ role: "SPENDING", observability, meaning, ...(governedBy ? { governedBy } : {}) });
const structural = (meaning: string): CategoryDefinition =>
  ({ role: "NOT_SPENDING", observability: "SUPPORTED", meaning });

/** Every TransactionCategory, classified. `satisfies` makes a new enum value a compile error here. */
export const CATEGORY_VOCABULARY = {
  Dining:        spend("DERIVED", "Plaid FOOD_AND_DRINK — restaurants AND groceries (bank sync does not separate groceries), plus curated food-merchant rules"),
  Shopping:      spend("DERIVED", "Plaid GENERAL_MERCHANDISE plus curated retail-merchant rules"),
  Utilities:     spend("DERIVED", "Plaid RENT_AND_UTILITIES — utilities AND rent"),
  Travel:        spend("SUPPORTED", "Plaid TRAVEL plus curated travel / ride-hailing merchant rules"),
  Subscriptions: spend("DERIVED", "only merchants on the curated subscription allowlist; other recurring charges stay in their own spend bucket"),
  Fee:           spend("SUPPORTED", "bank and card fees (Plaid BANK_FEES); fee rebates and reversals reduce it"),
  Interest:      spend("SUPPORTED", "interest charged on liabilities; interest reversals reduce it",
    "the debt it is charged on — future interest follows the balance and its rate, which a scenario's `liabilityAssumptions` and debt payments change"),
  Other:         spend("DERIVED", "the residual: every spend bucket without its own line — medical, transportation, entertainment, personal care, general services, home improvement, government — plus spending the vocabulary cannot place"),
  Groceries:     spend("UNSUPPORTED", "not separated by bank sync — Plaid files groceries under FOOD_AND_DRINK, i.e. Dining; only CSV imports or manual corrections carry this label"),
  Medical:       spend("UNSUPPORTED", "not produced by bank sync — medical spending is inside Other"),
  Entertainment: spend("UNSUPPORTED", "not produced by bank sync — entertainment spending is inside Other"),
  Transport:     spend("UNSUPPORTED", "not produced by bank sync — transportation spending is inside Other (ride-hailing may be under Travel)"),
  PersonalCare:  spend("UNSUPPORTED", "not produced by bank sync — personal-care spending is inside Other"),
  Services:      spend("UNSUPPORTED", "not produced by bank sync — general-services spending is inside Other"),
  Education:     spend("UNSUPPORTED", "not produced by bank sync — education spending is inside Other"),
  Income:        structural("income deposits — measured by the income measure, never a spending line"),
  Transfer:      structural("movements between own accounts — never spending"),
  Payment:       structural("payments toward liabilities — never spending (the purchases they settle already are)"),
  Buy:           structural("investment purchase — security activity, not spending"),
  Sell:          structural("investment sale — security activity, not spending"),
  Dividend:      structural("dividend received — income, not spending"),
  Split:         structural("stock split — security activity, not spending"),
} as const satisfies Record<TransactionCategory, CategoryDefinition>;

export type KnownCategory = keyof typeof CATEGORY_VOCABULARY;

export function categoryDefinition(category: string): CategoryDefinition | null {
  return (CATEGORY_VOCABULARY as Record<string, CategoryDefinition>)[category] ?? null;
}

/** The residual line every unplaceable spending row lands on. */
export const RESIDUAL_SPEND_CATEGORY = "Other" as const;

/**
 * The spending LINE a cost/refund row belongs to. A SPENDING-role label is kept;
 * a structural label (or an unknown one) on a spending row is filed under Other —
 * the row IS spending (the classifier said so), the label just cannot name what
 * was bought.
 */
export function spendCategoryKey(storedCategory: string | null | undefined): string {
  const def = storedCategory ? categoryDefinition(storedCategory) : null;
  return def?.role === "SPENDING" ? storedCategory! : RESIDUAL_SPEND_CATEGORY;
}

/** Categories that can be MEASURED (and later transformed): SPENDING and not UNSUPPORTED. */
export function isMeasurableSpendCategory(category: string): boolean {
  const def = categoryDefinition(category);
  return def !== null && def.role === "SPENDING" && def.observability !== "UNSUPPORTED";
}

export const MEASURABLE_SPEND_CATEGORIES: readonly string[] =
  Object.keys(CATEGORY_VOCABULARY).filter(isMeasurableSpendCategory);

/**
 * S1 — whether a spending change may TRANSFORM this line: measurable, AND not a
 * line whose future another model owns. Measurable is necessary, never sufficient:
 * Interest is measured exactly and is still refused, because "cut my interest 50%"
 * is a statement about a debt's balance and rate, and a spending rule applied to it
 * would move money the liability ledger already accrues on its own.
 */
export function isTransformableSpendCategory(category: string): boolean {
  return isMeasurableSpendCategory(category) && !categoryDefinition(category)!.governedBy;
}

export const TRANSFORMABLE_SPEND_CATEGORIES: readonly string[] =
  Object.keys(CATEGORY_VOCABULARY).filter(isTransformableSpendCategory);

export const UNSUPPORTED_SPEND_CATEGORIES: readonly string[] =
  Object.entries(CATEGORY_VOCABULARY).filter(([, d]) => d.role === "SPENDING" && d.observability === "UNSUPPORTED").map(([c]) => c);

export const NOT_SPENDING_CATEGORIES: readonly string[] =
  Object.entries(CATEGORY_VOCABULARY).filter(([, d]) => d.role === "NOT_SPENDING").map(([c]) => c);

export type SpendCategoryResolution =
  | { ok: true; category: string; observability: "SUPPORTED" | "DERIVED"; meaning: string }
  | { ok: false; category?: string; reason: "NOT_SPENDING" | "UNSUPPORTED" | "UNKNOWN"; unavailable: string };

/**
 * Resolve a category someone asked about (a tool argument, an S1 transform) to a
 * measurable spending line — or a refusal that says WHY and where the money is.
 * Case/space/underscore-insensitive.
 */
export function resolveSpendCategory(raw: string): SpendCategoryResolution {
  const wanted = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const hit = Object.keys(CATEGORY_VOCABULARY).find((c) => c.toLowerCase() === wanted);
  if (!hit) {
    return { ok: false, reason: "UNKNOWN",
      unavailable: `unknown category "${raw}"; measurable spending categories are ${MEASURABLE_SPEND_CATEGORIES.join(", ")}` };
  }
  const def = categoryDefinition(hit)!;
  if (def.role === "NOT_SPENDING") {
    return { ok: false, category: hit, reason: "NOT_SPENDING",
      unavailable: `${hit} is not a spending category (${def.meaning}); measurable spending categories are ${MEASURABLE_SPEND_CATEGORIES.join(", ")}` };
  }
  if (def.observability === "UNSUPPORTED") {
    return { ok: false, category: hit, reason: "UNSUPPORTED",
      unavailable: `${hit} is not tracked — ${def.meaning}. No figure for it would be a measure of this spending, so none is given.` };
  }
  return { ok: true, category: hit, observability: def.observability, meaning: def.meaning };
}
