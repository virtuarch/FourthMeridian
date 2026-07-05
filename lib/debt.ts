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

// ── FlowType P5 Slice 3 — debt-payment rollups ────────────────────────────────

/**
 * Minimal transaction shape for the rollups below — a structural subset of the
 * Transaction DTO (types/index.ts), kept local so this module stays
 * dependency-free.
 */
export interface DebtPaymentTxnLike {
  accountId: string;
  amount: number;
  flowType?: string | null;
}

/**
 * Total paid toward debt: Σ|amount| over `flowType = DEBT_PAYMENT` rows.
 * Replaces the legacy `category === 'Payment'` string heuristic (P5 Slice 3).
 *
 * Sign-agnostic by design: destination-side legs on debt accounts carry either
 * sign depending on source convention (see flow-classifier.ts — DEBT_PAYMENT
 * is INTERNAL when negative, INFLOW when positive), matching the abs-sum shape
 * of the legacy computation. Rows with null flowType are excluded — the
 * non-null invariant holds for all production writers (P5 Slice 0 + backfill).
 */
export function totalDebtPaid(txs: DebtPaymentTxnLike[]): number {
  let sum = 0;
  for (const t of txs) {
    if (t.flowType === 'DEBT_PAYMENT') sum += Math.abs(t.amount);
  }
  return sum;
}

/** One liability's received payments within the caller's row scope. */
export interface DebtPaymentRollupEntry {
  accountId: string;
  total: number;
  count: number;
}

/**
 * Per-liability debt-payment rollup (the KD-18 capability): destination-side
 * DEBT_PAYMENT legs grouped by account id, sorted descending by total.
 * Callers pass rows already scoped to debt accounts (getDebtTransactions),
 * so each row's accountId identifies the liability that received the payment.
 */
export function rollupDebtPaymentsByAccount(txs: DebtPaymentTxnLike[]): DebtPaymentRollupEntry[] {
  const byAccount = new Map<string, DebtPaymentRollupEntry>();
  for (const t of txs) {
    if (t.flowType !== 'DEBT_PAYMENT') continue;
    let entry = byAccount.get(t.accountId);
    if (!entry) {
      entry = { accountId: t.accountId, total: 0, count: 0 };
      byAccount.set(t.accountId, entry);
    }
    entry.total += Math.abs(t.amount);
    entry.count += 1;
  }
  return [...byAccount.values()].sort((a, b) => b.total - a.total);
}
