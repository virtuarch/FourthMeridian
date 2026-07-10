/**
 * lib/transactions/liquidity-breakdown.ts
 *
 * Presentation-facing breakdown of the Cash Flow LIQUIDITY axis: groups the
 * per-row classifyLiquidity output into non-zero, effect-split reason lines
 * (Cash In vs Cash Out) so the summary can render "Cash In $16,044 = Earned
 * income $6,000 + Asset liquidation $10,044".
 *
 * Pure CONSUMER of the liquidity engine — it calls classifyLiquidity but does
 * NOT modify it. Grouping is keyed on (effect, reason), so the per-side totals
 * here are exactly the CASH_IN / CASH_OUT totals deriveCashFlowAxes reports
 * (proven in tests); the UI never recomputes anything itself.
 */

import {
  classifyLiquidity,
  type LiquidityTx,
  type LiquidityContext,
  type LiquidityReason,
} from "@/lib/transactions/liquidity";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";

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
  ASSET_CONVERSION:  "Asset conversion",
  INTERNAL_TRANSFER: "Internal transfer",
  NON_CASH:          "Adjustments",
  UNRESOLVED:        "Unresolved movement",
};

export interface LiquiditySliceLine {
  reason: LiquidityReason;
  label:  string;
  amount: number;
}

export interface LiquidityBreakdown {
  cashIn:      LiquiditySliceLine[];   // non-zero, descending
  cashOut:     LiquiditySliceLine[];   // non-zero, descending
  cashInTotal:  number;                // == deriveCashFlowAxes().cashIn
  cashOutTotal: number;                // == deriveCashFlowAxes().cashOut
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

function rowMagnitude(t: LiquidityTx, ctx?: ConversionContext): number {
  const amt = ctx
    ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount
    : t.amount;
  return Math.abs(amt);
}

function toLines(map: Map<LiquidityReason, number>): LiquiditySliceLine[] {
  return [...map.entries()]
    .filter(([, v]) => v > 0)
    .map(([reason, amount]) => ({ reason, label: LIQUIDITY_REASON_LABEL[reason], amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Effect-split, non-zero reason breakdown of a set of transactions. */
export function groupLiquidityByReason(
  transactions: LiquidityTx[],
  liquidityCtx: LiquidityContext,
  moneyCtx?: ConversionContext,
): LiquidityBreakdown {
  const inMap = new Map<LiquidityReason, number>();
  const outMap = new Map<LiquidityReason, number>();
  let cashInTotal = 0, cashOutTotal = 0, unresolved = 0, creditCardPurchases = 0, internalTransfers = 0;

  for (const t of transactions) {
    const { effect, reason } = classifyLiquidity(t, liquidityCtx);
    const amt = rowMagnitude(t, moneyCtx);
    if (effect === "CASH_IN") {
      inMap.set(reason, (inMap.get(reason) ?? 0) + amt);
      cashInTotal += amt;
    } else if (effect === "CASH_OUT") {
      outMap.set(reason, (outMap.get(reason) ?? 0) + amt);
      cashOutTotal += amt;
    } else if (effect === "UNRESOLVED") {
      unresolved += amt;
    }
    // Context (never in cashOut — all liquidity-NEUTRAL / non-cash-out):
    // Cost flow charged to a liability account = a credit purchase.
    if (reason === "REAL_COST" && liquidityCtx.tierOf(t.financialAccountId ?? t.accountId ?? null) === "liability") {
      creditCardPurchases += amt;
    }
    // Liquidity-neutral internal transfer (money stayed within your tiers).
    if (reason === "INTERNAL_TRANSFER") {
      internalTransfers += amt;
    }
  }

  return {
    cashIn:  toLines(inMap),
    cashOut: toLines(outMap),
    cashInTotal,
    cashOutTotal,
    netCash: cashInTotal - cashOutTotal,
    unresolved,
    creditCardPurchases,
    internalTransfers,
  };
}
