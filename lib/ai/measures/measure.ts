/**
 * lib/ai/measures/measure.ts   (M1 — measures & comparison)
 *
 * A MEASURE is what happened over a period; a COMPARISON is two measures and the
 * computed difference between them. Code owns every number here.
 *
 * ⚠️ OVER THE ONE FOLD, THROUGH ITS MONTHLY ROWS. The inputs are the transactions
 * assembler's `monthlyBreakdown` — each month already folded by `foldEconomicRow`
 * (SPENDING+FEE+INTEREST → spending, INCOME → income, REFUND → refunds; transfers,
 * card payments and investment activity fall through). Nothing here decides what
 * counts as spending; it sums months the fold produced. There is no second
 * inclusion rule and no transaction list.
 *
 * ⚠️ A MONTHLY FIGURE IS A MEAN OVER WHOLE CALENDAR MONTHS, NEVER TOTAL ÷ DAYS.
 * The recorded defect (docs/plans/AI-MEASURES-COMPARISON-M1-INVESTIGATION.md §17):
 * a 90-day economic net holding seven biweekly paychecks was divided by three in
 * prose and called a monthly surplus. `perCompleteMonth` is null on a window with
 * no whole month, and a partial month is counted in `total` but never averaged.
 *
 * ⚠️ COMPLETENESS IS POPULATION-AWARE. A stale source lowers a measure's tier only
 * when that source's accounts put rows into THIS measure's population and have
 * not delivered rows up to the window's end. The recovered live Space proved the
 * naive rule wrong: a NEEDS_RECONNECT brokerage with zero banking rows marked
 * every spending figure incomplete (§29).
 *
 * Pure. No data access, no clock.
 */

import type { CompletenessTier } from '@/lib/perspective-engine/types';
import { monthsSpanned, isPartialMonth, type ResolvedPeriod } from './period';

export type FlowMeasure =
  | 'spending' | 'income' | 'economicNet' | 'cardAndDebtPayments'
  | 'transfersBetweenOwnAccounts' | 'refunds';
export const FLOW_MEASURES: readonly FlowMeasure[] =
  ['spending', 'income', 'economicNet', 'cardAndDebtPayments', 'transfersBetweenOwnAccounts', 'refunds'];

/** One month as the assembler's `monthlyBreakdown` already holds it. */
export interface MonthRow {
  month: string;
  incomeTotal: number;
  expenseTotal: number;
  refundTotal: number;
  debtPaymentTotal: number;
  transferTotal: number;
  partial?: boolean;
  truncated?: boolean;
  /** `refundTotal` — Σ REFUND rows in the category that month (REFUND-1); absent = none. */
  byCategory: { category: string; total: number; refundTotal?: number; count?: number }[];
}

export type Tier = CompletenessTier;
export interface Completeness {
  tier: Tier;
  reason: string;
  /** The earliest date the transaction record covers. */
  coverageFrom?: string;
  /** Per contributing source, only sources whose accounts feed this population. */
  byComponent?: Record<string, Tier>;
}

/** What is known about the record a measure was read from. */
export interface DataCoverage {
  /** Corpus bounds for the Space at the ceiling; null when no history exists. */
  corpusFrom: string | null;
  corpusTo: string | null;
  /** The oldest date the read actually aggregated, when the read was clamped. */
  readFrom?: string | null;
  /** The read hit the row ceiling and dropped its oldest rows. */
  fetchCapHit: boolean;
  /**
   * Source health mapped ONLY onto accounts that put rows into this measure's
   * population, each with the last day it is known to have delivered through.
   */
  components?: { key: string; tier: Tier; deliveredThrough: string | null }[];
}

const MONEY_EPSILON = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;
const RANK: Record<Tier, number> = { observed: 0, derived: 1, estimated: 2, incomplete: 3, unknown: 4 };
const worstTier = (tiers: Tier[]): Tier =>
  tiers.reduce<Tier>((w, t) => (RANK[t] > RANK[w] ? t : w), 'observed');

export interface MeasureResult {
  measure: FlowMeasure;
  category?: string;
  unit: 'USD';
  period: ResolvedPeriod;
  /** Every month in the window, partial ones included. */
  total: number;
  months: { month: string; value: number; partial: boolean }[];
  completeMonths: number;
  partialMonths: string[];
  /** Mean over WHOLE calendar months only. null when the window holds none. Never total ÷ days. */
  perCompleteMonth: number | null;
  highest: { month: string; value: number } | null;
  lowest: { month: string; value: number } | null;
  /**
   * Category measures only: all spending over the SAME months, and this line's
   * share of it. "Was travel a big part of my spending" is a division, and a
   * division is code's — asked without this, the model divided two tool figures
   * in prose. `sharePct` is null when nothing was spent at all.
   */
  ofAllSpending?: { total: number; sharePct: number | null };
  /**
   * REFUND-1 — `spending` measures only, and ONLY when refunds fall in the window.
   *
   * `total` above is GROSS: what was charged. This is what the spending actually
   * COST once refunds dated in the same months are taken off — each month floored
   * at zero by the same rule `economicNet` uses (max(0, spending − refunds)), so
   * `income − netOfRefunds` IS `economicNet`, month by month. A refund counts in
   * the month it is DATED, never the month of the purchase it reverses.
   *
   * Asked without this, the model had two tool figures (spending, refunds) and
   * subtracted them in prose — and for a category it had no refund figure at all.
   */
  netOfRefunds?: {
    refunds: number;
    total: number;
    perCompleteMonth: number | null;
    months: { month: string; refunds: number; net: number }[];
    basis: string;
  };
  basis: string;
  completeness: Completeness;
}

const BASIS: Record<FlowMeasure, string> = {
  spending: 'economic spending (SPENDING + FEE + INTEREST rows, gross of refunds — when refunds fall '
    + 'in the window `netOfRefunds` carries what it cost after them); card and debt '
    + 'payments and movements between own accounts are NOT in it',
  income: 'observed deposits classified INCOME at their settled nominal amount; not gross pay, '
    + 'not a salary figure — a month can hold two or three paychecks',
  economicNet: 'income − max(0, spending − refunds); debt and card payments are NOT subtracted',
  cardAndDebtPayments: 'counted cash legs of payments toward liabilities',
  transfersBetweenOwnAccounts: 'transfer legs between own accounts (each movement has two legs)',
  refunds: 'REFUND rows',
};

/** Refunds dated in month `m` for a spending measure — the category's own, or all. */
export function refundsOf(m: MonthRow, category?: string): number {
  if (category) return m.byCategory.find((x) => x.category === category)?.refundTotal ?? 0;
  return m.refundTotal;
}

export function valueOf(m: MonthRow, measure: FlowMeasure, category?: string): number {
  if (category) {
    const c = m.byCategory.find((x) => x.category === category);
    return c ? c.total : 0;
  }
  switch (measure) {
    case 'spending': return m.expenseTotal;
    case 'income': return m.incomeTotal;
    case 'refunds': return m.refundTotal;
    case 'economicNet': return m.incomeTotal - Math.max(0, m.expenseTotal - m.refundTotal);
    case 'cardAndDebtPayments': return m.debtPaymentTotal;
    case 'transfersBetweenOwnAccounts': return m.transferTotal;
  }
}

/**
 * The completeness of a window, from record bounds, the read's own clamp, and
 * the population's source health.
 */
export function completenessFor(period: ResolvedPeriod, cov: DataCoverage, rows: MonthRow[]): Completeness {
  // Listed only when a contributing source is behind — then ALL of them are, so a
  // reader sees which are fine and which are not. An all-observed list is noise.
  const byComponent = cov.components && cov.components.some((c) => c.tier !== 'observed')
    ? Object.fromEntries(cov.components.map((c) => [c.key, c.tier])) : undefined;
  const base = { ...(byComponent ? { byComponent } : {}) };
  if (cov.corpusFrom === null) {
    return { tier: 'unknown', reason: 'no transaction history is available for this Space', ...base };
  }
  if (period.from < cov.corpusFrom) {
    return { tier: 'incomplete', coverageFrom: cov.corpusFrom, ...base,
      reason: `the window opens before transaction history begins on ${cov.corpusFrom}; the total cannot be whole` };
  }
  if (cov.readFrom && cov.readFrom > period.from) {
    return { tier: 'incomplete', coverageFrom: cov.readFrom, ...base,
      reason: `the read is capped to begin ${cov.readFrom}; days of this window before that were not read` };
  }
  if (cov.fetchCapHit || rows.some((m) => m.truncated)) {
    return { tier: 'incomplete', coverageFrom: cov.corpusFrom, ...base,
      reason: 'the read hit the row ceiling and the oldest rows of the window were dropped' };
  }
  // A source is a gap for THIS window only if it has not delivered rows up to the
  // window's end. A brokerage that never posts banking rows is not a component at
  // all (the caller left it out); a card stale since before the window began is.
  const gaps = (cov.components ?? []).filter((c) =>
    RANK[c.tier] > RANK.observed && (c.deliveredThrough === null || c.deliveredThrough < period.to));
  if (gaps.length) {
    return { tier: worstTier(gaps.map((g) => g.tier)), coverageFrom: cov.corpusFrom, ...base,
      reason: `${gaps.map((g) => `${g.key}${g.deliveredThrough ? ` (rows through ${g.deliveredThrough})` : ''}`).join(', ')} `
        + 'has not delivered rows up to the end of this window; recent days of it may be missing' };
  }
  return { tier: 'observed', coverageFrom: cov.corpusFrom, ...base,
    reason: 'computed from posted transactions within history' };
}

/**
 * Measure one flow over a resolved period.
 *
 * Every calendar month the window spans is present — a month with no rows is a
 * real zero, not a missing month — and a month clipped by the window's edges is
 * marked partial from the PERIOD, not inferred from the rows.
 */
export function measure(
  kind: FlowMeasure, rows: MonthRow[], period: ResolvedPeriod, cov: DataCoverage, category?: string,
): MeasureResult {
  const byMonth = new Map(rows.map((m) => [m.month, m]));
  const months = monthsSpanned(period).map((month) => {
    const row = byMonth.get(month);
    return {
      month,
      value: round2(row ? valueOf(row, kind, category) : 0),
      partial: isPartialMonth(month, period) || !!row?.partial,
    };
  });
  const whole = months.filter((m) => !m.partial);
  const total = round2(months.reduce((n, m) => n + m.value, 0));
  const hi = whole.length ? whole.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const lo = whole.length ? whole.reduce((a, b) => (b.value < a.value ? b : a)) : null;
  const inWindow = rows.filter((m) => months.some((x) => x.month === m.month));
  const netOfRefunds = kind === 'spending' ? netOfRefundsFor(months, byMonth, category) : null;
  const allSpending = category ? round2(inWindow.reduce((n, m) => n + valueOf(m, 'spending'), 0)) : null;
  return {
    measure: kind, ...(category ? { category } : {}), unit: 'USD', period, total, months,
    ...(allSpending !== null ? { ofAllSpending: { total: allSpending,
      sharePct: allSpending < MONEY_EPSILON ? null : round2((total / allSpending) * 100) } } : {}),
    ...(netOfRefunds ? { netOfRefunds } : {}),
    completeMonths: whole.length,
    partialMonths: months.filter((m) => m.partial).map((m) => m.month),
    perCompleteMonth: whole.length ? round2(whole.reduce((n, m) => n + m.value, 0) / whole.length) : null,
    highest: hi ? { month: hi.month, value: hi.value } : null,
    lowest: lo ? { month: lo.month, value: lo.value } : null,
    basis: category
      ? `debit-only rows in category ${category} (a category line within spending, ≤ spending; gross of `
        + 'refunds — `netOfRefunds` carries the net when the category had any)'
      : BASIS[kind],
    completeness: completenessFor(period, cov, inWindow),
  };
}

/**
 * The refund side of a spending measure: per month max(0, gross − refunds), summed.
 * Null when no refund is dated in the window — a figure with nothing to explain
 * carries nothing extra.
 */
function netOfRefundsFor(
  months: { month: string; value: number; partial: boolean }[],
  byMonth: Map<string, MonthRow>, category?: string,
): MeasureResult['netOfRefunds'] | null {
  const lines = months.map((m) => {
    const row = byMonth.get(m.month);
    const refunds = round2(row ? refundsOf(row, category) : 0);
    return { month: m.month, partial: m.partial, refunds, net: round2(Math.max(0, m.value - refunds)) };
  });
  const refunds = round2(lines.reduce((n, l) => n + l.refunds, 0));
  if (refunds < MONEY_EPSILON) return null;
  const whole = lines.filter((l) => !l.partial);
  return {
    refunds,
    total: round2(lines.reduce((n, l) => n + l.net, 0)),
    perCompleteMonth: whole.length ? round2(whole.reduce((n, l) => n + l.net, 0) / whole.length) : null,
    months: lines.filter((l) => l.refunds >= MONEY_EPSILON).map(({ month, refunds: r, net }) => ({ month, refunds: r, net })),
    basis: 'spending less the REFUND rows dated in the same month, each month floored at zero; a refund '
      + 'counts in the month it arrived, not the month of the purchase. `total` beside this is gross',
  };
}

export interface Comparison {
  measure: FlowMeasure;
  category?: string;
  left: MeasureResult;
  right: MeasureResult;
  /** Which figure the two sides were compared on. */
  comparedOn: 'total' | 'perCompleteMonth';
  /** left − right on that figure. null when no comparable figure exists; `notComparable` says why. */
  change: { abs: number; pct: number | null; direction: 'UP' | 'DOWN' | 'FLAT' } | null;
  /**
   * REFUND-1 — the same comparison on spending NET of refunds, present when either
   * side had refunds. A side with none contributes its gross figure (its net IS
   * its gross). Computed here so "did I spend more on travel" is never answered
   * by subtracting a refund from one side in prose.
   */
  changeNetOfRefunds?: { left: number; right: number; abs: number; pct: number | null; direction: 'UP' | 'DOWN' | 'FLAT' };
  notComparable?: string;
  completeness: Completeness;
  caveats: string[];
}

/**
 * Compare two measures.
 *
 * Equal-length windows, or two calendar-complete windows with the same number of
 * whole months, compare totals. Otherwise the comparison is per whole calendar
 * month, and when a side has none there is no difference to state — both totals
 * are returned and the refusal is named. A zero base gives `pct: null`, never
 * Infinity; a difference under half a cent is FLAT.
 */
export function compare(left: MeasureResult, right: MeasureResult): Comparison {
  const sameShape = left.period.days === right.period.days
    || (left.period.calendarComplete && right.period.calendarComplete
      && left.completeMonths === right.completeMonths);
  const comparedOn: Comparison['comparedOn'] = sameShape ? 'total' : 'perCompleteMonth';
  const l = comparedOn === 'total' ? left.total : left.perCompleteMonth;
  const r = comparedOn === 'total' ? right.total : right.perCompleteMonth;
  const caveats: string[] = [];
  if (comparedOn === 'perCompleteMonth') {
    caveats.push('the windows differ in length, so the comparison is per whole calendar month');
  }
  const partials = [...left.partialMonths, ...right.partialMonths];
  if (partials.length) caveats.push(`partial months in the comparison: ${partials.join(', ')}`);
  if ((left.period.kind === 'TO_DATE' || left.period.clampedToCeiling) && right.period.calendarComplete) {
    caveats.push('a period to date is compared against a WHOLE period; the difference is partly the days not yet elapsed');
  }
  const completeness = [left.completeness, right.completeness]
    .reduce((w, c) => (RANK[c.tier] > RANK[w.tier] ? c : w));
  const head = { measure: left.measure, ...(left.category ? { category: left.category } : {}), left, right };
  if (l === null || r === null) {
    return { ...head, comparedOn, change: null, completeness, caveats,
      notComparable: 'the windows differ in length and a side holds no whole calendar month; both '
        + 'totals are shown and no difference is computed — compare the same elapsed days '
        + '(PREVIOUS on a to-date period) or two whole months instead' };
  }
  const diff = (a: number, b: number) => {
    const abs = round2(a - b);
    const pct = Math.abs(b) < MONEY_EPSILON ? null : round2((abs / Math.abs(b)) * 100);
    const direction: 'UP' | 'DOWN' | 'FLAT' = Math.abs(abs) < MONEY_EPSILON ? 'FLAT' : abs > 0 ? 'UP' : 'DOWN';
    return { abs, pct, direction };
  };
  const netFigure = (m: MeasureResult, gross: number): number | null =>
    !m.netOfRefunds ? gross : comparedOn === 'total' ? m.netOfRefunds.total : m.netOfRefunds.perCompleteMonth;
  const ln = netFigure(left, l);
  const rn = netFigure(right, r);
  const changeNetOfRefunds = (left.netOfRefunds || right.netOfRefunds) && ln !== null && rn !== null
    ? { left: ln, right: rn, ...diff(ln, rn) } : null;
  return { ...head, comparedOn, change: diff(l, r), ...(changeNetOfRefunds ? { changeNetOfRefunds } : {}),
    completeness, caveats };
}
