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
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { Waves } from "lucide-react";
import {
  filterByPeriod,
  aggregateCashFlow,
  outflowByCategory,
  incomeBySource,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}
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

// ─── 1. Cash Flow Summary ─────────────────────────────────────────────────────

/** Income / spending / net for the selected period (FlowType-aware). */
export function renderCashFlowSummary(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
): React.ReactElement {
  const { state, rows } = scoped(transactions, period);
  if (state === "loading") return <LoadingCard />;
  const t = aggregateCashFlow(rows, ctx);
  if (state === "empty") return <EmptyCard sub="No income or spending recorded here yet." />;

  return (
    <SummaryWidget
      primary={{
        value: `${t.net >= 0 ? "+" : "−"}${fmtMoney(Math.abs(t.net), ctx)}`,
        label: "net cash flow this period",
        color: t.net >= 0 ? "green" : "red",
        size:  "3xl",
      }}
      stats={[
        { label: "Income",   value: `+${fmtMoney(t.income, ctx)}`, accent: "green" },
        { label: "Spending", value: `−${fmtMoney(t.spend, ctx)}`,  accent: "red" },
      ]}
    />
  );
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
): React.ReactElement {
  return <CashFlowHistoryWidget transactions={transactions} period={period} ctx={ctx} onSelectPeriod={onSelectPeriod} />;
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
  return <CashFlowCategoryBreakdown items={outflowByCategory(rows, ctx)} ctx={ctx} />;
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
): React.ReactElement {
  const { state, rows } = scoped(transactions, period);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyCard sub="Income by source appears once you have inflows." />;

  return (
    <CashFlowCategoryBreakdown
      items={incomeBySource(rows, ctx)}
      ctx={ctx}
      totalLabel="Total income"
      emptyHeadline="No income in this period"
      emptySubline="Income by source appears once you have inflows."
    />
  );
}
