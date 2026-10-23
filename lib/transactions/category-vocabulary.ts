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

// ── S1 — what a spending CHANGE may be applied to ───────────────────────────

/**
 * What a transformable line MEANS when a change is applied to it:
 *   DIRECT        it is what its name says (SUPPORTED: Travel, Fee);
 *   WHOLE_BUCKET  it holds more than its name (DERIVED: Dining holds groceries,
 *                 Utilities holds rent) — a change applies to ALL of it;
 *   RESIDUAL      the catch-all (Other) — medical, transport, entertainment and
 *                 everything unplaced, changed together.
 */
export type SpendTransformClass = "DIRECT" | "WHOLE_BUCKET" | "RESIDUAL";

export function spendTransformClass(category: string): SpendTransformClass | null {
  if (!isTransformableSpendCategory(category)) return null;
  if (category === RESIDUAL_SPEND_CATEGORY) return "RESIDUAL";
  return categoryDefinition(category)!.observability === "SUPPORTED" ? "DIRECT" : "WHOLE_BUCKET";
}

/**
 * Where the spending an UNSUPPORTED label names actually lands in bank-synced data —
 * the bucket a refusal can honestly offer instead. Mirrors each `meaning` above.
 */
const CONTAINED_IN: Record<string, string> = {
  Groceries: "Dining", Medical: "Other", Entertainment: "Other", Transport: "Other",
  PersonalCare: "Other", Services: "Other", Education: "Other",
};

/**
 * THE USER'S OWN WORDS, when they are narrower (or other) than a line.
 *
 * ⚠️ A SUBSET NEVER SILENTLY WIDENS INTO ITS BUCKET. "Cut restaurants 20%" applied
 * to Dining would cut groceries too — a change nobody stated, carried out
 * confidently. So a word that names PART of a bucket resolves to a refusal that
 * says what the bucket holds and offers it whole; only the user can agree to that.
 *
 *   EQUALS     the word means the whole line ("food" = Dining, "fees" = Fee);
 *   SUBSET_OF  the word is part of a line the data does not split (restaurants ⊂ Dining);
 *   IS         the word is an existing category name spelled another way.
 *
 * Keys are normalised like `resolveSpendCategory` (lower case, no spaces/_/-). A
 * test pins that every target exists and every SUBSET_OF names a transformable line.
 *
 * ⚠️ AN AMBIGUOUS WORD IS LEFT OUT ON PURPOSE. "Gas" is a utility bill or fuel;
 * "bills" is utilities or a card statement. Unlisted, it resolves UNKNOWN and the
 * user is asked — a table that guessed would be the silent widening this prevents.
 */
export const SPEND_WORD_ALIASES: Record<string, { kind: "EQUALS" | "SUBSET_OF" | "IS"; category: string }> = {
  food: { kind: "EQUALS", category: "Dining" },
  foodanddrink: { kind: "EQUALS", category: "Dining" },
  restaurants: { kind: "SUBSET_OF", category: "Dining" },
  restaurant: { kind: "SUBSET_OF", category: "Dining" },
  eatingout: { kind: "SUBSET_OF", category: "Dining" },
  diningout: { kind: "SUBSET_OF", category: "Dining" },
  takeout: { kind: "SUBSET_OF", category: "Dining" },
  coffee: { kind: "SUBSET_OF", category: "Dining" },
  bars: { kind: "SUBSET_OF", category: "Dining" },
  grocery: { kind: "IS", category: "Groceries" },
  supermarket: { kind: "IS", category: "Groceries" },
  rent: { kind: "SUBSET_OF", category: "Utilities" },
  electricity: { kind: "SUBSET_OF", category: "Utilities" },
  internet: { kind: "SUBSET_OF", category: "Utilities" },
  flights: { kind: "SUBSET_OF", category: "Travel" },
  hotels: { kind: "SUBSET_OF", category: "Travel" },
  vacations: { kind: "SUBSET_OF", category: "Travel" },
  clothes: { kind: "SUBSET_OF", category: "Shopping" },
  clothing: { kind: "SUBSET_OF", category: "Shopping" },
  fees: { kind: "EQUALS", category: "Fee" },
  bankfees: { kind: "EQUALS", category: "Fee" },
  subscription: { kind: "EQUALS", category: "Subscriptions" },
  streaming: { kind: "SUBSET_OF", category: "Subscriptions" },
  movies: { kind: "IS", category: "Entertainment" },
  concerts: { kind: "IS", category: "Entertainment" },
  healthcare: { kind: "IS", category: "Medical" },
  doctor: { kind: "IS", category: "Medical" },
  transportation: { kind: "IS", category: "Transport" },
  fuel: { kind: "IS", category: "Transport" },
  haircuts: { kind: "IS", category: "PersonalCare" },
  tuition: { kind: "IS", category: "Education" },
  debtinterest: { kind: "IS", category: "Interest" },
  cardinterest: { kind: "IS", category: "Interest" },
};

export type SpendTransformResolution =
  | { ok: true; category: string; class: SpendTransformClass; meaning: string;
      /** The user's word, when it was not the category's own name. */
      requestedAs?: string }
  | { ok: false; requested: string;
      reason: "SUBSET_OF_BUCKET" | "UNSUPPORTED" | "GOVERNED_ELSEWHERE" | "NOT_SPENDING" | "UNKNOWN";
      /** The line the data DOES have that holds this spending, when there is one. */
      bucket?: string; bucketMeaning?: string;
      unavailable: string };

const norm = (raw: string) => raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
const TRANSFORMABLE_LIST = () => TRANSFORMABLE_SPEND_CATEGORIES.join(", ");

/**
 * Resolve what a spending change is ABOUT to a line it may transform — or a
 * deterministic refusal that says why and offers the bucket that holds it.
 * Refusals never apply anything; the caller refuses the rule whole (and staging
 * refuses it before it can be held).
 */
export function resolveTransformableCategory(raw: string): SpendTransformResolution {
  const alias = SPEND_WORD_ALIASES[norm(raw)];
  const direct = Object.keys(CATEGORY_VOCABULARY).find((c) => c.toLowerCase() === norm(raw));
  if (alias?.kind === "SUBSET_OF") {
    const bucket = alias.category;
    const meaning = categoryDefinition(bucket)!.meaning;
    return { ok: false, requested: raw, reason: "SUBSET_OF_BUCKET", bucket, bucketMeaning: meaning,
      unavailable: `"${raw}" is not separated in this data — it is part of ${bucket} (${meaning}). Nothing was `
        + `applied. Offer the user ${bucket} AS A WHOLE, saying what else it contains, and apply the change to `
        + `${bucket} only if they agree — never to ${bucket} on their behalf.` };
  }
  const name = alias ? alias.category : direct;
  if (!name) {
    return { ok: false, requested: raw, reason: "UNKNOWN",
      unavailable: `"${raw}" is not a spending line this data has. The lines a change can apply to are `
        + `${TRANSFORMABLE_LIST()}. Ask the user which one they mean; do not pick one for them.` };
  }
  const def = categoryDefinition(name)!;
  if (def.role === "NOT_SPENDING") {
    return { ok: false, requested: raw, reason: "NOT_SPENDING",
      unavailable: `${name} is not spending (${def.meaning}), so a spending change cannot apply to it. The lines `
        + `a change can apply to are ${TRANSFORMABLE_LIST()}.` };
  }
  if (def.observability === "UNSUPPORTED") {
    const bucket = CONTAINED_IN[name];
    return { ok: false, requested: raw, reason: "UNSUPPORTED",
      ...(bucket ? { bucket, bucketMeaning: categoryDefinition(bucket)!.meaning } : {}),
      unavailable: `${name} is not tracked on its own — ${def.meaning}. Nothing was applied.`
        + (bucket ? ` Offer the user ${bucket} AS A WHOLE (${categoryDefinition(bucket)!.meaning}), and apply `
          + `the change to it only if they agree.` : "") };
  }
  if (def.governedBy) {
    return { ok: false, requested: raw, reason: "GOVERNED_ELSEWHERE",
      unavailable: `${name} is not a spending line a change can cut: it is set by ${def.governedBy}. Nothing was `
        + "applied. To change it, model the debt instead — a different rate (`liabilityAssumptions`) or "
        + "paying it down (`contributions` with a debt `target`)." };
  }
  return { ok: true, category: name, class: spendTransformClass(name)!, meaning: def.meaning,
    ...(norm(raw) !== name.toLowerCase() ? { requestedAs: raw } : {}) };
}

/** The line-by-line meanings, for a tool description generated from THIS module. */
export function transformableCategoryGuide(): string {
  return TRANSFORMABLE_SPEND_CATEGORIES.map((c) => {
    const cls = spendTransformClass(c);
    return `${c}${cls === "WHOLE_BUCKET" ? " (as a whole)" : cls === "RESIDUAL" ? " (the catch-all)" : ""}`;
  }).join(", ");
}

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
