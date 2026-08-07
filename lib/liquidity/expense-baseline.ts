/**
 * lib/liquidity/expense-baseline.ts   (v2.6-ASSESS-2)
 *
 * THE single answer to "what is this Space's monthly expense baseline?"
 *
 * Pure: no DB, no React, no clock, zero imports. It chooses among figures the
 * caller already holds and records WHICH one answered.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * "How many months of expenses does my cash cover?" was answered by dividing by
 * two different numbers:
 *
 *   the product      `emergency_fund_progress.config.monthlyExpenses`
 *                    — a figure the USER DECLARED
 *   the assessment   `computeAverageMonthlySpending(txn)`
 *                    — a figure MEASURED from complete months of transactions
 *
 * Neither is wrong. Both are evidence. But a coverage figure divides by this
 * number, so two baselines are two answers under one set of words — and neither
 * surface said which one it had used, so a user could not reconcile them.
 * Measured across the corpus (scripts/audit-coverage-fraction-divergence.ts):
 * 0 Spaces declared a baseline, 6 had a measured one, and on Chris' Space the
 * product therefore showed NO coverage at all while the assessment engine was
 * telling the AI "1.6 months" — a WARNING-grade position the product never
 * mentioned.
 *
 * ── The precedence, and why this order ──────────────────────────────────────
 *
 *   1. DECLARED   the user's own figure, when they have set one
 *   2. MEASURED   the reliable-month average, when they have not
 *   3. refusal    neither ⇒ null
 *
 * A declaration outranks a measurement for the same reason `displayName`
 * outranks `officialName` in `lib/accounts/display-identity.ts`: it is the
 * user's explicit statement about their own affairs, and an average of the last
 * complete months is an inference about it. A user who has told us their monthly
 * expenses are $4,000 should not be shown $5,494 because their recent quarter
 * happened to run high.
 *
 * ⚠️ This is a PRODUCT decision, not a derivable fact, and it is recorded here so
 * it is made once rather than differently on each surface. It has no observable
 * effect on the current corpus (nothing declares a baseline); it decides what
 * happens the first time somebody does.
 *
 * ── Zero is a refusal, not a baseline ───────────────────────────────────────
 *
 * v2.6-ASSESS-1: `computeAverageMonthlySpending` returns 0 — a true measurement —
 * for reliable months containing no spending, and dividing by it produced
 * `Infinity` months graded EXCELLENT at HIGH confidence, plus a HIGH-impact
 * READY_TO_INVEST recommendation, on 5 of 9 Spaces. A non-positive baseline
 * cannot support a coverage claim, so it never becomes one here.
 */

/** Which figure answered. Recorded so a surface can never be wrong about it. */
export type ExpenseBaselineBasis =
  /** The user set this figure themselves. */
  | "DECLARED"
  /** Averaged from complete, untruncated months of transactions. */
  | "MEASURED";

export interface ExpenseBaseline {
  /** Always > 0 — a non-positive baseline is a refusal, never a value. */
  amount: number;
  basis:  ExpenseBaselineBasis;
}

/** The candidate figures a caller may hold. Either may be absent. */
export interface ExpenseBaselineEvidence {
  /** The user's declared monthly expenses (`emergency_fund_progress` config). */
  declared?: number | null;
  /** The reliable-month average (`computeAverageMonthlySpending`). */
  measured?: number | null;
}

/**
 * Resolve the monthly expense baseline, or refuse.
 *
 * ⚠️ THE ONLY sanctioned way to pick between a declared and a measured baseline.
 * A caller that has just one still calls this: it applies the same
 * positive-or-refuse rule, so "I only have a measurement" and "I have both"
 * cannot diverge on what counts as usable.
 */
export function resolveExpenseBaseline(e: ExpenseBaselineEvidence): ExpenseBaseline | null {
  const usable = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

  const declared = usable(e.declared);
  if (declared !== null) return { amount: declared, basis: "DECLARED" };

  const measured = usable(e.measured);
  if (measured !== null) return { amount: measured, basis: "MEASURED" };

  return null;
}

/**
 * How a surface should describe the baseline it divided by.
 *
 * The wording lives here because it is the part that makes the CLAIM. A coverage
 * figure that does not say what it assumed is the same figure the product and
 * the assessment engine were each showing before this module existed.
 */
export function describeExpenseBaseline(
  b: ExpenseBaseline,
  formatMoney: (n: number) => string,
): string {
  return b.basis === "DECLARED"
    ? `at ${formatMoney(b.amount)}/mo — the figure you set`
    : `at ${formatMoney(b.amount)}/mo — your average across complete months`;
}
