/**
 * lib/ai/measures/baseline.ts   (M1 — measures & comparison)
 *
 * A BASELINE is the monthly rate chosen for forward reasoning; a DERIVED figure
 * is arithmetic over baselines and the current position. Neither is a measure:
 * a measure says what happened over a requested period, a baseline says which
 * figure stands for "a month" — and the two are never collapsed.
 *
 * ⚠️ ONE PRECEDENCE, THE CANONICAL ONE. The expense baseline is chosen by
 * `resolveExpenseBaseline` (lib/liquidity/expense-baseline) — STATED > DECLARED >
 * MEASURED, a non-positive figure refused — exactly as the assessment engine, the
 * Liquidity workspace and the Brief choose it. This module hands that resolver
 * the measured figure it already computed and DECORATES the answer with the
 * window, the complete-month count and the completeness the measure carried.
 * It does not decide precedence; there is no second chain.
 *
 * ⚠️ THE MEASURED RUNG IS NET ECONOMIC SPENDING (NET-BASELINE-1). "How much do I
 * spend a month" is charges LESS the refunds dated in the same month, each month
 * floored at zero — the spending measure's own `netOfRefunds`, which is the
 * fold's refund total through the canonical clamp. This module computes no
 * refund: `economicSpendingOf` only READS the gross measure and its
 * `netOfRefunds`. Before this, the measured baseline was the gross mean, so
 * surplus, savings rate, runway and every "N months of expenses" were priced at
 * what was CHARGED while the Spending-by-category view showed what was SPENT.
 * When refunds moved the figure materially the baseline also carries `gross` and
 * `refundEffect`, so the model explains the gap from evidence, never by
 * subtracting two tool figures in prose.
 *
 * ⚠️ THE BASIS IS ALWAYS ECHOED. Five legitimate "monthly spending" figures exist
 * on the recovered Space (4,346 / 5,797 / 6,719 / 7,000 / 8,636 over 2 / 3 / 6 /
 * 12 / 24 complete months) and none is wrong; a figure that does not name its
 * window is the defect. The model chooses the window; code names it.
 *
 * ⚠️ EVERY DERIVED FIGURE SHIPS WITH ITS NUMERATOR AND DENOMINATOR, and a zero or
 * unknown denominator is an explicit refusal — never Infinity, never NaN. A
 * savings rate additionally requires a RECURRING income basis (STATED or
 * CADENCE): a retiree whose only measured income is interest produced an exact
 * −2,817% in the prototype, which is arithmetic, not a savings rate.
 *
 * Pure. No data access, no clock.
 */

import { resolveExpenseBaseline, type ExpenseBaselineBasis } from '@/lib/liquidity/expense-baseline';
import { MATERIAL_MONTHLY_REFUND_EFFECT } from '@/lib/transactions/cash-flow';
import type { MeasureResult, Completeness } from './measure';

const round2 = (n: number) => Math.round(n * 100) / 100;
const MONEY_EPSILON = 0.005;
const positive = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

export type ExpenseBasis = ExpenseBaselineBasis;
export type IncomeBasis = 'STATED' | 'CADENCE' | 'MEASURED';

export interface BaselineWindow { from: string; to: string; label: string }

export interface ExpenseBaseline {
  amount: number;
  basis: ExpenseBasis;
  /** MEASURED only: which months were averaged. */
  window?: BaselineWindow;
  completeMonths?: number;
  months?: { month: string; value: number }[];
  completeness?: Completeness;
  /**
   * MEASURED only, and only when refunds moved the monthly figure materially:
   * mean GROSS charges per complete month and what refunds took off.
   * `gross − refundEffect = amount`, exactly.
   */
  gross?: number;
  refundEffect?: number;
  note: string;
}

/**
 * NET-BASELINE-1 — a spending measure read as ECONOMIC spending: the monthly
 * figure net of refunds, the per-month net values, and the gross figure beside
 * them. Reads `MeasureResult.netOfRefunds` (absent ⇒ no refund fell in the
 * window ⇒ net IS gross); it never subtracts a refund itself.
 */
export interface EconomicSpending {
  perCompleteMonth: number | null;
  grossPerCompleteMonth: number | null;
  /** `gross − net` per complete month, ≥ 0; 0 when no refund fell in the window. */
  refundEffect: number;
  material: boolean;
  months: { month: string; value: number; partial: boolean }[];
  highest: { month: string; value: number } | null;
  lowest: { month: string; value: number } | null;
}

export function economicSpendingOf(m: MeasureResult): EconomicSpending {
  const netByMonth = new Map((m.netOfRefunds?.months ?? []).map((x) => [x.month, x.net]));
  const months = m.months.map((x) => ({ month: x.month, partial: x.partial, value: netByMonth.get(x.month) ?? x.value }));
  const whole = months.filter((x) => !x.partial);
  const net = m.netOfRefunds ? m.netOfRefunds.perCompleteMonth : m.perCompleteMonth;
  const refundEffect = net !== null && m.perCompleteMonth !== null ? round2(m.perCompleteMonth - net) : 0;
  const pick = (cmp: (a: number, b: number) => boolean) =>
    whole.reduce<{ month: string; value: number } | null>(
      (best, x) => (best === null || cmp(x.value, best.value) ? { month: x.month, value: x.value } : best), null);
  return {
    perCompleteMonth: net,
    grossPerCompleteMonth: m.perCompleteMonth,
    refundEffect,
    material: refundEffect >= MATERIAL_MONTHLY_REFUND_EFFECT,
    months,
    highest: pick((a, b) => a > b),
    lowest: pick((a, b) => a < b),
  };
}

/**
 * One recurring stream, ALREADY converted to a monthly figure by the cadence
 * authority's adapter (`lib/ai/forecast/income-evidence`). This layer adds
 * streams up; it never converts a cadence itself.
 */
export interface IncomeStreamEvidence {
  label?: string;
  cadence: string | null;
  /** Per-occurrence settled amount, when assertable. */
  typicalAmount: number | null;
  /** Per month at its cadence, unrounded. Null when cadence or amount is unknown. */
  monthlyEquivalent: number | null;
  stillPaying: boolean;
}

export interface IncomeBaseline {
  amount: number;
  basis: IncomeBasis;
  window?: BaselineWindow;
  completeMonths?: number;
  streams?: { label?: string; cadence: string; typicalAmount: number; monthlyEquivalent: number }[];
  completeness?: Completeness;
  note: string;
}

/**
 * The expense baseline, through the canonical resolver, decorated with the
 * measure's own provenance when the measured rung answered.
 */
export function resolveExpenseBaselineFromEvidence(e: {
  stated?: number | null;
  declared?: number | null;
  measured?: MeasureResult | null;
}): ExpenseBaseline | null {
  const m = e.measured ?? null;
  // NET economic spending is the measured candidate — see the header.
  const eco = m ? economicSpendingOf(m) : null;
  const resolved = resolveExpenseBaseline({
    stated: e.stated, declared: e.declared, measured: eco?.perCompleteMonth ?? null,
  });
  if (!resolved) return null;
  if (resolved.basis === 'STATED') {
    return { amount: round2(resolved.amount), basis: 'STATED',
      note: 'the monthly spending stated in this conversation; it outranks the product setting and '
        + 'the measured figure for this turn only and is not saved. To run a scenario at this level, '
        + 'pass it to the scenario tool as `assumedMonthlySpending` — otherwise the scenario spends at '
        + 'the observed level while its floor assumes this one' };
  }
  if (resolved.basis === 'DECLARED') {
    return { amount: round2(resolved.amount), basis: 'DECLARED',
      note: 'the monthly expenses the user set in the product; outranks the measured figure' };
  }
  return {
    amount: resolved.amount, basis: 'MEASURED',
    ...(m ? {
      window: { from: m.period.from, to: m.period.to, label: m.period.label },
      completeMonths: m.completeMonths,
      months: eco!.months.filter((x) => !x.partial).map((x) => ({ month: x.month, value: x.value })),
      completeness: m.completeness,
      ...(eco!.material && eco!.grossPerCompleteMonth !== null
        ? { gross: eco!.grossPerCompleteMonth, refundEffect: eco!.refundEffect } : {}),
    } : {}),
    note: 'mean NET economic spending per WHOLE calendar month over the named window: charges less the '
      + 'refunds dated in the same month (a refund counts in the month it arrives, and a month never goes '
      + 'below zero). A one-off month is in the mean, so say which window when the spread matters.'
      + (eco?.material ? ' `gross` is what was charged per month and `refundEffect` what refunds took off '
        + '— quote them as given; do not subtract.' : ''),
  };
}

/**
 * The income baseline: STATED > CADENCE (settled recurring deposits at their
 * observed level — the cash projection's own basis) > MEASURED (complete-month
 * mean of observed deposits).
 */
export function resolveIncomeBaseline(e: {
  stated?: number | null;
  streams?: IncomeStreamEvidence[];
  measured?: MeasureResult | null;
}): IncomeBaseline | null {
  if (positive(e.stated)) {
    return { amount: round2(e.stated), basis: 'STATED',
      note: 'the monthly income stated in this conversation; not saved' };
  }
  const live = (e.streams ?? [])
    .filter((s) => s.stillPaying && s.cadence && positive(s.typicalAmount) && positive(s.monthlyEquivalent))
    .map((s) => ({
      ...(s.label ? { label: s.label } : {}),
      cadence: s.cadence as string, typicalAmount: s.typicalAmount as number,
      exact: s.monthlyEquivalent as number,
    }));
  if (live.length) {
    // Full precision end to end, rounded ONCE at the edge (the money authority's
    // D-4 rule): summing rounded streams would drift a cent from the projection.
    return {
      amount: round2(live.reduce((n, s) => n + s.exact, 0)), basis: 'CADENCE',
      streams: live.map(({ exact, ...s }) => ({ ...s, monthlyEquivalent: round2(exact) })),
      note: 'settled recurring deposits at their observed level and cadence (biweekly = 26 a year) — '
        + 'the same basis the cash projection uses; nominal deposits, not gross pay',
    };
  }
  const m = e.measured;
  if (m && positive(m.perCompleteMonth)) {
    return {
      amount: m.perCompleteMonth, basis: 'MEASURED',
      window: { from: m.period.from, to: m.period.to, label: m.period.label },
      completeMonths: m.completeMonths, completeness: m.completeness,
      note: 'mean of observed deposits per whole calendar month; a month can hold two or three '
        + 'paychecks, and interest or one-off deposits are in it',
    };
  }
  return null;
}

export type Unavailable = { unavailable: string };

/**
 * The baseline a threshold multiplied, by REFERENCE: enough to say which figure
 * it was (amount, basis, window) without repeating the months and completeness
 * already carried once on the expense baseline itself.
 */
export interface BaselineRef { amount: number; basis: ExpenseBasis; window?: BaselineWindow; completeMonths?: number }
export const baselineRef = (b: ExpenseBaseline): BaselineRef => ({
  amount: b.amount, basis: b.basis,
  ...(b.window ? { window: b.window } : {}),
  ...(b.completeMonths !== undefined ? { completeMonths: b.completeMonths } : {}),
});

export interface ExpenseThreshold {
  rule: string;
  monthsOfExpenses: number;
  amount: number;
  baseline: BaselineRef;
  /**
   * Where current liquid stands against this threshold: `difference` = liquid −
   * amount (negative = short of it). Present when liquid is established — so
   * "how far am I from six months" is read, never subtracted in prose.
   */
  vsLiquid?: { liquid: number; difference: number; status: 'BELOW' | 'AT_OR_ABOVE' };
}

export interface Derived {
  monthlySurplus:
    | { amount: number; income: { amount: number; basis: IncomeBasis }; expense: { amount: number; basis: ExpenseBasis }; basis: string }
    | Unavailable;
  savingsRate:
    | { ratePct: number; numerator: number; denominator: number; incomeBasis: IncomeBasis; expenseBasis: ExpenseBasis; basis: string }
    | Unavailable;
  runway:
    | { months: number; liquid: number; monthlyExpense: number; expenseBasis: ExpenseBasis; basis: string;
        withMinimumDebtService?: { months: number; monthlyOutgo: number; minimumDebtService: number } }
    | Unavailable;
  thresholds: (ExpenseThreshold | { rule: string; monthsOfExpenses: number } & Unavailable)[];
}

/** One threshold: N months × one named baseline. Identity preserved beside the amount. */
export function expenseThreshold(
  monthsOfExpenses: number, baseline: ExpenseBaseline | null, liquid: number | null = null,
): ExpenseThreshold | { rule: string; monthsOfExpenses: number } & Unavailable {
  const rule = `${monthsOfExpenses} month${monthsOfExpenses === 1 ? '' : 's'} of expenses`;
  if (!positive(monthsOfExpenses)) {
    return { rule, monthsOfExpenses, unavailable: 'months of expenses must be a positive number' };
  }
  if (!baseline) {
    return { rule, monthsOfExpenses, unavailable: 'no expense baseline could be established' };
  }
  const amount = round2(monthsOfExpenses * baseline.amount);
  return { rule, monthsOfExpenses, amount, baseline: baselineRef(baseline),
    ...(liquid !== null && Number.isFinite(liquid) ? { vsLiquid: {
      liquid, difference: round2(liquid - amount),
      status: liquid - amount < -MONEY_EPSILON ? 'BELOW' as const : 'AT_OR_ABOVE' as const } } : {}) };
}

export function derive(args: {
  expense: ExpenseBaseline | null;
  income: IncomeBaseline | null;
  liquid: number | null;
  /** Σ known minimum payments on owed liabilities, when on record. */
  minimumDebtService?: number | null;
  monthsOfExpenses?: number[];
}): Derived {
  const { expense, income, liquid } = args;

  const monthlySurplus: Derived['monthlySurplus'] = expense && income
    ? { amount: round2(income.amount - expense.amount),
        income: { amount: income.amount, basis: income.basis },
        expense: { amount: expense.amount, basis: expense.basis },
        basis: `income baseline (${income.basis}) − expense baseline (${expense.basis}); debt payments and `
          + 'investment contributions are allocations of this surplus, not deductions from it; this is a '
          + 'steady-state rate, not a measured total over a window' }
    : { unavailable: !income ? 'no income baseline could be established'
        : 'no expense baseline could be established' };

  const recurring = income && (income.basis === 'CADENCE' || income.basis === 'STATED');
  const savingsRate: Derived['savingsRate'] = expense && income && recurring && income.amount > 0
    ? { ratePct: round2(((income.amount - expense.amount) / income.amount) * 100),
        numerator: round2(income.amount - expense.amount), denominator: income.amount,
        incomeBasis: income.basis, expenseBasis: expense.basis,
        basis: 'economic net as a share of recurring income (nominal deposits) — the ONLY savings-rate '
          + 'definition supported here; cash-saved and net-worth-based rates are different measures and '
          + 'are not computed' }
    : { unavailable: !expense ? 'no expense baseline could be established'
        : !income ? 'no income baseline could be established'
        : !recurring ? 'no recurring income level is established (income is only a window mean, which may '
            + 'be interest or one-off deposits) — a rate over it would be arithmetic, not a savings rate'
        : 'income baseline is not positive' };

  const runway: Derived['runway'] = expense && liquid !== null && Number.isFinite(liquid)
    ? { months: round2(liquid / expense.amount), liquid, monthlyExpense: expense.amount, expenseBasis: expense.basis,
        basis: 'checking + savings (liquid) ÷ monthly expense baseline; investments and digital assets are '
          + 'not liquid here; minimum debt service is NOT in the baseline',
        ...(positive(args.minimumDebtService) ? { withMinimumDebtService: {
          months: round2(liquid / (expense.amount + args.minimumDebtService)),
          monthlyOutgo: round2(expense.amount + args.minimumDebtService),
          minimumDebtService: round2(args.minimumDebtService) } } : {}) }
    : { unavailable: !expense ? 'no expense baseline: a zero or unknown baseline is not infinite runway'
        : 'no liquid balance is established' };

  const thresholds = (args.monthsOfExpenses ?? []).map((n) => expenseThreshold(n, expense, liquid));
  return { monthlySurplus, savingsRate, runway, thresholds };
}

/**
 * "Keep N months of expenses" as a scenario floor: the dollar literal the ledger
 * needs, and the derivation that keeps its identity beside it.
 *
 * ⚠️ RESOLVED BY THE SCENARIO'S OWN SPENDING LEVEL, THROUGH THE CANONICAL RESOLVER.
 * The evidence handed in is what the scenario spends at — the stated
 * `assumedMonthlySpending` first, else the observed rate the cash spine runs on —
 * so the floor and the spending in force are the same figure by construction. A
 * scenario that kept six months of one figure while spending another would be
 * two assumptions wearing one sentence.
 */
export interface FloorDerivation {
  liquidFloor: number;
  derivedFrom: { rule: string; monthsOfExpenses: number; baseline: { amount: number; basis: ExpenseBasis; note: string };
    /** S1 — the first movement date this level governs, when spending changes over the horizon. */
    inForceFrom?: string };
}
export function resolveMonthsOfExpensesFloor(args: {
  monthsOfExpenses: number;
  stated?: number | null;
  observedMonthly?: number | null;
}): FloorDerivation | Unavailable {
  const n = Number(args.monthsOfExpenses);
  if (!positive(n)) return { unavailable: '`liquidFloorMonthsOfExpenses` must be a positive number of months' };
  // The canonical resolver, handed the scenario's two rungs. There is no DECLARED
  // rung here because the cash spine has none: a scenario spends at the stated
  // level or the observed one, and its floor multiplies the same figure.
  const resolved = resolveExpenseBaseline({ stated: args.stated, measured: args.observedMonthly });
  if (!resolved) {
    return { unavailable: 'no monthly spending level is established for this scenario, so "months of '
      + 'expenses" has nothing to multiply — state `assumedMonthlySpending` or pass `liquidFloor` in dollars' };
  }
  const baseline: ExpenseBaseline = resolved.basis === 'STATED'
    ? { amount: round2(resolved.amount), basis: 'STATED',
        note: 'the monthly spending stated for this scenario (`assumedMonthlySpending`)' }
    : { amount: round2(resolved.amount), basis: 'MEASURED',
        note: 'the observed spending rate this scenario spends at — the mean of the most recent complete '
          + 'months the cash projection averages' };
  const t = expenseThreshold(n, baseline) as ExpenseThreshold;
  return { liquidFloor: t.amount,
    derivedFrom: { rule: t.rule, monthsOfExpenses: n,
      baseline: { amount: baseline.amount, basis: baseline.basis, note: baseline.note } } };
}
