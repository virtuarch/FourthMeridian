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
  bucketCashFlow,
  outflowByCategory,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";

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

/** Income (green) vs spending (red) per time bucket, with net — the shape of
 *  cash flow over the period. Bucketing (day/week/month) follows the period. */
export function renderCashFlowHistory(
  transactions: Transaction[] | null | undefined,
  period: CashFlowPeriod,
  ctx?: ConversionContext,
): React.ReactElement {
  const { state, rows } = scoped(transactions, period);
  if (state === "loading") return <LoadingCard />;
  if (state === "empty") return <EmptyCard sub="Cash-flow history appears as transactions accumulate." />;

  const buckets = bucketCashFlow(rows, period, ctx);
  if (buckets.length === 0) return <EmptyCard sub="Cash-flow history appears as transactions accumulate." />;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.income, b.spend)));

  return (
    <div className="space-y-3">
      {buckets.map((b) => (
        <div key={b.key} className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-[var(--text-secondary)]">{b.label}</span>
            <span className={b.net >= 0 ? "text-[var(--accent-positive)]" : "text-[var(--accent-negative)]"}>
              {b.net >= 0 ? "+" : "−"}{fmtMoney(Math.abs(b.net), ctx)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--surface-inset)] overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${(b.income / max) * 100}%`, backgroundColor: "var(--accent-positive)" }} />
          </div>
          <div className="h-1.5 rounded-full bg-[var(--surface-inset)] overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${(b.spend / max) * 100}%`, backgroundColor: "var(--accent-negative)" }} />
          </div>
        </div>
      ))}
      <div className="flex items-center gap-4 pt-1 text-[10px] text-[var(--text-faint)]">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--accent-positive)" }} /> Income</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--accent-negative)" }} /> Spending</span>
      </div>
    </div>
  );
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

  const items: BreakdownItem[] = outflowByCategory(rows, ctx);

  return (
    <BreakdownWidget
      items={items}
      viewMode="bar"
      itemNoun="category"
      emptyHeadline="No spending in this period"
      emptySubline="Nothing went out during the selected window."
      {...valueFormatterProps(ctx)}
    />
  );
}
