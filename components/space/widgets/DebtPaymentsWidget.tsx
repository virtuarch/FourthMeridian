"use client";

/**
 * components/space/widgets/DebtPaymentsWidget.tsx
 *
 * CF-2C — Debt Payments, the liquidity-axis twin of Spending by Category. It shows
 * where debt payments went, grouped by creditor, for the selected period. It runs
 * NO classifier of its own: a row is a debt payment iff the shared canonical
 * projection (classifyLiquidity) tags it CASH_OUT / DEBT_PAYMENT — i.e. the
 * spendable-cash leg that leaves a liquid account to pay down a liability. The
 * liability-side leg is NEUTRAL and never counted, so a payment is counted once.
 * A credit-card PURCHASE is never here (it is REAL_COST, on the Spending axis).
 *
 * Drill-down reuses the shared TransactionSliceDrawer via CashFlowCategoryBreakdown.
 */

import { filterByPeriod, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";

interface Props {
  transactions: Transaction[] | null | undefined;
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  accounts:     { id: string; type: string }[];
}

/** Best creditor label for a debt-payment row — the counterparty/merchant the
 *  payment was made to (a card issuer, lender…). Never a "merchant" in the spend
 *  sense; pure presentation over existing fields. */
function creditorLabel(t: Transaction): string {
  return (t.merchantDisplayName?.trim() || t.merchant?.trim() || t.description?.trim() || "Debt payment");
}

function magnitude(t: LiquidityTx, ctx?: ConversionContext): number {
  const amt = ctx ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount : t.amount;
  return Math.abs(amt);
}

function isDebtPaymentRow(t: LiquidityTx, liqCtx: ReturnType<typeof tierResolver>): boolean {
  const c = classifyLiquidity(t, liqCtx);
  return c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT";
}

export function DebtPaymentsWidget({ transactions, period, ctx, accounts }: Props) {
  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
  }
  const rows = filterByPeriod(transactions, period) as LiquidityTx[];
  const liqCtx = tierResolver(accounts);
  const payments = rows.filter((t) => isDebtPaymentRow(t, liqCtx));

  const byCreditor = new Map<string, number>();
  for (const t of payments) {
    const label = creditorLabel(t);
    byCreditor.set(label, (byCreditor.get(label) ?? 0) + magnitude(t, ctx));
  }
  const items = [...byCreditor.entries()]
    .map(([label, value]) => ({ id: label, label, value }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <CashFlowCategoryBreakdown
      items={items}
      ctx={ctx}
      totalLabel="Total debt payments"
      emptyHeadline="No debt payments in this period"
      emptySubline="Card and loan payments appear here once you make them."
      sliceSubtitle="Debt payments to this creditor"
      sliceFor={(item) => payments.filter((t) => creditorLabel(t) === item.id)}
    />
  );
}
