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

import { filterByPeriod, type CashFlowPeriod, periodKey } from "@/lib/transactions/cash-flow";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";
import { groupDebtPaymentsByCreditor, normalizeCreditor, rawCreditorLabel } from "@/lib/transactions/debt-payments";

interface Props {
  transactions: Transaction[] | null | undefined;
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  accounts:     { id: string; type: string }[];
  /** SD-6C — the period-windowed rows from CashFlowSpaceData (the workspace
   *  composition boundary). When supplied the widget consumes it instead of
   *  re-running `filterByPeriod` — the byte-identical slice. Absent ⇒ the
   *  standalone/registry path windows here, exactly as before. */
  windowRows?:  Transaction[];
}

function magnitude(t: Transaction, ctx?: ConversionContext): number {
  // V25-FINAL-1 — an unavailable conversion (no rate) contributes 0 to this widget's
  // display sum (excluded, never a native magnitude / relabel).
  const amt = ctx ? (convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount ?? 0) : t.amount;
  return Math.abs(amt);
}

function isDebtPaymentRow(t: LiquidityTx, liqCtx: ReturnType<typeof tierResolver>): boolean {
  const c = classifyLiquidity(t, liqCtx);
  return c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT";
}

export function DebtPaymentsWidget({ transactions, period, ctx, accounts, windowRows }: Props) {
  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
  }
  const rows = (windowRows ?? filterByPeriod(transactions, period)) as LiquidityTx[];
  const liqCtx = tierResolver(accounts);
  // Canonical DEBT_PAYMENT liquidity rows (CASH_OUT/DEBT_PAYMENT) — the spendable-
  // cash leg that pays down a liability; the liability-side leg is NEUTRAL, so a
  // payment is counted once. Aggregated by normalized creditor (Phase 3).
  const payments = rows.filter((t) => isDebtPaymentRow(t, liqCtx));
  const items = groupDebtPaymentsByCreditor(payments, (t) => magnitude(t, ctx));

  return (
    <CashFlowCategoryBreakdown
      items={items}
      ctx={ctx}
      totalLabel="Total debt payments"
      emptyHeadline="No debt payments in this period"
      emptySubline="Card and loan payments appear here once you make them."
      invalidationKey={periodKey(period)}
      sliceSubtitle="Debt payments to this creditor"
      sliceFor={(item) => payments.filter((t) => normalizeCreditor(rawCreditorLabel(t)) === item.id)}
    />
  );
}
