/**
 * lib/debt.ts
 *
 * Pure, deterministic debt-math helpers. No DB access, no side effects —
 * safe to call from data-layer code, API routes, or tests.
 */

/**
 * Estimates a monthly minimum payment when the user has supplied an APR but
 * no actual minimum payment (Plaid does not reliably provide this, and not
 * every issuer's minimum is a simple formula). This is a heuristic, NOT an
 * issuer-provided value — callers must label it "Estimated minimum payment"
 * and must prefer any manually-entered value over this estimate.
 *
 * Formula: max($35, 1% of balance + that month's interest accrual).
 */
export function estimateMinimumPayment(balance: number, aprPercent: number): number {
  const safeBalance = Math.max(0, balance);
  const safeApr     = Math.max(0, aprPercent);
  const monthlyInterest = safeBalance * (safeApr / 100 / 12);
  return Math.max(35, safeBalance * 0.01 + monthlyInterest);
}
