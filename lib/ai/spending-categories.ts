/**
 * lib/ai/spending-categories.ts
 *
 * The TransactionCategory names that are NOT spending lines in AI serialization
 * (the brief-scope category cap; the message-analysis drilldown).
 *
 * FM-AUDIT-005 — ONE membership rule. This set used to be derived by probing the
 * classifier with `classifyFlow({category, amount: −1})` ∈ {SPENDING, FEE}: a
 * third definition beside the Cash Flow ledger's (cost flows ∪ REFUND, which
 * includes INTEREST) and the annotations probe ({SPENDING, REFUND}). So "Interest"
 * was a spending line on the Cash Flow page and not in the AI, and S1 would have
 * shown or hidden it depending on the surface. It is now read from THE category
 * vocabulary (lib/transactions/category-vocabulary.ts): a label is a spending line
 * exactly when its role is SPENDING — the same keys the canonical ledger
 * (foldCategorySpend) produces.
 *
 * (Opportunity ELIGIBILITY — whether a spending line is a candidate to cut — is a
 * separate judgement layered on top, in annotations/metrics.ts. It is not a
 * membership rule.)
 */

import { NOT_SPENDING_CATEGORIES } from '@/lib/transactions/category-vocabulary';

export const NON_SPENDING_CATEGORY_NAMES: ReadonlySet<string> = new Set(NOT_SPENDING_CATEGORIES);
