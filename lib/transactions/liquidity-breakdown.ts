/**
 * lib/transactions/liquidity-breakdown.ts
 *
 * Presentation-facing breakdown of the Cash Flow LIQUIDITY axis: turns the
 * canonical DayFacts liquidity facts into non-zero, effect-split reason lines
 * (Cash In vs Cash Out) so the summary can render "Cash In $16,044 = Earned
 * income $6,000 + Asset liquidation $10,044".
 *
 * P2-1A: this is now a PURE PROJECTION over DayFacts — it holds NO fold of its
 * own. It reads the already-computed `byReason` (the effect-partitioned reason
 * sums), `cashIn`/`cashOut`/`unresolved` totals, and `creditCardSpending` off a
 * DayFacts and shapes them for display. It never calls classifyLiquidity and
 * never re-sums rows (that fold is DayFacts' sole job — cash-flow-projection.ts).
 * The per-side split uses LIQUIDITY_REASON_SIDE, a static classification of each
 * LiquidityReason's canonical effect, pinned against classifyLiquidity by tests.
 */

import { type LiquidityReason } from "@/lib/transactions/liquidity";
import type { DayFacts } from "@/lib/transactions/cash-flow-projection";

/** User-facing labels — liquidity terminology, not economic (see doctrine). */
export const LIQUIDITY_REASON_LABEL: Record<LiquidityReason, string> = {
  EARNED_INCOME:     "Earned income",
  ASSET_LIQUIDATION: "Asset liquidation",
  DEBT_PROCEEDS:     "Debt proceeds",
  REFUND:            "Refunds",
  // Liquidity axis: only cost flows paid FROM a liquid account (checking/savings)
  // reach Cash Out. Named to distinguish from economic "Spending by Category"
  // (which includes credit-card purchases). Card spending surfaces separately as
  // the creditCardPurchases context figure, and as cash only when the card is paid.
  REAL_COST:         "Direct cash spending",
  DEBT_PAYMENT:      "Debt payments",
  ASSET_DEPLOYMENT:  "Asset deployment",
  // CF-2 — evidence-based investment venue movements (no proven sale).
  INVESTMENT_INFLOW:  "From investments",
  INVESTMENT_OUTFLOW: "Money invested",
  // CF-2B — payment-app rail on a liquid account (HOW, not why); purpose unknown.
  PAYMENT_APP_INFLOW:  "From payment apps",
  PAYMENT_APP_OUTFLOW: "Payments through apps",
  ASSET_CONVERSION:  "Asset conversion",
  INTERNAL_TRANSFER: "Internal transfer",
  NON_CASH:          "Adjustments",
  UNRESOLVED:        "Unresolved movement",
};

/**
 * Canonical side (net direction) of each liquidity reason — the static
 * classification that lets this projection split DayFacts.byReason into Cash In
 * vs Cash Out lines without re-inspecting rows. Derived from classifyLiquidity
 * (each directional reason is only ever emitted with one CASH_IN/CASH_OUT
 * effect; the four straddle reasons above are "in"/"out" here because DayFacts
 * only records their CASH_IN/CASH_OUT legs). "context" reasons are neutral and
 * never appear as a line. Pinned to classifyLiquidity by liquidity-breakdown.test.ts.
 */
export const LIQUIDITY_REASON_SIDE: Record<LiquidityReason, "in" | "out" | "context"> = {
  EARNED_INCOME:       "in",
  REFUND:              "in",
  ASSET_LIQUIDATION:   "in",
  DEBT_PROCEEDS:       "in",
  INVESTMENT_INFLOW:   "in",
  PAYMENT_APP_INFLOW:  "in",
  REAL_COST:           "out",
  DEBT_PAYMENT:        "out",
  ASSET_DEPLOYMENT:    "out",
  INVESTMENT_OUTFLOW:  "out",
  PAYMENT_APP_OUTFLOW: "out",
  ASSET_CONVERSION:    "context",
  INTERNAL_TRANSFER:   "context",
  NON_CASH:            "context",
  UNRESOLVED:          "context",
};

export interface LiquiditySliceLine {
  reason: LiquidityReason;
  label:  string;
  amount: number;
}

export interface LiquidityBreakdown {
  cashIn:      LiquiditySliceLine[];   // non-zero, descending
  cashOut:     LiquiditySliceLine[];   // non-zero, descending
  cashInTotal:  number;                // == DayFacts.cashIn
  cashOutTotal: number;                // == DayFacts.cashOut
  netCash:      number;
  unresolved:   number;                // magnitude of UNRESOLVED rows (not in net)
  /**
   * CONTEXT ONLY — economic cost flows charged to a liability (credit/loan)
   * account: "what you bought on credit". These are liquidity-NEUTRAL at
   * purchase time (no spendable cash moved), so they are DELIBERATELY NOT part
   * of cashOut — the cash leaves later, counted as Debt payments. Surfaced so
   * the user can reconcile direct cash spending vs. card spending vs. debt
   * payments. Reconciles with "Spending by Category" (both count cost flows).
   */
  creditCardPurchases: number;
  /**
   * CONTEXT ONLY — liquidity-NEUTRAL internal transfers (liquid↔liquid, or the
   * non-liquid leg of a transfer). Money that stayed within your own tiers and
   * moved no spendable cash net, so DELIBERATELY NOT part of cashOut.
   */
  internalTransfers: number;
}

/** Non-zero, descending reason lines for one side, read off DayFacts.byReason. */
function toLines(facts: DayFacts, side: "in" | "out"): LiquiditySliceLine[] {
  const lines: LiquiditySliceLine[] = [];
  for (const [reason, amount] of Object.entries(facts.byReason) as [LiquidityReason, number][]) {
    if (amount > 0 && LIQUIDITY_REASON_SIDE[reason] === side) {
      lines.push({ reason, label: LIQUIDITY_REASON_LABEL[reason], amount });
    }
  }
  return lines.sort((a, b) => b.amount - a.amount);
}

/**
 * Effect-split, non-zero reason breakdown — a PURE PROJECTION over a DayFacts.
 * All numbers come straight from the facts: the lines from the effect-partitioned
 * `byReason`, the totals from `cashIn`/`cashOut`/`unresolved`, the credit-card
 * context from `creditCardSpending`, and internal transfers from the neutral
 * `byReason.INTERNAL_TRANSFER`. No fold, no classifyLiquidity, no re-sum.
 */
export function groupLiquidityByReason(facts: DayFacts): LiquidityBreakdown {
  return {
    cashIn:  toLines(facts, "in"),
    cashOut: toLines(facts, "out"),
    cashInTotal:  facts.cashIn,
    cashOutTotal: facts.cashOut,
    netCash:      facts.cashIn - facts.cashOut,
    unresolved:   facts.unresolved,
    // Cost flow charged to a liability account = a credit purchase (⊂ economic
    // spend, ∉ cashOut). Identical to the old REAL_COST-on-liability sum.
    creditCardPurchases: facts.creditCardSpending,
    // Liquidity-neutral internal transfer (money stayed within your tiers).
    internalTransfers:   facts.byReason.INTERNAL_TRANSFER ?? 0,
  };
}
