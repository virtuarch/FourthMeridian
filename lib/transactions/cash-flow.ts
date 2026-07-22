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

/**
 * Rolling periods, computed relative to "now":
 *   WTD/MTD/QTD/YTD  — to-date windows (start-of-week/month/quarter/year → today)
 *   PAST_*           — solid trailing windows (N ago → today)
 */
export type RelativeCashFlowPeriod =
  | "WTD" | "MTD" | "QTD" | "YTD"
  | "PAST_WEEK" | "PAST_MONTH" | "PAST_QUARTER" | "PAST_6_MONTHS" | "PAST_YEAR"
  | "ALL";

/**
 * Explicit calendar periods, selected from available transaction history.
 * `month` is 1–12, `quarter` is 1–4. Each covers its full calendar span
 * regardless of `now`.
 */
export type ExplicitCashFlowPeriod =
  | { kind: "month";   year: number; month: number }
  | { kind: "quarter"; year: number; quarter: number }
  | { kind: "year";    year: number };

export type CashFlowPeriod = RelativeCashFlowPeriod | ExplicitCashFlowPeriod;

/** Narrow a period to an explicit calendar selection. */
export function isExplicitPeriod(p: CashFlowPeriod): p is ExplicitCashFlowPeriod {
  return typeof p === "object" && p !== null;
}

/** To-date group (far left in the selector). */
export const TO_DATE_PERIODS: { id: RelativeCashFlowPeriod; label: string }[] = [
  { id: "WTD", label: "WTD" },
  { id: "MTD", label: "MTD" },
  { id: "QTD", label: "QTD" },
  { id: "YTD", label: "YTD" },
];

/** Solid trailing group (far right in the selector). "All" is the widest window
 *  — every live transaction, no historical cutoff (see periodRange). */
export const ROLLING_PERIODS: { id: RelativeCashFlowPeriod; label: string }[] = [
  { id: "PAST_WEEK",     label: "1W" },
  { id: "PAST_MONTH",    label: "1M" },
  { id: "PAST_QUARTER",  label: "3M" }, // relabel 1Q → 3M (identical rolling 3-calendar-month semantics)
  { id: "PAST_6_MONTHS", label: "6M" }, // new rolling 6-calendar-month window
  { id: "PAST_YEAR",     label: "1Y" },
  { id: "ALL",           label: "ALL" }, // uppercase to match the to-date group grammar
];

/** All relative periods (back-compat: original order/labels preserved). */
export const CASH_FLOW_PERIODS: { id: RelativeCashFlowPeriod; label: string }[] = [
  ...TO_DATE_PERIODS,
  ...ROLLING_PERIODS,
];

export const DEFAULT_CASH_FLOW_PERIOD: CashFlowPeriod = "MTD";

/** Stable string identity for a period (React keys, select values, equality). */
export function periodKey(p: CashFlowPeriod): string {
  if (!isExplicitPeriod(p)) return p;
  switch (p.kind) {
    case "month":   return `month:${p.year}-${String(p.month).padStart(2, "0")}`;
    case "quarter": return `quarter:${p.year}-Q${p.quarter}`;
    case "year":    return `year:${p.year}`;
  }
}

/** Human label for a period. Explicit months are long-form ("January 2025"),
 *  quarters "Q2 2026", years "2025". Relative periods use their short chip. */
export function periodLabel(p: CashFlowPeriod): string {
  if (!isExplicitPeriod(p)) {
    if (p === "ALL") return "All Time";
    return CASH_FLOW_PERIODS.find((x) => x.id === p)?.label ?? p;
  }
  switch (p.kind) {
    case "month":
      return new Date(p.year, p.month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    case "quarter": return `Q${p.quarter} ${p.year}`;
    case "year":    return `${p.year}`;
  }
}

/** Local-date YYYY-MM-DD (matches Transaction.date, which is date-only). */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive [start, end] range for an explicit calendar period. `end` is the
 *  last calendar day of the span (day 0 of the following month). */
function explicitPeriodRange(p: ExplicitCashFlowPeriod): { start: string; end: string } {
  switch (p.kind) {
    case "month": {
      const start = new Date(p.year, p.month - 1, 1);
      const end   = new Date(p.year, p.month, 0);
      return { start: toISODate(start), end: toISODate(end) };
    }
    case "quarter": {
      const qs = (p.quarter - 1) * 3;
      const start = new Date(p.year, qs, 1);
      const end   = new Date(p.year, qs + 3, 0);
      return { start: toISODate(start), end: toISODate(end) };
    }
    case "year":
      return { start: toISODate(new Date(p.year, 0, 1)), end: toISODate(new Date(p.year, 11, 31)) };
  }
}

/** Inclusive [start, end] ISO-date range for a period. Relative periods are
 *  computed against `now`; explicit periods cover their full calendar span. */
export function periodRange(period: CashFlowPeriod, now: Date = new Date()): { start: string; end: string } {
  if (isExplicitPeriod(period)) return explicitPeriodRange(period);

  // All Time — every live transaction, no historical cutoff. A sentinel range
  // that lexicographically bounds any real YYYY-MM-DD date on both sides, so
  // filterByPeriod keeps the full visible history (imported/provider/wallet).
  if (period === "ALL") return { start: "0000-01-01", end: "9999-12-31" };

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
    case "PAST_6_MONTHS":
      start = new Date(d); start.setMonth(d.getMonth() - 6); break;
    case "PAST_YEAR":
      start = new Date(d); start.setFullYear(d.getFullYear() - 1); break;
  }
  return { start: toISODate(start), end };
}

// ─── Historical option generation ───────────────────────────────────────────────

export interface AvailableHistoricalPeriods {
  months:   ExplicitCashFlowPeriod[];  // { kind: "month" },   newest first
  quarters: ExplicitCashFlowPeriod[];  // { kind: "quarter" }, newest first
  years:    ExplicitCashFlowPeriod[];  // { kind: "year" },    newest first
}

/** Distinct calendar periods that contain at least one transaction, newest
 *  first. Drives the historical selector — a period only appears if data for
 *  it exists (no 2024 data ⇒ no 2024 option). */
export function availableHistoricalPeriods(transactions: Transaction[]): AvailableHistoricalPeriods {
  const months   = new Set<string>();  // "YYYY-M"
  const quarters = new Set<string>();  // "YYYY-Q"
  const years    = new Set<number>();

  for (const t of transactions) {
    const date = t.date;
    if (!date || date.length < 7) continue;
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) continue;
    const q = Math.floor((m - 1) / 3) + 1;
    months.add(`${y}-${m}`);
    quarters.add(`${y}-${q}`);
    years.add(y);
  }

  const monthPeriods: ExplicitCashFlowPeriod[] = [...months]
    .map((k) => { const [y, m] = k.split("-").map(Number); return { kind: "month" as const, year: y, month: m }; })
    .sort((a, b) => b.year - a.year || (b as { month: number }).month - (a as { month: number }).month);

  const quarterPeriods: ExplicitCashFlowPeriod[] = [...quarters]
    .map((k) => { const [y, q] = k.split("-").map(Number); return { kind: "quarter" as const, year: y, quarter: q }; })
    .sort((a, b) => b.year - a.year || (b as { quarter: number }).quarter - (a as { quarter: number }).quarter);

  const yearPeriods: ExplicitCashFlowPeriod[] = [...years]
    .map((y) => ({ kind: "year" as const, year: y }))
    .sort((a, b) => b.year - a.year);

  return { months: monthPeriods, quarters: quarterPeriods, years: yearPeriods };
}

/** Distinct calendar years that contain at least one transaction, newest first.
 *  Drives All-Time calendar year navigation: year-stepping only visits years
 *  that actually hold data (no empty years, no arbitrary cutoff), and the
 *  bounded single-year calendar view never enumerates the 0000–9999 sentinel. */
export function dataBearingYears(transactions: Transaction[]): number[] {
  return availableHistoricalPeriods(transactions).years.map(
    (p) => (p as { year: number }).year,
  );
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

/**
 * Converted magnitude of a row at its own date; absent ctx ⇒ raw amount.
 * V25-FINAL-1 — returns `null` when the row's currency has no acceptable rate
 * (the conversion is UNAVAILABLE): there is no reporting-currency value, so
 * callers EXCLUDE the row from the total rather than blend a native magnitude or
 * a fake 0.
 */
function rowAmount(t: Transaction, ctx?: ConversionContext): number | null {
  if (!ctx) return t.amount;
  return convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export interface CashFlowTotals {
  income:  number;   // Σ|amount| where INCOME
  spend:   number;   // COST_FLOWS minus REFUND, clamped ≥ 0
  refunds: number;   // Σ|amount| where REFUND (disclosed separately)
  net:     number;   // income − spend
  /**
   * V25-FINAL-1 — true when at least one row had no acceptable FX rate and was
   * EXCLUDED from these totals (its native magnitude was never blended in). The
   * totals are then an honest PARTIAL over the convertible rows. (Cash Flow has
   * no other completeness channel today; a workspace badge is a bounded
   * follow-up — see report.)
   */
  unconverted: boolean;
}

// ─── The single economic-fold authority (P2-1) ────────────────────────────────
//
// The economic "which bucket does this row's magnitude go in, and how is spend
// clamped" decision lived independently in TWO folds: economicTotals (below)
// and cash-flow-projection.ts's foldDayFacts. P2-1 collapses that decision to
// ONE place — foldEconomicRow + clampEconomicSpend — so economicTotals, the
// canonical DayFacts fold, and economicSpend can never disagree on the economic
// answer. These are the SOLE definition of economic income / gross spend /
// refund / spend-clamp; do not re-inline the 3-way branch or the clamp anywhere.

/** Mutable accumulator for the economic axis (tier-independent). DayFacts is a
 *  structural superset, so it can be passed directly where this is expected. */
export interface EconomicAccumulator {
  income:     number;   // Σ|amount| INCOME
  spendGross: number;   // Σ|amount| cost flows (SPENDING+FEE+INTEREST), pre-refund
  refunds:    number;   // Σ|amount| REFUND
}

/**
 * Fold ONE row's already-converted magnitude into the economic accumulator by
 * FlowType. The single authority for what counts as income / gross spend /
 * refund. TRANSFER / DEBT_PAYMENT / INVESTMENT / null are not cash flow and are
 * ignored (matching SpaceTransactionsPanel exactly). `magnitude` must be the
 * non-negative converted amount (Math.abs of the row's converted amount).
 */
export function foldEconomicRow(acc: EconomicAccumulator, flowType: string | null | undefined, magnitude: number): void {
  if (isCostFlow(flowType)) acc.spendGross += magnitude;
  else if (isRefund(flowType)) acc.refunds += magnitude;
  else if (isIncome(flowType)) acc.income += magnitude;
}

/** Economic spend: gross cost flows minus refunds, floored at 0. The single
 *  clamp authority (was duplicated in economicTotals and economicSpend). */
export function clampEconomicSpend(spendGross: number, refunds: number): number {
  return Math.max(0, spendGross - refunds);
}

/**
 * economicTotals — the economic-axis PROJECTION (income / spend / refunds / net)
 * over a set of rows. NOT an aggregation authority: it is a thin projection over
 * the single foldEconomicRow + clampEconomicSpend primitives, byte-identical to
 * `perspectiveTotals(aggregateDayFacts(rows, liqCtx, ctx), "economic")` (proven by
 * the cash-flow-fold-authority + cash-flow-projection parity tests). It exists as
 * the ergonomic entry point for callers that have rows but NO liquidity/account
 * context (TransactionSliceDrawer over an arbitrary slice; income-vs-spending).
 * (Renamed from `aggregateCashFlow` in P2-1A — the old name wrongly implied a
 * second aggregation authority.) Reach for aggregateDayFacts whenever you also
 * need the liquidity axis / subsets.
 */
export function economicTotals(transactions: Transaction[], ctx?: ConversionContext): CashFlowTotals {
  const acc: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  let unconverted = false;
  for (const t of transactions) {
    const a = rowAmount(t, ctx);
    if (a === null) { unconverted = true; continue; } // V25-FINAL-1 — exclude the unconvertible row
    foldEconomicRow(acc, t.flowType ?? null, Math.abs(a));
  }
  const spend = clampEconomicSpend(acc.spendGross, acc.refunds);
  return { income: acc.income, spend, refunds: acc.refunds, net: acc.income - spend, unconverted };
}

// ─── History (time buckets) ───────────────────────────────────────────────────

export type CashFlowGranularity = "day" | "week" | "month";

/** Sensible grouping per period: daily for short windows, weekly for a quarter,
 *  monthly for a year. */
export function granularityFor(period: CashFlowPeriod): CashFlowGranularity {
  if (isExplicitPeriod(period)) {
    switch (period.kind) {
      case "month":   return "day";
      case "quarter": return "week";
      case "year":    return "month";
    }
  }
  switch (period) {
    case "WTD": case "MTD": case "PAST_WEEK": case "PAST_MONTH": return "day";
    case "QTD": case "PAST_QUARTER":                            return "week";
    case "YTD": case "PAST_YEAR": case "PAST_6_MONTHS":         return "month";
    case "ALL":                                                 return "month";  // monthly history buckets across all years
  }
}

export function bucketKey(dateStr: string, g: CashFlowGranularity): string {
  if (g === "month") return dateStr.slice(0, 7);           // YYYY-MM
  if (g === "day")   return dateStr;                        // YYYY-MM-DD
  // week → Sunday-start date of that week
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return toISODate(d);
}

export function bucketLabel(key: string, g: CashFlowGranularity): string {
  if (g === "month") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  const d = new Date(`${key}T00:00:00`);
  return g === "week"
    ? `Wk ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// NOTE: bucketCashFlow / CashFlowBucket were retired in the P1 closeout (dead
// folds — zero production callers; the canonical per-bucket income/spend/net is
// cash-flow-projection.ts's DayFacts path). bucketLabel / bucketKey /
// granularityFor below remain live (consumed by cash-flow-projection.ts and
// transactionsInBucket).

/** Member transactions of one history bucket (same key scheme as the DayFacts
 *  bucketing at the period's granularity) — drives Cash Flow History card drill-down.
 *  Returns rows chronologically; the caller decides how to present them. */
export function transactionsInBucket(
  transactions: Transaction[],
  period: CashFlowPeriod,
  bucketKeyValue: string,
): Transaction[] {
  const g = granularityFor(period);
  return transactions
    .filter((t) => bucketKey(t.date, g) === bucketKeyValue)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// NOTE: dailyCashFlow / DayCashFlow were retired in the P1 closeout (dead fold —
// zero production callers; the canonical per-day income/spend/net is
// cash-flow-projection.ts's DayFacts). No financial semantics changed.

/** Calendar months (ascending) spanned by an inclusive ISO-date range. A month
 *  scale yields 1 (or 2 for rolling windows), a quarter 3–4, a year 12–13. */
export function monthsInRange(start: string, end: string): { year: number; month: number }[] {
  const sy = Number(start.slice(0, 4)), sm = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4)),   em = Number(end.slice(5, 7));
  const out: { year: number; month: number }[] = [];
  let y = sy, m = sm;
  // Hard cap (defensive): never emit more than 24 month grids.
  while ((y < ey || (y === ey && m <= em)) && out.length < 24) {
    out.push({ year: y, month: m });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// ─── History visualization modes ──────────────────────────────────────────────

/** Coarse calendar scale of a period — drives how many month grids the calendar
 *  renders and which history modes make sense. */
export type PeriodScale = "week" | "month" | "quarter" | "year";

export function periodScale(period: CashFlowPeriod): PeriodScale {
  if (isExplicitPeriod(period)) return period.kind;
  switch (period) {
    case "WTD": case "PAST_WEEK":                return "week";
    case "MTD": case "PAST_MONTH":               return "month";
    case "QTD": case "PAST_QUARTER": case "PAST_6_MONTHS": return "quarter";
    case "YTD": case "PAST_YEAR":                return "year";
    case "ALL":                                  return "year";
  }
}

export type CashFlowHistoryMode = "calendar" | "cards";

/** Which visualization modes are offered for a period. Week-scale windows are
 *  too cramped for a calendar, so they're cards-only; everything else offers
 *  both (calendar preferred — see getDefaultCashFlowHistoryMode). */
export function getCashFlowHistoryModes(period: CashFlowPeriod): CashFlowHistoryMode[] {
  // All Time spans an unbounded number of years — a single calendar grid can't
  // honestly render that (monthsInRange caps at 24). The analytical totals stay
  // All Time regardless; the Calendar mode is offered but BOUNDED to one
  // navigable data-bearing year at a time (CashFlowHistoryWidget's viewYear
  // cursor + CashFlowCalendar's viewYear prop), never the 0000–9999 sentinel.
  if (period === "ALL") return ["calendar", "cards"];
  return periodScale(period) === "week" ? ["cards"] : ["calendar", "cards"];
}

/** Preferred default mode: calendar for month-like periods, cards for week and
 *  All Time (see getCashFlowHistoryModes). */
export function getDefaultCashFlowHistoryMode(period: CashFlowPeriod): CashFlowHistoryMode {
  if (period === "ALL") return "cards";
  return periodScale(period) === "week" ? "cards" : "calendar";
}

// ─── Outflow contribution ─────────────────────────────────────────────────────

export interface CashFlowContribution { id: string; label: string; value: number }

/** Where outflows go, grouped by transaction category (cost flows only),
 *  descending. Refunds reduce their category's total (clamped ≥ 0). */
export function outflowByCategory(transactions: Transaction[], ctx?: ConversionContext): CashFlowContribution[] {
  const byCategory = new Map<string, number>();
  for (const t of transactions) {
    const flow = t.flowType ?? null;
    const raw = rowAmount(t, ctx);
    if (raw === null) continue; // V25-FINAL-1 — unconvertible row excluded from the category rollup
    const amt = Math.abs(raw);
    if (isCostFlow(flow)) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + amt);
    else if (isRefund(flow)) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) - amt);
  }
  return [...byCategory.entries()]
    .map(([label, value]) => ({ id: label, label, value: Math.max(0, value) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
}

// ─── Income contribution ────────────────────────────────────────────────────────

const trimOrNull = (s?: string | null): string | undefined => {
  const v = s?.trim();
  return v ? v : undefined;
};

/**
 * Best available "source" label for an income row. Income can come from an
 * employer, exchange, brokerage, treasury, interest/dividend payer, payments
 * platform or client — none of which is a "merchant" in the spend sense — so we
 * pick, in priority order: resolved counterparty/source (merchantDisplayName) →
 * raw merchant descriptor → description → category → "Unknown source".
 */
export function incomeSourceLabel(t: Transaction): string {
  return trimOrNull(t.merchantDisplayName)
      ?? trimOrNull(t.merchant)
      ?? trimOrNull(t.description)
      ?? trimOrNull(t.category)
      ?? "Unknown source";
}

/**
 * Where income comes from, grouped by best-available source, descending.
 * INCOME flows ONLY (isIncome) — this excludes TRANSFER, INVESTMENT, REFUND,
 * DEBT_PAYMENT, FEE, INTEREST and any INTERNAL/unclassified movement by the
 * same FlowType doctrine the rest of Cash Flow uses. The twin of
 * outflowByCategory.
 */
export function incomeBySource(transactions: Transaction[], ctx?: ConversionContext): CashFlowContribution[] {
  const bySource = new Map<string, number>();
  for (const t of transactions) {
    if (!isIncome(t.flowType ?? null)) continue;
    const raw = rowAmount(t, ctx);
    if (raw === null) continue; // V25-FINAL-1 — unconvertible income row excluded
    const amt = Math.abs(raw);
    const source = incomeSourceLabel(t);
    bySource.set(source, (bySource.get(source) ?? 0) + amt);
  }
  return [...bySource.entries()]
    .map(([label, value]) => ({ id: label, label, value }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
}
