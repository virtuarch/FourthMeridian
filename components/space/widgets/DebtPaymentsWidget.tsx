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

import { filterByPeriod, asOfAnchor, type CashFlowPeriod, periodKey } from "@/lib/transactions/cash-flow";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import {
  selectDebtPaymentCashLegs, groupDebtPaymentsByCreditor,
} from "@/lib/transactions/debt-payment-authority";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";

interface Props {
  transactions: Transaction[] | null | undefined;
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  /** id + type for the tier resolver; `name` additionally lets the breakdown
   *  head a group with the creditor ACCOUNT rather than a descriptor. */
  accounts:     { id: string; type: string; name?: string | null }[];
  /** SD-6C — the period-windowed rows from CashFlowSpaceData (the workspace
   *  composition boundary). When supplied the widget consumes it instead of
   *  re-running `filterByPeriod` — the byte-identical slice. Absent ⇒ the
   *  standalone/registry path windows here, exactly as before. */
  windowRows?:  Transaction[];
  /**
   * The selected as-of date — the anchor for the fallback window.
   *
   * Without it `filterByPeriod` defaults to `new Date()`, so this widget showed
   * TODAY's period on the section path while the dashboard displayed a
   * historical date. The workspace path passes `windowRows` and never reaches
   * the fallback; the section path has no canonical rows to pass, so it must at
   * least window against the right anchor.
   */
  asOf?:        string;
}

function magnitude(t: Transaction, ctx?: ConversionContext): number {
  // V25-FINAL-1 — an unavailable conversion (no rate) contributes 0 to this widget's
  // display sum (excluded, never a native magnitude / relabel).
  const amt = ctx ? (convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount ?? 0) : t.amount;
  return Math.abs(amt);
}

export function DebtPaymentsWidget({ transactions, period, ctx, accounts, windowRows, asOf }: Props) {
  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
  }
  const rows = (windowRows
    ?? filterByPeriod(transactions, period, asOfAnchor(asOf))) as LiquidityTx[];
  const liqCtx = tierResolver(accounts);
  // v2.6-TRUTH-7 — the ONE debt-payment authority selects the counted leg. This
  // widget used to carry its own `isDebtPaymentRow` predicate; DebtClient carried
  // a different one, and the two totals differed by $6,000.
  const payments = selectDebtPaymentCashLegs(rows, liqCtx).counted;
  // v2.6-TRUTH-9 — grouped by CREDITOR ACCOUNT. Presentation only: every counted
  // row lands in exactly one group, so the heading a payment sits under can
  // change while the total cannot.
  const creditorAccounts = new Map(accounts.map((a) => [a.id, { id: a.id, name: a.name ?? null, type: a.type }]));
  const items = groupDebtPaymentsByCreditor(
    payments as never, creditorAccounts, (t) => magnitude(t as never, ctx));

  return (
    <CashFlowCategoryBreakdown
      items={items}
      ctx={ctx}
      totalLabel="Total debt payments"
      emptyHeadline="No debt payments in this period"
      emptySubline="Card and loan payments appear here once you make them."
      invalidationKey={periodKey(period)}
      sliceSubtitle="Debt payments to this creditor"
      sliceFor={(item) => byId(payments, item.transactionIds)}
    />
  );
}

/**
 * Rows for a group, BY IDENTITY — the ids the authority recorded while summing.
 * A lookup, not a classification: React decides nothing here.
 */
function byId<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const want = new Set(ids);
  return rows.filter((r) => want.has(r.id));
}
