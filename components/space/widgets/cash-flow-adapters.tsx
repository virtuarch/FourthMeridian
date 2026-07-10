"use client";

/**
 * components/space/widgets/cash-flow-adapters.tsx
 *
 * Cash Flow Perspective widgets (UX-PER-3). The Cash Flow workspace answers ONE
 * question — "Where does my money move?" It is about MOVEMENT over time: income,
 * spending, net, and where outflows go — computed from transaction history and
 * FlowType-aware (lib/transactions/cash-flow + flow-predicates). No net worth,
 * no allocation, no investment performance, no debt payoff, no goals.
 *
 * Mirrors wealth/liquidity adapters: pure presentational render functions over
 * the EXISTING BreakdownWidget / SummaryWidget presenters. The only bespoke
 * visual is a lightweight income/spend-per-bucket history (a diverging/stacked
 * distribution the breakdown/summary presenters can't express) — built with
 * plain divs, NOT a new charting system.
 *
 * All widgets take the SAME selected `period`, so changing the workspace period
 * selector updates every Cash Flow widget at once.
 */

import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { Waves } from "lucide-react";
import {
  filterByPeriod,
  aggregateCashFlow,
  outflowByCategory,
  incomeBySource,
  incomeSourceLabel,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { groupLiquidityByReason } from "@/lib/transactions/liquidity-breakdown";
import type { CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";
import { DebtPaymentsWidget } from "@/components/space/widgets/DebtPaymentsWidget";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function valueFormatterProps(ctx?: ConversionContext) {
  return ctx ? { formatValue: (v: number) => formatCurrency(v, ctx.target) } : {};
}

/** Resolve the period's transactions, or a sentinel for loading/empty. */
function scoped(transactions: Transaction[] | null | undefined, period: CashFlowPeriod) {
  if (transactions == null) return { state: "loading" as const, rows: [] as Transaction[] };
  const rows = filterByPeriod(transactions, period);
  return { state: rows.length ? ("ok" as const) : ("empty" as const), rows };
}

function LoadingCard() {
  return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
}
function EmptyCard({ sub }: { sub: string }) {
  return (
    <div className="text-center py-8">
      <Waves size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
      <p className="text-sm text-[var(--text-muted)]">No money moved in this period</p>
      <p className="text-xs text-[var(--text-faint)] mt-1">{sub}</p>
    </div>
  );
}

// ─── 1. Cash Flow Summary (LIQUIDITY axis — primary) ──────────────────────────

/** Cash In / Cash Out / Net Cash for the selected period, from the derived
 *  liquidity axis (deriveCashFlowAxes). The economic axis is preserved behind a
 *  disclosure in the widget. Needs `accounts` to resolve account tiers. */
export function renderCashFlowSummary(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
  accounts: { id: string; type: string }[] = [],
  perspective?: CashFlowPerspective,
  onPerspectiveChange?: (perspective: CashFlowPerspective, filterId: string) => void,
): React.ReactElement {
  return <CashFlowSummaryWidget transactions={transactions} period={period} ctx={ctx} accounts={accounts} perspective={perspective} onPerspectiveChange={onPerspectiveChange} />;
}

// ─── 2. Cash Flow History ─────────────────────────────────────────────────────

/** Cash flow over the period as a multi-mode time lens (Bars · Calendar). The
 *  mode logic + calendar live in CashFlowHistoryWidget; this stays a thin
 *  adapter so the SectionRegistry contract is unchanged. */
export function renderCashFlowHistory(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
  onSelectPeriod?: (period: CashFlowPeriod) => void,
  accounts: { id: string; type: string }[] = [],
  perspective?: CashFlowPerspective,
  filterId?: string,
  onPerspectiveChange?: (perspective: CashFlowPerspective, filterId: string) => void,
): React.ReactElement {
  return <CashFlowHistoryWidget transactions={transactions} period={period} ctx={ctx} accounts={accounts} onSelectPeriod={onSelectPeriod} perspective={perspective} filterId={filterId} onPerspectiveChange={onPerspectiveChange} />;
}

// ─── 3. Income vs Spending ────────────────────────────────────────────────────

/** Side-by-side magnitude of incoming vs outgoing movement for the period. */
export function renderIncomeVsSpending(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
): React.ReactElement {
  const { state, rows } = scoped(transactions, period);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyCard sub="Add income and spending to compare the two." />;

  const t = aggregateCashFlow(rows, ctx);
  const items: BreakdownItem[] = [
    { id: "income",   label: "Income",   value: t.income, color: "#22c55e" },
    { id: "spending", label: "Spending", value: t.spend,  color: "#ef4444" },
  ].filter((i) => i.value > 0);

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="flow"
      emptyHeadline="No money moved in this period"
      emptySubline="Add income and spending to compare the two."
      {...valueFormatterProps(ctx)}
    />
  );
}

// ─── 4. Cash Flow by Category ─────────────────────────────────────────────────

/** Where outflows go — spending grouped by category, largest first. */
export function renderCashFlowByCategory(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
): React.ReactElement {
  const { state, rows } = scoped(transactions, period);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyCard sub="Spending by category appears once you have outflows." />;

  // Same FlowType-aware data + ordering as before — allocation-strip + category
  // cards presentation (CashFlowCategoryBreakdown) instead of a ranked bar list.
  // Drill-down: a category slice is its cost-flow rows (plus refunds, which net
  // the card's value — so the drawer's clamped spend total matches).
  return (
    <CashFlowCategoryBreakdown
      items={outflowByCategory(rows, ctx)}
      ctx={ctx}
      sliceSubtitle="Spending in this category"
      sliceFor={(item) => rows.filter((t) => t.category === item.id && (isCostFlow(t.flowType) || isRefund(t.flowType)))}
    />
  );
}

// ─── 5. Income by Source ──────────────────────────────────────────────────────

/** Where income comes from — INCOME flows grouped by best-available source
 *  (employer / exchange / brokerage / interest or dividend payer / client / …),
 *  largest first. Twin of Spending by Category; same allocation-strip + cards
 *  visual language, income-oriented. INCOME-only per Cash Flow doctrine, so
 *  transfers / investment conversions / refunds never appear here. */
export function renderIncomeBySource(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
  accounts: { id: string; type: string }[] = [],
  perspective: CashFlowPerspective = "economic",
): React.ReactElement {
  const { state, rows } = scoped(transactions, period);
  if (state === "loading") return <LoadingCard />;

  // CF-3 — perspective-aware. Cash Flow → "Cash In by Source" groups the canonical
  // liquidity CASH_IN reasons (Earned income, From investments, From payment apps,
  // Refunds, …) — reusing groupLiquidityByReason, NEVER relabeling every inflow as
  // income. Spending → the existing economic "Income by Source" (INCOME merchants).
  if (perspective === "liquidity") {
    if (state === "empty") return <EmptyCard sub="Cash in by source appears once cash arrives." />;
    const liqCtx = tierResolver(accounts);
    const cashIn = groupLiquidityByReason(rows as LiquidityTx[], liqCtx, ctx).cashIn;
    return (
      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-[var(--text-secondary)]">Cash in by source</p>
        <CashFlowCategoryBreakdown
          items={cashIn.map((l) => ({ id: l.reason, label: l.label, value: l.amount }))}
          ctx={ctx}
          totalLabel="Total cash in"
          emptyHeadline="No cash arrived in this period"
          emptySubline="Cash in by source appears once cash arrives."
          sliceSubtitle="Cash in from this source"
          sliceFor={(item) => (rows as LiquidityTx[]).filter((t) => {
            const c = classifyLiquidity(t, liqCtx);
            return c.effect === "CASH_IN" && c.reason === item.id;
          })}
        />
      </div>
    );
  }

  if (state === "empty") return <EmptyCard sub="Income by source appears once you have inflows." />;
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-[var(--text-secondary)]">Income by source</p>
      <CashFlowCategoryBreakdown
        items={incomeBySource(rows, ctx)}
        ctx={ctx}
        totalLabel="Total income"
        emptyHeadline="No income in this period"
        emptySubline="Income by source appears once you have inflows."
        sliceSubtitle="Income from this source"
        sliceFor={(item) => rows.filter((t) => isIncome(t.flowType) && incomeSourceLabel(t) === item.id)}
      />
    </div>
  );
}

// ─── 6. Debt Payments (Cash Flow) ─────────────────────────────────────────────

/** Canonical DEBT_PAYMENT rows grouped by creditor (liability account) — the twin
 *  of Spending by Category, on the liquidity axis. Reuses the shared projection
 *  (classifyLiquidity DEBT_PAYMENT reason); no new classifier. */
export function renderDebtPayments(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
  accounts: { id: string; type: string }[] = [],
): React.ReactElement {
  return <DebtPaymentsWidget transactions={transactions} period={period} ctx={ctx} accounts={accounts} />;
}
