/**
 * lib/transactions/flow-predicates.ts
 *
 * Transaction Intelligence — the single authority for FlowType MEMBERSHIP
 * predicates (TI1, Predicate Consolidation).
 *
 * Before TI1, "which flows count as spend / income / a transfer / …" was
 * re-defined at every consumer: the `{SPENDING, FEE, INTEREST}` cost set was
 * triplicated across `components/dashboard/BankingClient.tsx`,
 * `components/dashboard/widgets/SpaceTransactionsPanel.tsx`, and the AI
 * assembler's `EXPENSE_FLOWS`; the single-value checks (`=== 'REFUND'`,
 * `=== 'INCOME'`, `=== 'TRANSFER'`, `=== 'DEBT_PAYMENT'`) were inlined in each
 * of those plus `lib/debt.ts`; and the spend-ledger set (`SPENDING || REFUND`)
 * lived inline in `flow-classifier.ts`. This module collapses those definitions
 * to one place so a future flow kind is admitted once, not four times.
 *
 * Contract (mirrors flow-classifier.ts):
 *  - PURE: same input → same output. No DB, no I/O, no side effects, no env.
 *  - ZERO IMPORTS: predicates operate on the persisted `flowType` VALUE as a
 *    plain string, exactly as the pre-TI1 `new Set([...]).has(t.flowType)`
 *    call sites did. This keeps the module runnable under `tsx` with no Prisma
 *    generate and free of any import cycle with flow-classifier.ts.
 *  - BEHAVIOR-NEUTRAL: every set below reproduces, byte-for-byte, the
 *    membership of the consumer it replaces. TI1 introduces NO new semantics.
 *
 * The parameter type is `string | null | undefined` on purpose: callers hold
 * `flowType` either as the DTO string (`Transaction.flowType` in the UI) or as
 * the Prisma `FlowType` enum value (the assembler) — both are strings at
 * runtime, and typing the arg as `string` accepts either without coupling this
 * module to either enum declaration. A null/undefined flow (unclassified row)
 * is never a member of any set — matching the pre-TI1 `t.flowType != null &&`
 * guards exactly.
 */

type Flow = string | null | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Membership sets — each reproduces one pre-TI1 consumer set verbatim.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cost flows — money-out kinds counted (gross Σ|amount|) toward the "Spend"
 * figure. Replaces the triplicated `FLOW_COST` (BankingClient,
 * SpaceTransactionsPanel) and the assembler's `EXPENSE_FLOWS`. INTEREST charges
 * are included (dashboard parity + the assembler's legacy fall-through). REFUND
 * is NOT here — it is disclosed and netted separately by each consumer.
 */
export const COST_FLOWS: ReadonlySet<string> = new Set(['SPENDING', 'FEE', 'INTEREST']);

/**
 * Serialized-spending flows — the category-LINE population in the AI chat
 * serializer. Deliberately NARROWER than COST_FLOWS: INTEREST charges live in
 * expenseTotal but are excluded from the per-category spending lines (the KD-17
 * invariant is ≤, not =). Replaces the inline `SERIALIZED_SPENDING_FLOWS` in
 * app/api/ai/chat/route.ts. NOT interchangeable with COST_FLOWS.
 */
export const SERIALIZED_SPENDING_FLOWS: ReadonlySet<string> = new Set(['SPENDING', 'FEE']);

// ─────────────────────────────────────────────────────────────────────────────
// Predicates. Each is a pure function of the flowType value.
// ─────────────────────────────────────────────────────────────────────────────

/** Money-out cost flow (SPENDING | FEE | INTEREST) — the "Spend" chip set. */
export function isCostFlow(flowType: Flow): boolean {
  return flowType != null && COST_FLOWS.has(flowType);
}

/** Serialized-spending flow (SPENDING | FEE) — the category-line set. */
export function isSerializedSpendingFlow(flowType: Flow): boolean {
  return flowType != null && SERIALIZED_SPENDING_FLOWS.has(flowType);
}

/**
 * Spend-ledger membership (SPENDING | REFUND) — the flow contributes to the
 * spend ledger, either as spend or its reversal. This is the definition behind
 * flow-classifier.ts's `isSpendingFlow` / `isExcludedFromSpending` (which now
 * delegate here) and, transitively, the opportunity-eligibility gate in
 * lib/ai/intelligence/annotations.ts. Distinct from `isCostFlow` — do not
 * conflate the two "spend" notions (that conflation is what TI1 disentangles).
 */
export function isSpendLedgerFlow(flowType: Flow): boolean {
  return flowType === 'SPENDING' || flowType === 'REFUND';
}

/** Not part of the spend ledger — the complement of `isSpendLedgerFlow`. */
export function isExcludedFromSpendLedger(flowType: Flow): boolean {
  return !isSpendLedgerFlow(flowType);
}

/** Income kind. */
export function isIncome(flowType: Flow): boolean {
  return flowType === 'INCOME';
}

/** Refund kind (a reversal of prior spending — never income). */
export function isRefund(flowType: Flow): boolean {
  return flowType === 'REFUND';
}

/** Transfer kind (movement between accounts — not spend, not income). */
export function isTransfer(flowType: Flow): boolean {
  return flowType === 'TRANSFER';
}

/** Debt-payment kind (liability reduction — not consumption spend). */
export function isDebtPayment(flowType: Flow): boolean {
  return flowType === 'DEBT_PAYMENT';
}

/** Investment/security-activity kind. */
export function isInvestmentFlow(flowType: Flow): boolean {
  return flowType === 'INVESTMENT';
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation — humanized FlowType labels (Transactions Tab Phase 1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Humanized labels for the persisted `FlowType` values — the single label map
 * the Transactions Tab flow-type filter renders. Additive presentation only: no
 * predicate or membership set above reads this. One entry per FlowType enum value
 * (pinned by flow-predicates.test.ts against @prisma/client's FlowType, so a new
 * flow kind can't ship without a label). Keys stay the raw enum VALUE as a plain
 * string, matching this module's ZERO-IMPORTS contract.
 */
export const FLOW_TYPE_LABEL: Record<string, string> = {
  SPENDING:     'Spending',
  INCOME:       'Income',
  REFUND:       'Refund',
  DEBT_PAYMENT: 'Debt payment',
  TRANSFER:     'Transfer',
  INVESTMENT:   'Investment',
  FEE:          'Fee',
  INTEREST:     'Interest',
  ADJUSTMENT:   'Adjustment',
  UNKNOWN:      'Unknown',
};

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation — the single per-FlowType sum both the Transactions summary bar
// and its "By Flow Type" Group By consume (Transactions Tab §2.3.1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel bucket key for rows with no `flowType` (unclassified). Keeps
 * `sumByFlowType` and the "By Flow Type" Group By bucketing on ONE shared key so
 * the summary bar and the grouped view cannot diverge on where a null-flow row
 * lands (stop condition §9.8).
 */
export const UNCLASSIFIED_FLOW_KEY = '__unclassified__';

/**
 * Sum a caller-supplied amount accessor over rows, bucketed by `flowType` value
 * (null → `UNCLASSIFIED_FLOW_KEY`). This is the SINGLE aggregation the
 * Transactions summary chips and the "By Flow Type" Group By bucket totals both
 * consume — a per-kind total can never be computed two different ways. Pure and
 * import-free: currency conversion / abs / sign all live in the caller's `amount`
 * accessor, keeping this module's zero-imports contract intact.
 */
export function sumByFlowType<T extends { flowType?: string | null }>(
  rows: readonly T[],
  amount: (row: T) => number,
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const key = r.flowType ?? UNCLASSIFIED_FLOW_KEY;
    sums.set(key, (sums.get(key) ?? 0) + amount(r));
  }
  return sums;
}
