/**
 * lib/plaid/reconcile-core.ts
 *
 * The pure core of the balance↔transaction reconciliation (D2.x M2), extracted
 * from lib/plaid/refresh.ts by PRE-V26-PLAID-CLOSE Phase 2 so the rule is
 * unit-testable against real recorded incidents. No DB, no Plaid, no clock.
 *
 * ── What it asks ─────────────────────────────────────────────────────────────
 * "Did this account's balance move by an amount the transactions we stored this
 * refresh actually explain?" A gap beyond threshold means the balance moved
 * without matching transactions — the July-2 2026 class, where a posted row was
 * delivered but never persisted while the balance already reflected it.
 *
 * ── SAME-BASIS INVARIANT (the Phase 2 correction) ────────────────────────────
 * Both sides MUST be posted-basis:
 *   • `FinancialAccount.balance` comes from Plaid's `balances.current`, which
 *     does not include pending activity. The snapshot system states this
 *     outright — "the only balance the snapshot system treats as truth and never
 *     carries pending" (regenerate-history.ts) — and every historical walk
 *     (backfill.ts, accounts-asof.ts) filters `pending: false` to match it.
 *   • The transaction sum is therefore taken over POSTED rows only.
 *
 * Mixing the bases is what made this detector cry wolf: with a pending-inclusive
 * sum, a pending→posted transition moved the balance but not the sum (the row was
 * already counted while pending), manufacturing a mismatch equal to the posted
 * amount on entirely healthy provider churn. Posted-only, that same transition
 * nets to exactly zero — proven in reconcile-core.test.ts against the two real
 * events this database recorded.
 *
 * ── Sign convention ──────────────────────────────────────────────────────────
 * Fourth Meridian stores positive = money in. For CASH the balance moves WITH the
 * transaction sum; for a CARD the balance is amount OWED, which moves AGAINST it
 * (a purchase is negative and increases what you owe). Hence `expected` flips.
 */

/** Which side of the ledger this account sits on, for the sign rule above. */
export type ReconcileKind = "cash" | "card";

export interface ReconcileInput {
  kind: ReconcileKind;
  /** FinancialAccount.balance before this refresh wrote the fresh value. */
  balanceBefore: number;
  /** FinancialAccount.balance after this refresh wrote the fresh value. */
  balanceAfter: number;
  /** Σ POSTED transaction amounts for this account, before the sync ran. */
  postedSumBefore: number;
  /** Σ POSTED transaction amounts for this account, after the sync ran. */
  postedSumAfter: number;
}

export interface ReconcileVerdict {
  balanceDelta: number;
  txnSumDelta: number;
  /** The balance movement the stored transactions predict. */
  expected: number;
  /** |balanceDelta − expected| — the unexplained amount. */
  mismatch: number;
  threshold: number;
  /** True ⇒ emit a BALANCE_TX_MISMATCH SyncIssue. */
  mismatched: boolean;
}

/**
 * Absolute floor for the mismatch threshold. Below this, ordinary provider
 * timing jitter is not worth an operational signal.
 */
export const RECONCILE_MIN_THRESHOLD = 100;

/** Proportional component — 2% of the account's post-refresh magnitude. */
export const RECONCILE_THRESHOLD_RATIO = 0.02;

/**
 * Evaluate one account's balance↔transaction reconciliation. Pure; behaviour is
 * byte-identical to the arithmetic previously inlined in refreshPlaidItem, with
 * the sums now supplied on a posted-only basis.
 */
export function evaluateReconciliation(input: ReconcileInput): ReconcileVerdict {
  const balanceDelta = input.balanceAfter - input.balanceBefore;
  const txnSumDelta  = input.postedSumAfter - input.postedSumBefore;
  const expected     = input.kind === "cash" ? txnSumDelta : -txnSumDelta;
  const mismatch     = Math.abs(balanceDelta - expected);
  const threshold    = Math.max(
    RECONCILE_MIN_THRESHOLD,
    Math.abs(input.balanceAfter) * RECONCILE_THRESHOLD_RATIO,
  );
  return { balanceDelta, txnSumDelta, expected, mismatch, threshold, mismatched: mismatch > threshold };
}
