/**
 * lib/ai/spending-categories.ts
 *
 * The flow-derived set of TransactionCategory names that are NOT presented as
 * discretionary spending in AI serialization. Single owner shared by the prompt
 * context serializer (per-month + per-category spending lines) and the chat
 * message-analysis drilldown resolver — both must agree on exactly which
 * categories count as spending, so the set lives here rather than being copied.
 *
 * FlowType P5 Slice 6 — flow-derived category name sets ────────────────────
 * Successor to the hand-written {Income, Interest, Transfer, Payment} copies:
 * a category is serialized as a SPENDING line only when its debit rows classify
 * to a flow presented as spending — SPENDING or FEE (whose debits live inside
 * expenseTotal since Slice 4 D-2). INTEREST charges are also inside
 * expenseTotal but stay excluded from the category lines (unchanged legacy
 * presentation — the KD-17 invariant is ≤, not =, for exactly this reason).
 * Income/Transfer/Payment resolve to non-spending flows as before, and the
 * post-Slice-4 newcomers resolve correctly by construction: Dividend → INCOME
 * (excluded — no more $0 average lines), Fee → FEE (included). The probe uses
 * amount −1 because byCategory `total` is the KD-17 debit-only population.
 * TI1 — SERIALIZED_SPENDING_FLOWS is now imported from the single-authority
 * predicate module (lib/transactions/flow-predicates.ts).
 */

import { TransactionCategory } from '@prisma/client';
import { classifyFlow } from '@/lib/transactions/flow-classifier';
import { SERIALIZED_SPENDING_FLOWS } from '@/lib/transactions/flow-predicates';

export const NON_SPENDING_CATEGORY_NAMES: ReadonlySet<string> = new Set(
  (Object.values(TransactionCategory) as string[]).filter(
    (c) => !SERIALIZED_SPENDING_FLOWS.has(classifyFlow({ category: c, amount: -1 }).flowType),
  ),
);
