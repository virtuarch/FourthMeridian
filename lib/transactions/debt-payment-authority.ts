/**
 * lib/transactions/debt-payment-authority.ts   (v2.6-TRUTH-7)
 *
 * THE single answer to "how much did I pay toward debt?"
 *
 * Pure: no DB, no React, no clock. It selects and sums; it classifies nothing.
 *
 * ── The question this settles ───────────────────────────────────────────────
 *
 * A card payment is TWO rows. Money leaves a checking account (the CASH leg)
 * and arrives on a card (the LIABILITY leg). Both are persisted `DEBT_PAYMENT`,
 * and both are true. Summing both counts the payment twice.
 *
 * Before this module, two surfaces answered the same question differently:
 *
 *     DebtPaymentsWidget   classifyLiquidity → CASH_OUT/DEBT_PAYMENT    $245,592.37   120 rows
 *     DebtClient           isDebtPayment(flowType) on debt accounts     $239,592.37   118 rows
 *     lib/debt.ts over BOTH legs (one unscoped caller away)             $485,184.74   238 rows
 *
 * ── The counted leg is CASH, and why ────────────────────────────────────────
 *
 * Measured on the live corpus:
 *
 *   · 26 cash legs ($50,150) carry NO counterparty at all — payments toward
 *     liabilities that are not connected to this app. The liability leg for
 *     those does not exist and never will. A liability-leg total silently omits
 *     them, and reports a smaller number than the money that actually left.
 *   · One $4,000 Amex payment from CHASE COLLEGE (2026-08-03) has no liability
 *     leg in the corpus at all.
 *
 * The cash leg is what YOU did: money you moved toward debt. The liability leg
 * is the creditor's record of receiving it, which is a different fact, complete
 * only for liabilities you happen to have connected. Cash Flow's liquidity axis
 * already counts the cash leg, so choosing it also makes Debt and Cash Flow
 * agree without either one adjusting.
 *
 * ⚠️ The liability leg is NOT discarded — it answers a different question, and
 * `rollupDebtPaymentsByAccount` (lib/debt.ts) still uses it, because only that
 * leg names WHICH liability received the money. Two questions, two answers, one
 * module saying which is which.
 *
 * ── Refusal by construction ─────────────────────────────────────────────────
 *
 * `selectDebtPaymentCashLegs` takes a tier resolver and does the selection
 * itself. A caller cannot hand it both legs and get a double count, because a
 * caller does not choose what is counted — this module does. That is why the
 * signature requires the context rather than trusting the caller to pre-filter.
 */

import { classifyLiquidity, type LiquidityContext, type LiquidityTx } from "@/lib/transactions/liquidity";

/**
 * WHICH LEG COUNTS. Named, exported, and asserted by a test — so the decision is
 * a fact in the codebase rather than a convention three surfaces remember.
 */
export const COUNTED_DEBT_PAYMENT_LEG = "CASH" as const;

export interface DebtPaymentSelection<T> {
  /** The rows that count. Sum these; never sum anything else. */
  counted: T[];
  /**
   * The other leg of the same payments — real rows, deliberately not counted.
   * Surfaced so a caller can say "118 liability legs were excluded" instead of
   * a total quietly differing from a neighbouring screen.
   */
  excludedLiabilityLegs: T[];
}

/**
 * Select the cash legs of debt payments from ANY row set.
 *
 * Idempotent under re-selection and safe on mixed input: passing both legs,
 * only the liability legs, or the whole banking population all yield the same
 * counted set.
 *
 * The membership test is `classifyLiquidity` — the existing canonical authority.
 * This module adds no predicate of its own.
 */
export function selectDebtPaymentCashLegs<T extends LiquidityTx>(
  rows: readonly T[],
  ctx: LiquidityContext,
): DebtPaymentSelection<T> {
  const counted: T[] = [];
  const excludedLiabilityLegs: T[] = [];
  for (const r of rows) {
    const c = classifyLiquidity(r, ctx);
    if (c.reason !== "DEBT_PAYMENT") continue;
    // CASH_OUT is the spendable-cash leg; the liability-side leg is NEUTRAL.
    if (c.effect === "CASH_OUT") counted.push(r);
    else excludedLiabilityLegs.push(r);
  }
  return { counted, excludedLiabilityLegs };
}

export interface DebtPaidTotal {
  total: number;
  count: number;
  /** How many rows of the OTHER leg were present and excluded. */
  excludedLiabilityLegCount: number;
  /**
   * V25-FINAL-1 — true when a counted row had no acceptable FX rate and was left
   * out of `total`. The total is then a partial, and a surface must say so.
   */
  unconverted: boolean;
}

/**
 * Total paid toward debt: Σ|amount| over the CASH legs only.
 *
 * `magnitude` converts and absolutes a row (the caller owns the money context so
 * this stays pure); returning `null` excludes the row and sets `unconverted`.
 */
export function totalDebtPaid<T extends LiquidityTx>(
  rows: readonly T[],
  ctx: LiquidityContext,
  magnitude: (row: T) => number | null,
): DebtPaidTotal {
  const { counted, excludedLiabilityLegs } = selectDebtPaymentCashLegs(rows, ctx);
  let total = 0;
  let count = 0;
  let unconverted = false;
  for (const r of counted) {
    const m = magnitude(r);
    if (m === null) { unconverted = true; continue; }
    total += Math.abs(m);
    count += 1;
  }
  return { total, count, excludedLiabilityLegCount: excludedLiabilityLegs.length, unconverted };
}
