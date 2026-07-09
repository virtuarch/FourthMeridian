/**
 * lib/transactions/cash-flow.ts
 *
 * Pure cash-flow math for the Cash Flow Perspective (UX-PER-3). The Cash Flow
 * workspace answers "Where does my money move?" — income, spending, and net,
 * over a selected period, computed from transaction history.
 *
 * FlowType-aware (single authority = lib/transactions/flow-predicates):
 *   income   = INCOME
 *   spend    = SPENDING + FEE + INTEREST  (COST_FLOWS), minus REFUND, clamped ≥0
 *   net      = income − spend
 * Transfers, debt payments, and investment flows are movement between accounts,
 * NOT cash flow, and are excluded — matching SpaceTransactionsPanel exactly.
 *
 * Pure and importable (no DB/React/next) so it is unit-testable with tsx.
 * Currency: per-transaction conversion via the caller's ConversionContext at the
 * row's own date (same as SpaceTransactionsPanel); absent ⇒ raw amounts.
 */

import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";

// ─── Period model ─────────────────────────────────────────────────────────────

export type CashFlowPeriod =
  | "WTD" | "MTD" | "QTD" | "YTD"
  | "PAST_WEEK" | "PAST_MONTH" | "PAST_QUARTER" | "PAST_YEAR";

export const CASH_FLOW_PERIODS: { id: CashFlowPeriod; label: string }[] = [
  { id: "WTD",          label: "WTD" },
  { id: "MTD",          label: "MTD" },
  { id: "QTD",          label: "QTD" },
  { id: "YTD",          label: "YTD" },
  { id: "PAST_WEEK",    label: "1W" },
  { id: "PAST_MONTH",   label: "1M" },
  { id: "PAST_QUARTER", label: "1Q" },
  { id: "PAST_YEAR",    label: "1Y" },
];

export const DEFAULT_CASH_FLOW_PERIOD: CashFlowPeriod = "MTD";

/** Local-date YYYY-MM-DD (matches Transaction.date, which is date-only). */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive [start, end] ISO-date range for a period, relative to `now`. */
export function periodRange(period: CashFlowPeriod, now: Date = new Date()): { start: string; end: string } {
  const end = toISODate(now);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // strip time
  let start: Date;

  switch (period) {
    case "WTD": {                                   // from Sunday of this week
      start = new Date(d);
      start.setDate(d.getDate() - d.getDay());
      break;
    }
    case "MTD":
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      break;
    case "QTD":
      start = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
      break;
    case "YTD":
      start = new Date(d.getFullYear(), 0, 1);
      break;
    case "PAST_WEEK":
      start = new Date(d); start.setDate(d.getDate() - 7); break;
    case "PAST_MONTH":
      start = new Date(d); start.setMonth(d.getMonth() - 1); break;
    case "PAST_QUARTER":
      start = new Date(d); start.setMonth(d.getMonth() - 3); break;
    case "PAST_YEAR":
      start = new Date(d); start.setFullYear(d.getFullYear() - 1); break;
  }
  return { start: toISODate(start), end };
}

export function filterByPeriod(
  transactions: Transaction[],
  period: CashFlowPeriod,
  now: Date = new Date(),
): Transaction[] {
  const { start, end } = periodRange(period, now);
  // ISO YYYY-MM-DD strings sort lexicographically == chronologically.
  return transactions.filter((t) => t.date >= start && t.date <= end);
}

// ─── Money ────────────────────────────────────────────────────────────────────

/** Converted magnitude of a row at its own date; absent ctx ⇒ raw amount. */
function rowAmount(t: Transaction, ctx?: ConversionContext): number {
  if (!ctx) return t.amount;
  return convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export interface CashFlowTotals {
  income:  number;   // Σ|amount| where INCOME
  spend:   number;   // COST_FLOWS minus REFUND, clamped ≥ 0
  refunds: number;   // Σ|amount| where REFUND (disclosed separately)
  net:     number;   // income − spend
}

export function aggregateCashFlow(transactions: Transaction[], ctx?: ConversionContext): CashFlowTotals {
  let grossSpend = 0, refunds = 0, income = 0;
  for (const t of transactions) {
    const flow = t.flowType ?? null;
    const amt = Math.abs(rowAmount(t, ctx));
    if (isCostFlow(flow)) grossSpend += amt;
    else if (isRefund(flow)) refunds += amt;
    else if (isIncome(flow)) income += amt;
    // TRANSFER / DEBT_PAYMENT / INVESTMENT / null → not cash flow, ignored.
  }
  const spend = Math.max(0, grossSpend - refunds);
  return { income, spend, refunds, net: income - spend };
}

// ─── History (time buckets) ───────────────────────────────────────────────────

export type CashFlowGranularity = "day" | "week" | "month";

/** Sensible grouping per period: daily for short windows, weekly for a quarter,
 *  monthly for a year. */
export function granularityFor(period: CashFlowPeriod): CashFlowGranularity {
  switch (period) {
    case "WTD": case "MTD": case "PAST_WEEK": case "PAST_MONTH": return "day";
    case "QTD": case "PAST_QUARTER":                            return "week";
    case "YTD": case "PAST_YEAR":                               return "month";
  }
}

function bucketKey(dateStr: string, g: CashFlowGranularity): string {
  if (g === "month") return dateStr.slice(0, 7);           // YYYY-MM
  if (g === "day")   return dateStr;                        // YYYY-MM-DD
  // week → Sunday-start date of that week
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return toISODate(d);
}

function bucketLabel(key: string, g: CashFlowGranularity): string {
  if (g === "month") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  const d = new Date(`${key}T00:00:00`);
  return g === "week"
    ? `Wk ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export interface CashFlowBucket {
  key:    string;
  label:  string;
  income: number;
  spend:  number;
  net:    number;
}

/** Income/spend/net per time bucket for the period, ordered chronologically. */
export function bucketCashFlow(
  transactions: Transaction[],
  period: CashFlowPeriod,
  ctx?: ConversionContext,
): CashFlowBucket[] {
  const g = granularityFor(period);
  const acc = new Map<string, { income: number; spend: number; refunds: number }>();
  for (const t of transactions) {
    const flow = t.flowType ?? null;
    if (!isCostFlow(flow) && !isRefund(flow) && !isIncome(flow)) continue;
    const key = bucketKey(t.date, g);
    const b = acc.get(key) ?? { income: 0, spend: 0, refunds: 0 };
    const amt = Math.abs(rowAmount(t, ctx));
    if (isCostFlow(flow)) b.spend += amt;
    else if (isRefund(flow)) b.refunds += amt;
    else if (isIncome(flow)) b.income += amt;
    acc.set(key, b);
  }
  return [...acc.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => {
      const spend = Math.max(0, v.spend - v.refunds);
      return { key, label: bucketLabel(key, g), income: v.income, spend, net: v.income - spend };
    });
}

// ─── Outflow contribution ─────────────────────────────────────────────────────

export interface CashFlowContribution { id: string; label: string; value: number }

/** Where outflows go, grouped by transaction category (cost flows only),
 *  descending. Refunds reduce their category's total (clamped ≥ 0). */
export function outflowByCategory(transactions: Transaction[], ctx?: ConversionContext): CashFlowContribution[] {
  const byCategory = new Map<string, number>();
  for (const t of transactions) {
    const flow = t.flowType ?? null;
    const amt = Math.abs(rowAmount(t, ctx));
    if (isCostFlow(flow)) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + amt);
    else if (isRefund(flow)) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) - amt);
  }
  return [...byCategory.entries()]
    .map(([label, value]) => ({ id: label, label, value: Math.max(0, value) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
}
