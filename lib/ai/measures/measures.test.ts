/**
 * lib/ai/measures/measures.test.ts   (M1 — measures & comparison)
 *
 * THE SEMANTICS, PINNED PURELY. Ten synthetic profiles, folded by the REAL
 * economic fold (`foldEconomicRow`), measured, compared, turned into baselines
 * and derived figures by the production modules. No database, no clock, no
 * personal money: every expected figure below is arithmetic over a generator
 * written in this file.
 *
 *   A  measured monthly spending names its basis and window
 *   B  STATED / DECLARED / MEASURED stay distinct (one canonical precedence)
 *   C  monthly income — CADENCE vs MEASURED
 *   D  deterministic monthly surplus (a baseline difference, not a window ÷ 3)
 *   E  period-vs-period comparison
 *   F  partial-period comparison (elapsed-equivalent; whole-vs-partial refused)
 *   G  category comparison
 *   H  "N months of expenses" keeps its identity
 *   I  runway
 *   J  threshold → the scenario floor literal (+ K: the L1 target is untouched)
 *   L  incomplete evidence propagates, population-aware and window-aware
 *   M  zero denominators — never Infinity, never NaN
 *   N  every derived figure ships with the operands that produce it
 *   P  period pins (investigation §12) and refusals
 *   S  source scans — no day-normalisation, no second precedence chain
 *
 *   npx tsx lib/ai/measures/measures.test.ts
 */

import { readFileSync } from 'node:fs';
import { foldEconomicRow } from '@/lib/transactions/cash-flow';
import { isDebtPayment, isTransfer } from '@/lib/transactions/flow-predicates';
import {
  resolvePeriod, resolveCompareTo, parsePeriodSpec, parseCompareToSpec, completeMonthsPeriod,
  type PeriodSpec, type CompareToSpec,
} from './period';
import {
  measure, compare, type MonthRow, type DataCoverage, type FlowMeasure,
} from './measure';
import {
  resolveExpenseBaselineFromEvidence, resolveIncomeBaseline, derive, expenseThreshold,
  resolveMonthsOfExpensesFloor, type IncomeStreamEvidence,
} from './baseline';
import { incomeStreamEvidence, OBSERVED_SPENDING_WINDOW_MONTHS } from '@/lib/ai/forecast/income-evidence';

let failures = 0;
let passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

type Tx = { date: string; flow: string; amount: number; category?: string; incomeClass?: string };

/** Fold rows into monthly rows for a window exactly as the assembler does — through the ONE fold. */
function fold(rows: Tx[], from: string, to: string): MonthRow[] {
  const by = new Map<string, MonthRow>();
  for (const t of rows) {
    if (t.date < from || t.date > to) continue;
    const month = t.date.slice(0, 7);
    let m = by.get(month);
    if (!m) {
      m = { month, incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0, transferTotal: 0, byCategory: [] };
      by.set(month, m);
    }
    const acc = { income: 0, spendGross: 0, refunds: 0 };
    foldEconomicRow(acc, { flowType: t.flow, amount: t.amount, incomeClass: t.incomeClass ?? null });
    m.incomeTotal += acc.income; m.expenseTotal += acc.spendGross; m.refundTotal += acc.refunds;
    if (isDebtPayment(t.flow as never)) m.debtPaymentTotal += Math.abs(t.amount);
    if (isTransfer(t.flow as never)) m.transferTotal += Math.abs(t.amount);
    if (acc.spendGross > 0 && t.category) {
      let c = m.byCategory.find((x) => x.category === t.category);
      if (!c) { c = { category: t.category, total: 0, count: 0 }; m.byCategory.push(c); }
      c.total += Math.abs(t.amount); c.count = (c.count ?? 0) + 1;
    }
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

const CEIL = '2026-09-16';
const cov = (rows: Tx[], extra: Partial<DataCoverage> = {}): DataCoverage => {
  const dates = rows.map((r) => r.date).sort();
  return { corpusFrom: dates[0] ?? null, corpusTo: dates.at(-1) ?? null, fetchCapHit: false, ...extra };
};
const run = (rows: Tx[], kind: FlowMeasure, spec: PeriodSpec, c: DataCoverage = cov(rows), category?: string) => {
  const p = resolvePeriod(spec, CEIL);
  return measure(kind, fold(rows, p.from, p.to), p, c, category);
};
const cmp = (rows: Tx[], kind: FlowMeasure, spec: PeriodSpec, to: CompareToSpec, c: DataCoverage = cov(rows), category?: string) => {
  const p = resolvePeriod(spec, CEIL);
  const q = resolveCompareTo(p, spec, to, CEIL);
  return compare(measure(kind, fold(rows, p.from, p.to), p, c, category),
    measure(kind, fold(rows, q.from, q.to), q, c, category));
};

// ── Profiles ─────────────────────────────────────────────────────────────────
const d = (y: number, m: number, day: number) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
function monthsBetween(from: [number, number], to: [number, number]): [number, number][] {
  const out: [number, number][] = []; let [y, m] = from;
  while (y < to[0] || (y === to[0] && m <= to[1])) { out.push([y, m]); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const profile = (gen: (y: number, m: number) => Tx[], span: [[number, number], [number, number]] = [[2025, 1], [2026, 9]]) =>
  monthsBetween(span[0], span[1]).flatMap(([y, m]) => gen(y, m));
const spend = (y: number, m: number, groceries: number, dining: number, other: number, day = 5): Tx[] => [
  { date: d(y, m, day), flow: 'SPENDING', amount: -groceries, category: 'Groceries' },
  { date: d(y, m, day + 7), flow: 'SPENDING', amount: -dining, category: 'Dining' },
  { date: d(y, m, day + 14), flow: 'SPENDING', amount: -other, category: 'Other' }];
const pay = (y: number, m: number, amt: number, days: number[]): Tx[] =>
  days.map((dd) => ({ date: d(y, m, dd), flow: 'INCOME', amount: amt, incomeClass: 'EARNED_INCOME' }));
const stream = (cadence: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY', typicalAmount: number, stillPaying = true): IncomeStreamEvidence =>
  incomeStreamEvidence({ cadence, typicalAmount, stillPaying });
const semimonthly = (amount: number): IncomeStreamEvidence[] => [stream('SEMIMONTHLY', amount)];

const P: Record<string, { name: string; rows: Tx[]; streams: IncomeStreamEvidence[] }> = {
  steady: { name: 'steady salaried', streams: semimonthly(3000),
    rows: profile((y, m) => [...pay(y, m, 3000, [1, 15]), ...spend(y, m, 800, 400, 1800),
      { date: d(y, m, 20), flow: 'DEBT_PAYMENT', amount: -900 }, { date: d(y, m, 21), flow: 'TRANSFER', amount: -500 }]) },
  debtHeavy: { name: 'debt-heavy', streams: semimonthly(2500),
    rows: profile((y, m) => [...pay(y, m, 2500, [1, 15]), ...spend(y, m, 700, 300, 2500),
      { date: d(y, m, 20), flow: 'DEBT_PAYMENT', amount: -1800 }, { date: d(y, m, 2), flow: 'INTEREST', amount: -220 }]) },
  highSpend: { name: 'high-spend with a one-off', streams: semimonthly(9000),
    rows: profile((y, m) => [...pay(y, m, 9000, [1, 15]), ...spend(y, m, 2000, 3000, 9000),
      ...(y === 2026 && m === 5 ? [{ date: d(y, m, 9), flow: 'SPENDING', amount: -12000, category: 'Travel' }] : [])]) },
  irregular: { name: 'irregular quarterly income', streams: [],
    rows: profile((y, m) => [...(m % 3 === 0 ? pay(y, m, 14000, [10]) : []), ...spend(y, m, 900, 500, 2600)]) },
  p2p: { name: 'paycheck-to-paycheck', streams: semimonthly(1900),
    rows: profile((y, m) => [...pay(y, m, 1900, [1, 15]), ...spend(y, m, 900, 400, 2450), { date: d(y, m, 28), flow: 'FEE', amount: -35 }]) },
  retiree: { name: 'retiree, no payroll', streams: [],
    rows: profile((y, m) => [{ date: d(y, m, 3), flow: 'TRANSFER', amount: 4500 },
      { date: d(y, m, 4), flow: 'INCOME', amount: 120, incomeClass: 'INTEREST_INCOME' }, ...spend(y, m, 700, 300, 2500)]) },
  saver: { name: 'house saver', streams: semimonthly(5000),
    rows: profile((y, m) => [...pay(y, m, 5000, [1, 15]), ...spend(y, m, 700, 300, 2000), { date: d(y, m, 16), flow: 'TRANSFER', amount: -5000 }]) },
  investor: { name: 'investment-heavy', streams: semimonthly(6000),
    rows: profile((y, m) => [...pay(y, m, 6000, [1, 15]), ...spend(y, m, 800, 600, 2600),
      { date: d(y, m, 17), flow: 'TRANSFER', amount: -6000 }, { date: d(y, m, 18), flow: 'INVESTMENT', amount: -6000, category: 'Buy' }]) },
  incomplete: { name: 'incomplete source (history starts 2026-06-10)', streams: semimonthly(3000),
    rows: profile((y, m) => [...pay(y, m, 3000, [1, 15]), ...spend(y, m, 800, 400, 1800)], [[2026, 6], [2026, 9]])
      .filter((r) => r.date >= '2026-06-10') },
  declaredBudget: { name: 'declared-budget user', streams: semimonthly(4000),
    rows: profile((y, m) => [...pay(y, m, 4000, [1, 15]), ...spend(y, m, 900, 600, 2700)]) },
  categoryHeavy: { name: 'category-heavy spending', streams: semimonthly(4000),
    rows: profile((y, m) => [...pay(y, m, 4000, [1, 15]), ...spend(y, m, 600, y === 2026 && m >= 7 ? 1400 : 700, 1500),
      { date: d(y, m, 12), flow: 'SPENDING', amount: -(m === 7 ? 3000 : 200), category: 'Travel' }]) },
};

// ═════════════════════════════════════════════════════════════════════════════
console.log('A. measured monthly spending with explicit basis/window');
{
  const r = run(P.steady.rows, 'spending', { completeMonths: 6 });
  check('6 complete months resolve to Mar–Aug 2026, all whole',
    r.period.from === '2026-03-01' && r.period.to === '2026-08-31' && r.completeMonths === 6 && r.partialMonths.length === 0,
    `${r.period.from}..${r.period.to} n=${r.completeMonths}`);
  check('per complete month = 3,000 (800+400+1800); the 900 debt payment and 500 transfer are not in it',
    r.perCompleteMonth === 3000, String(r.perCompleteMonth));
  check('the basis names the exclusions', /NOT in it/.test(r.basis));
  check('the window is named on the figure', r.period.label === 'last 6 complete months' && r.period.kind === 'COMPLETE_MONTHS');
  check('completeness observed, with the record\'s floor', r.completeness.tier === 'observed' && r.completeness.coverageFrom === '2025-01-01');
  const q = run(P.steady.rows, 'spending', { preset: 'PAST_QUARTER' });
  check('PAST_QUARTER on 09-16 = 06-17..09-16: two whole months, two partial ones NAMED',
    q.period.from === '2026-06-17' && q.completeMonths === 2 && q.partialMonths.join() === '2026-06,2026-09', `${q.period.from} ${q.partialMonths}`);
  check('…the monthly figure ignores the partial months; the total does not',
    q.perCompleteMonth === 3000 && q.total === 3000 * 2 + 1800 + 800 + 400, `${q.perCompleteMonth} / ${q.total}`);
  const hi = run(P.highSpend.rows, 'spending', { completeMonths: 6 });
  check('a one-off month is IN the mean and is named as the highest — code offers the spread, not a verdict',
    hi.perCompleteMonth === 16000 && hi.highest?.month === '2026-05' && hi.highest.value === 26000 && hi.lowest?.value === 14000,
    JSON.stringify([hi.perCompleteMonth, hi.highest, hi.lowest]));
  const sparse = measure('spending', fold(P.steady.rows.filter((t) => t.date.slice(0, 7) !== '2026-05'), '2026-03-01', '2026-08-31'),
    resolvePeriod({ completeMonths: 6 }, CEIL), cov(P.steady.rows));
  check('a month with no rows is a real ZERO month, not a missing one: still 6 months, mean 2,500',
    sparse.completeMonths === 6 && sparse.perCompleteMonth === 2500 && sparse.lowest?.value === 0, JSON.stringify([sparse.completeMonths, sparse.perCompleteMonth]));
}

console.log('\nB. stated vs declared vs measured stay distinct — through the ONE canonical precedence');
{
  const m = run(P.declaredBudget.rows, 'spending', { completeMonths: 6 });
  const b1 = resolveExpenseBaselineFromEvidence({ measured: m });
  const b2 = resolveExpenseBaselineFromEvidence({ declared: 3500, measured: m });
  const b3 = resolveExpenseBaselineFromEvidence({ stated: 5000, declared: 3500, measured: m });
  check('measured → MEASURED 4,200 with its window, month count and months',
    b1?.basis === 'MEASURED' && b1.amount === 4200 && b1.completeMonths === 6 && b1.window?.from === '2026-03-01' && b1.months?.length === 6);
  check('a declared 3,500 outranks the measurement and is labelled DECLARED — with no window, because none was averaged',
    b2?.basis === 'DECLARED' && b2.amount === 3500 && b2.window === undefined);
  check('a stated 5,000 outranks both and is labelled STATED, for this conversation only',
    b3?.basis === 'STATED' && b3.amount === 5000 && /this conversation/.test(b3.note) && /not saved/.test(b3.note));
  check('the measured figure is unchanged by either — nothing was overwritten', m.perCompleteMonth === 4200);
  check('a stated 0 is not a baseline: it falls through, never a silent zero',
    resolveExpenseBaselineFromEvidence({ stated: 0, measured: m })?.basis === 'MEASURED');
  check('a negative or non-finite figure falls through the same way',
    resolveExpenseBaselineFromEvidence({ stated: -5, declared: Number.NaN, measured: m })?.basis === 'MEASURED');
  check('nothing at all is a refusal', resolveExpenseBaselineFromEvidence({}) === null);
}

console.log('\nC. monthly income — cadence vs measured');
{
  const inc = run(P.steady.rows, 'income', { completeMonths: 6 });
  check('measured income per complete month 6,000', inc.perCompleteMonth === 6000);
  const ib = resolveIncomeBaseline({ streams: P.steady.streams, measured: inc });
  check('CADENCE = 3,000 × 24 / 12 = 6,000 and is preferred over the window mean',
    ib?.basis === 'CADENCE' && ib.amount === 6000 && ib.streams?.[0].monthlyEquivalent === 6000);
  const bi = resolveIncomeBaseline({ streams: [stream('BIWEEKLY', 3000)], measured: inc });
  check('BIWEEKLY is 26 a year, not 24: 6,500/month', bi?.amount === 6500, String(bi?.amount));
  const gone = resolveIncomeBaseline({ streams: [stream('BIWEEKLY', 3000, false)], measured: inc });
  check('a stream that stopped paying is not a cadence basis — falls to MEASURED with its window',
    gone?.basis === 'MEASURED' && gone.window?.label === 'last 6 complete months');
  check('a stated income outranks both', resolveIncomeBaseline({ stated: 7000, streams: P.steady.streams, measured: inc })?.basis === 'STATED');
  const ret = run(P.retiree.rows, 'income', { completeMonths: 6 });
  check('retiree: transfers-in are NOT income; only the 120 interest is measured', ret.perCompleteMonth === 120, String(ret.perCompleteMonth));
  const irr = run(P.irregular.rows, 'income', { completeMonths: 6 });
  check('irregular quarterly income: 14,000 × 2 / 6 = 4,666.67, highest 14,000, lowest 0',
    irr.perCompleteMonth === 4666.67 && irr.highest?.value === 14000 && irr.lowest?.value === 0, String(irr.perCompleteMonth));
}

console.log('\nD. deterministic monthly surplus');
{
  const m = run(P.steady.rows, 'spending', { completeMonths: 6 });
  const i = run(P.steady.rows, 'income', { completeMonths: 6 });
  const dv = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: m }),
    income: resolveIncomeBaseline({ streams: P.steady.streams, measured: i }), liquid: 12000 });
  check('surplus 6,000 − 3,000 = 3,000 with both bases echoed', 'amount' in dv.monthlySurplus && dv.monthlySurplus.amount === 3000
    && dv.monthlySurplus.income.basis === 'CADENCE' && dv.monthlySurplus.expense.basis === 'MEASURED');
  check('the 900 debt payment is not subtracted, and the basis says so',
    'basis' in dv.monthlySurplus && /allocations of this surplus/.test(dv.monthlySurplus.basis));
  // The historical defect: a window holding an extra paycheck, divided by its months.
  const threePay = profile((y, m2) => [...pay(y, m2, 3000, y === 2026 && m2 === 7 ? [1, 15, 29] : [1, 15]), ...spend(y, m2, 800, 400, 1800)]);
  const net2 = run(threePay, 'economicNet', { completeMonths: 2 });
  const dv2 = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: run(threePay, 'spending', { completeMonths: 2 }) }),
    income: resolveIncomeBaseline({ streams: semimonthly(3000) }), liquid: 0 });
  check('a three-paycheck July: the MEASURE economicNet is 4,500/month over Jul–Aug…', net2.perCompleteMonth === 4500, String(net2.perCompleteMonth));
  check('…while the steady-state SURPLUS over the cadence baseline is 3,000 — two concepts, both named, neither a division by the model',
    'amount' in dv2.monthlySurplus && dv2.monthlySurplus.amount === 3000 && /steady-state/.test(dv2.monthlySurplus.basis));
  const q = run(threePay, 'income', { preset: 'PAST_QUARTER' });
  check('the prose defect, reproduced and refused: a 92-day income total ÷ 3 is 7,000; the measure\'s monthly figure is 7,500 over its two WHOLE months',
    q.total === 21000 && Math.round((q.total / 3) * 100) / 100 === 7000 && q.perCompleteMonth === 7500 && q.completeMonths === 2,
    JSON.stringify([q.total, q.perCompleteMonth]));
  check('economicNet per complete month equals mean income − mean spending over the same months',
    run(P.steady.rows, 'economicNet', { completeMonths: 6 }).perCompleteMonth === 3000);
}

console.log('\nE. period-vs-period comparison');
{
  const c = cmp(P.categoryHeavy.rows, 'spending', { month: '2026-08' }, 'PREVIOUS');
  check('Aug vs PREVIOUS: right = July, both whole, compared on total',
    c.right.period.label === '2026-07' && c.comparedOn === 'total' && c.left.period.calendarComplete && c.right.period.calendarComplete);
  check('Aug 3,700 vs Jul 6,500: −2,800, −43.08%, DOWN',
    c.left.total === 3700 && c.right.total === 6500 && c.change?.abs === -2800 && c.change?.pct === -43.08 && c.change?.direction === 'DOWN', JSON.stringify(c.change));
  const c3 = cmp(P.categoryHeavy.rows, 'spending', { completeMonths: 3 }, 'PREVIOUS');
  check('last 3 complete months (Jun–Aug) vs the 3 before (Mar–May), compared on total',
    c3.left.period.from === '2026-06-01' && c3.right.period.from === '2026-03-01' && c3.right.period.to === '2026-05-31' && c3.comparedOn === 'total');
  const cy = cmp(P.steady.rows, 'spending', { preset: 'YTD' }, 'SAME_PERIOD_LAST_YEAR');
  check('YTD vs the same period last year: 2025-01-01..2025-09-16, equal days, FLAT at 0%',
    cy.right.period.from === '2025-01-01' && cy.right.period.to === '2025-09-16' && cy.comparedOn === 'total'
      && cy.change?.direction === 'FLAT' && cy.change?.pct === 0, JSON.stringify(cy.change));
  const cr = cmp(P.steady.rows, 'spending', { preset: 'PAST_MONTH' }, 'PREVIOUS');
  check('PAST_MONTH (08-17..09-16, 31 d) vs the 31 days before (07-17..08-16)',
    cr.left.period.from === '2026-08-17' && cr.left.period.days === 31 && cr.right.period.from === '2026-07-17'
      && cr.right.period.to === '2026-08-16' && cr.right.period.days === 31);
  const said = cmp(P.categoryHeavy.rows, 'spending', { completeMonths: 3 }, { completeMonths: 3 });
  check('`compareTo: {completeMonths: 3}` means the three BEFORE the primary — never the same three months again',
    said.right.period.from === '2026-03-01' && said.right.period.to === '2026-05-31' && said.left.period.from === '2026-06-01'
      && JSON.stringify(said.change) === JSON.stringify(c3.change), `${said.right.period.from}..${said.right.period.to}`);
  const afterRolling = resolveCompareTo(resolvePeriod({ preset: 'PAST_MONTH' }, CEIL), { preset: 'PAST_MONTH' }, { completeMonths: 2 }, CEIL);
  check('…and before a primary that opens mid-month, it ends on the last month-end before it', afterRolling.from === '2026-06-01' && afterRolling.to === '2026-07-31');
  const uneven = cmp(P.steady.rows, 'spending', { completeMonths: 3 }, { completeMonths: 12 });
  check('unequal windows compare PER WHOLE MONTH and say so — a 3-month total is never set against a 12-month total',
    uneven.comparedOn === 'perCompleteMonth' && uneven.change?.direction === 'FLAT' && uneven.right.completeMonths === 12
      && uneven.right.period.to === '2026-05-31' && uneven.caveats.some((x) => /per whole calendar month/.test(x)));
  const inc = cmp(P.irregular.rows, 'income', { quarter: '2026-Q2' }, 'PREVIOUS');
  check('income this quarter vs the quarter before: Q2 vs Q1, whole quarters',
    inc.left.period.from === '2026-04-01' && inc.left.period.to === '2026-06-30' && inc.right.period.from === '2026-01-01'
      && inc.right.period.to === '2026-03-31' && inc.change?.direction === 'FLAT');
}

console.log('\nF. partial-period comparison');
{
  const c = cmp(P.steady.rows, 'spending', { preset: 'MTD' }, 'PREVIOUS');
  check('MTD on 09-16 vs PREVIOUS = Aug 1–16 (ELAPSED_EQUIVALENT), never all of August',
    c.right.period.from === '2026-08-01' && c.right.period.to === '2026-08-16' && c.right.period.kind === 'ELAPSED_EQUIVALENT',
    `${c.right.period.from}..${c.right.period.to} ${c.right.period.kind}`);
  check('both sides partial and NAMED; equal days ⇒ compared on total',
    c.left.partialMonths.join() === '2026-09' && c.right.partialMonths.join() === '2026-08' && c.comparedOn === 'total' && c.left.period.days === c.right.period.days);
  check('Sep 1–16 (800+400) vs Aug 1–16 (800+400): FLAT — the 1,800 on the 19th is in neither',
    c.left.total === 1200 && c.right.total === 1200 && c.change?.direction === 'FLAT');
  const full = cmp(P.steady.rows, 'spending', { preset: 'MTD' }, { month: '2026-08' });
  check('explicit MTD vs WHOLE August: both totals shown, NO difference manufactured, and it says why',
    full.change === null && full.left.total === 1200 && full.right.total === 3000 && /elapsed days/.test(full.notComparable ?? '')
      && full.caveats.some((x) => /WHOLE period/.test(x)), full.notComparable);
  check('no extrapolation: a partial-only window has no monthly figure', c.left.perCompleteMonth === null);
  const clamped = cmp(P.steady.rows, 'spending', { month: '2026-09' }, 'PREVIOUS');
  check('"September" asked mid-September is a month TO DATE: cut at the ceiling, and its PREVIOUS is Aug 1–16',
    clamped.left.period.clampedToCeiling && clamped.left.period.to === CEIL && clamped.right.period.kind === 'ELAPSED_EQUIVALENT'
      && clamped.right.period.to === '2026-08-16');
  const qtd = cmp(P.steady.rows, 'income', { preset: 'QTD' }, 'PREVIOUS');
  check('QTD vs PREVIOUS = the same 78 elapsed days of the previous quarter',
    qtd.left.period.from === '2026-07-01' && qtd.right.period.from === '2026-04-01' && qtd.right.period.days === qtd.left.period.days && qtd.left.period.days === 78);
}

console.log('\nG. category comparison — one measure, a filter');
{
  const c = cmp(P.categoryHeavy.rows, 'spending', { month: '2026-08' }, 'PREVIOUS', undefined, 'Dining');
  check('Dining Aug 1,400 vs Jul 1,400: FLAT', c.left.total === 1400 && c.right.total === 1400 && c.change?.direction === 'FLAT' && c.category === 'Dining');
  const t = cmp(P.categoryHeavy.rows, 'spending', { month: '2026-08' }, 'PREVIOUS', undefined, 'Travel');
  check('Travel Aug 200 vs Jul 3,000: −2,800, −93.33%', t.change?.abs === -2800 && t.change?.pct === -93.33, JSON.stringify(t.change));
  const up = cmp(P.categoryHeavy.rows, 'spending', { completeMonths: 2 }, 'PREVIOUS', undefined, 'Dining');
  check('Dining Jul–Aug 2,800 vs May–Jun 1,400: +1,400, +100%, UP', up.change?.abs === 1400 && up.change?.pct === 100 && up.change?.direction === 'UP');
  check('the category basis says it is a line WITHIN spending', /within spending/.test(c.left.basis));
  const yr = run(P.categoryHeavy.rows, 'spending', { preset: 'YTD' }, undefined, 'Travel');
  const all = run(P.categoryHeavy.rows, 'spending', { preset: 'YTD' });
  check('"was travel a big part": the category and the whole over the SAME window', yr.total === 4600 && all.total > yr.total && yr.period.from === all.period.from);
  check('…and the SHARE is code\'s: 4,600 of all spending over the same window, with the percentage computed',
    yr.ofAllSpending?.total === all.total && yr.ofAllSpending.sharePct === Math.round((4600 / all.total) * 10000) / 100 && all.ofAllSpending === undefined,
    JSON.stringify(yr.ofAllSpending));
  check('a share of nothing is null, never NaN', run([], 'spending', { month: '2026-08' }, cov(P.steady.rows), 'Travel').ofAllSpending?.sharePct === null);
  const none = cmp(P.categoryHeavy.rows, 'spending', { month: '2026-08' }, 'PREVIOUS', undefined, 'Medical');
  check('a category with no rows compares 0 vs 0: FLAT, pct null — no division by zero', none.change?.direction === 'FLAT' && none.change?.pct === null && none.change.abs === 0);
}

console.log('\nH. "N months of expenses" keeps its identity');
{
  const m = run(P.steady.rows, 'spending', { completeMonths: 6 });
  const dv = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: m }), income: null, liquid: 12000, monthsOfExpenses: [3, 6, 9, 12] });
  const six = dv.thresholds.find((t) => t.monthsOfExpenses === 6);
  check('6 months = 18,000 with the rule, the multiplier and the MEASURED baseline (window attached)',
    !!six && 'amount' in six && six.amount === 18000 && six.rule === '6 months of expenses' && six.baseline.basis === 'MEASURED'
      && six.baseline.window?.label === 'last 6 complete months');
  const dv2 = derive({ expense: resolveExpenseBaselineFromEvidence({ stated: 5000, measured: m }), income: null, liquid: 12000, monthsOfExpenses: [6, 9] });
  check('"use $5k instead" → 30,000 STATED; "make it nine" → 45,000 over the SAME baseline',
    dv2.thresholds.every((t) => 'amount' in t && t.baseline.basis === 'STATED')
      && (dv2.thresholds[0] as { amount: number }).amount === 30000 && (dv2.thresholds[1] as { amount: number }).amount === 45000);
  const six2 = dv.thresholds.find((t) => t.monthsOfExpenses === 6);
  const three = dv.thresholds.find((t) => t.monthsOfExpenses === 3);
  check('each threshold says where current cash stands against it: 12,000 is 6,000 short of six months…',
    !!six2 && 'vsLiquid' in six2 && six2.vsLiquid?.difference === -6000 && six2.vsLiquid.status === 'BELOW' && six2.vsLiquid.liquid === 12000);
  check('…and 3,000 above three — so the gap is read, never subtracted in prose',
    !!three && 'vsLiquid' in three && three.vsLiquid?.difference === 3000 && three.vsLiquid.status === 'AT_OR_ABOVE');
  check('no liquid balance ⇒ no gap claimed', !('vsLiquid' in expenseThreshold(6, resolveExpenseBaselineFromEvidence({ stated: 5000 }))));
  check('one month is singular; a non-positive multiplier is refused by name',
    expenseThreshold(1, resolveExpenseBaselineFromEvidence({ stated: 5000 })).rule === '1 month of expenses'
      && 'unavailable' in expenseThreshold(0, resolveExpenseBaselineFromEvidence({ stated: 5000 })));
}

console.log('\nI. runway');
{
  const m = run(P.steady.rows, 'spending', { completeMonths: 6 });
  const dv = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: m }), income: null, liquid: 12000, minimumDebtService: 900 });
  check('12,000 / 3,000 = 4.00 months on liquid, basis MEASURED',
    'months' in dv.runway && dv.runway.months === 4 && dv.runway.expenseBasis === 'MEASURED' && dv.runway.liquid === 12000 && dv.runway.monthlyExpense === 3000);
  check('investments are excluded, and the basis says so', 'basis' in dv.runway && /investments and digital assets are not liquid/.test(dv.runway.basis));
  check('with known minimum debt service a SECOND figure ships beside it: 12,000 / 3,900 = 3.08',
    'months' in dv.runway && dv.runway.withMinimumDebtService?.months === 3.08 && dv.runway.withMinimumDebtService.monthlyOutgo === 3900);
  const p = run(P.p2p.rows, 'spending', { completeMonths: 6 });
  const pv = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: p }), income: resolveIncomeBaseline({ streams: P.p2p.streams }), liquid: 400 });
  check('paycheck-to-paycheck: surplus 3,800 − 3,785 = 15, runway 0.11 — small, exact, no verdict attached',
    'amount' in pv.monthlySurplus && pv.monthlySurplus.amount === 15 && 'months' in pv.runway && pv.runway.months === 0.11);
  const stated = derive({ expense: resolveExpenseBaselineFromEvidence({ stated: 5000, measured: m }), income: null, liquid: 12000 });
  check('a stated baseline changes the runway and names itself', 'months' in stated.runway && stated.runway.months === 2.4 && stated.runway.expenseBasis === 'STATED');
}

console.log('\nJ/K. the threshold becomes the EXISTING liquid floor — no ledger concept added');
{
  const obs = resolveMonthsOfExpensesFloor({ monthsOfExpenses: 6, observedMonthly: 4346.48 });
  check('observed 4,346.48 × 6 = 26,078.88, MEASURED, with the rule beside the dollars',
    'liquidFloor' in obs && obs.liquidFloor === 26078.88 && obs.derivedFrom.rule === '6 months of expenses'
      && obs.derivedFrom.monthsOfExpenses === 6 && obs.derivedFrom.baseline.basis === 'MEASURED' && obs.derivedFrom.baseline.amount === 4346.48);
  const st = resolveMonthsOfExpensesFloor({ monthsOfExpenses: 6, stated: 5000, observedMonthly: 4346.48 });
  check('"use $5k; keep six months of that" → 30,000 STATED', 'liquidFloor' in st && st.liquidFloor === 30000 && st.derivedFrom.baseline.basis === 'STATED');
  const nine = resolveMonthsOfExpensesFloor({ monthsOfExpenses: 9, stated: 5000 });
  check('"make it nine" → 45,000 over the same baseline', 'liquidFloor' in nine && nine.liquidFloor === 45000);
  check('no spending level ⇒ refused by name, never a $0 floor',
    'unavailable' in resolveMonthsOfExpensesFloor({ monthsOfExpenses: 6 }) && 'unavailable' in resolveMonthsOfExpensesFloor({ monthsOfExpenses: 6, observedMonthly: 0 }));
  check('a non-positive month count is refused', 'unavailable' in resolveMonthsOfExpensesFloor({ monthsOfExpenses: 0, stated: 5000 }));
  // K — composition with L1 needs no code: the resolved literal is an ordinary `liquidFloor`.
  const ledger = readFileSync('lib/ai/conversation/scenario-ledger.ts', 'utf8');
  // FM-AUDIT-011 — the movement now CARRIES its derivation binding
  // (`floorMonthsOfExpenses`) so a run at another spending level can re-resolve
  // it; the ledger's SETTLEMENT still reads only the dollar literal.
  const settle = ledger.slice(ledger.indexOf('export function settleMovements'), ledger.indexOf('export function runScenarioLedger'));
  check('the ledger settles only the literal — settlement never reads months of expenses',
    settle.length > 1000 && !/MonthsOfExpenses|monthsOfExpenses/.test(settle));
  check('…and expansion passes the binding through untouched (the one non-type reference)',
    ledger.includes('...(bound !== undefined ? { floorMonthsOfExpenses: bound } : {})'));
  const tools = readFileSync('lib/ai/conversation/tools.ts', 'utf8');
  check('the scenario preparer resolves the floor through the measures authority and passes `target` through untouched',
    /resolveMonthsOfExpensesFloor\(/.test(tools) && /c = \{ \.\.\.rest, liquidFloor: floor\.liquidFloor/.test(tools));
}

console.log('\nL. incomplete evidence propagates — by population and by window');
{
  const rows = P.incomplete.rows;
  const r = run(rows, 'spending', { completeMonths: 6 });
  check('history from 2026-06-12: a 6-complete-month window is INCOMPLETE with coverageFrom',
    r.completeness.tier === 'incomplete' && r.completeness.coverageFrom === '2026-06-12', r.completeness.reason);
  const ok = run(rows, 'spending', { completeMonths: 2 });
  check('…while Jul–Aug over the same record is observed', ok.completeness.tier === 'observed' && ok.perCompleteMonth === 3000);
  const c = cmp(rows, 'spending', { completeMonths: 2 }, 'PREVIOUS');
  check('a comparison whose right side predates history is incomplete AS A WHOLE, and the clean side stays observed',
    c.completeness.tier === 'incomplete' && c.right.completeness.tier === 'incomplete' && c.left.completeness.tier === 'observed');
  const behind = cov(P.steady.rows, { components: [
    { key: 'checking:Chase', tier: 'observed', deliveredThrough: null },
    { key: 'credit:Amex', tier: 'incomplete', deliveredThrough: '2026-08-17' }] });
  const stale = run(P.steady.rows, 'spending', { preset: 'PAST_MONTH' }, behind);
  check('a card that stopped delivering on 08-17 makes a window ENDING 09-16 incomplete, by component',
    stale.completeness.tier === 'incomplete' && stale.completeness.byComponent?.['credit:Amex'] === 'incomplete' && /rows through 2026-08-17/.test(stale.completeness.reason));
  const before = run(P.steady.rows, 'spending', { month: '2026-07' }, behind);
  check('…but July, which closed before it stopped, is still OBSERVED — a gap belongs to the days it covers',
    before.completeness.tier === 'observed' && before.completeness.byComponent?.['credit:Amex'] === 'incomplete');
  const brokerageOnly = cov(P.steady.rows, { components: [{ key: 'checking:Chase', tier: 'observed', deliveredThrough: null }] });
  check('a stale brokerage with NO banking rows is not a component at all — spending stays observed',
    run(P.steady.rows, 'spending', { preset: 'PAST_MONTH' }, brokerageOnly).completeness.tier === 'observed');
  const cap = run(P.steady.rows, 'spending', { preset: 'PAST_YEAR' }, cov(P.steady.rows, { fetchCapHit: true }));
  check('the row ceiling is a completeness fact, not a silent trim', cap.completeness.tier === 'incomplete' && /row ceiling/.test(cap.completeness.reason));
  const clampedRead = run(P.steady.rows, 'spending', { completeMonths: 12 }, cov(P.steady.rows, { readFrom: '2025-11-01' }));
  check('a read clamped inside the window is incomplete and names where it began',
    clampedRead.completeness.tier === 'incomplete' && clampedRead.completeness.coverageFrom === '2025-11-01');
  check('no history at all is UNKNOWN, not zero', run([], 'spending', { completeMonths: 2 }).completeness.tier === 'unknown');
}

console.log('\nM. zero denominators — explicit, never Infinity/NaN');
{
  const empty = run(P.steady.rows, 'spending', { from: '2024-01-01', to: '2024-03-31' });
  check('a window before history: total 0 and tier incomplete — a zero that says it is not a measurement',
    empty.total === 0 && empty.completeness.tier === 'incomplete');
  const dv = derive({ expense: null, income: resolveIncomeBaseline({ streams: [stream('MONTHLY', 100)] }), liquid: 5000, monthsOfExpenses: [6] });
  check('no expense baseline: runway UNAVAILABLE (never Infinity), threshold unavailable, surplus unavailable',
    'unavailable' in dv.runway && /not infinite/.test(dv.runway.unavailable) && 'unavailable' in dv.thresholds[0] && 'unavailable' in dv.monthlySurplus);
  check('no income baseline: savings rate unavailable rather than NaN',
    'unavailable' in derive({ expense: resolveExpenseBaselineFromEvidence({ stated: 3000 }), income: null, liquid: 5000 }).savingsRate);
  const retInc = resolveIncomeBaseline({ streams: [], measured: run(P.retiree.rows, 'income', { completeMonths: 6 }) });
  const ret = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: run(P.retiree.rows, 'spending', { completeMonths: 6 }) }), income: retInc, liquid: 40000 });
  check('retiree: income is only a 120/month interest MEAN ⇒ savings rate REFUSED ("no recurring income level"), never −2,817%',
    retInc?.basis === 'MEASURED' && 'unavailable' in ret.savingsRate && /no recurring income level/.test(ret.savingsRate.unavailable));
  check('…while the runway, which needs no income, still answers: 40,000 / 3,500 = 11.43', 'months' in ret.runway && ret.runway.months === 11.43);
  const c0 = cmp(P.irregular.rows, 'income', { month: '2026-08' }, 'PREVIOUS');
  check('income Aug 0 vs Jul 0: FLAT with pct null', c0.change?.direction === 'FLAT' && c0.change?.pct === null);
  const c1 = cmp(P.irregular.rows, 'income', { month: '2026-09' }, 'PREVIOUS');
  check('Sep-to-date 14,000 vs Aug 1–16 0: abs +14,000, UP, pct null (zero base)',
    c1.change?.pct === null && c1.change?.abs === 14000 && c1.change.direction === 'UP');
  const everything = JSON.stringify([empty, dv, ret, c0, c1]);
  check('nothing serialises as Infinity or NaN (JSON would print null for both — so check the values)',
    !/Infinity|NaN/.test(everything) && [empty.total, c1.change?.abs].every((n) => Number.isFinite(n)));
}

console.log('\nN. no model arithmetic: every derived figure ships with the operands that produce it');
{
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const p of Object.values(P)) {
    const m = run(p.rows, 'spending', { completeMonths: 6 }); const i = run(p.rows, 'income', { completeMonths: 6 });
    const dv = derive({ expense: resolveExpenseBaselineFromEvidence({ measured: m }),
      income: resolveIncomeBaseline({ streams: p.streams, measured: i }), liquid: 10000, monthsOfExpenses: [6] });
    const okSurplus = 'unavailable' in dv.monthlySurplus || dv.monthlySurplus.amount === r2(dv.monthlySurplus.income.amount - dv.monthlySurplus.expense.amount);
    const okRate = 'unavailable' in dv.savingsRate || dv.savingsRate.ratePct === r2((dv.savingsRate.numerator / dv.savingsRate.denominator) * 100);
    const okRunway = 'unavailable' in dv.runway || dv.runway.months === r2(dv.runway.liquid / dv.runway.monthlyExpense);
    const t = dv.thresholds[0];
    const okThreshold = 'unavailable' in t || t.amount === r2(t.monthsOfExpenses * t.baseline.amount);
    const c = cmp(p.rows, 'spending', { completeMonths: 3 }, 'PREVIOUS');
    const okCompare = !c.change || (c.change.abs === r2(c.left.total - c.right.total)
      && (c.change.pct === null || c.change.pct === r2((c.change.abs / Math.abs(c.right.total)) * 100)));
    check(`${p.name}: surplus, rate, runway, threshold and comparison all reproduce from their own operands`,
      okSurplus && okRate && okRunway && okThreshold && okCompare,
      JSON.stringify({ okSurplus, okRate, okRunway, okThreshold, okCompare }));
    const s = 'amount' in dv.monthlySurplus ? dv.monthlySurplus.amount : '—';
    const rw = 'months' in dv.runway ? dv.runway.months : '—'; const sr = 'ratePct' in dv.savingsRate ? `${dv.savingsRate.ratePct}%` : 'refused';
    console.log(`      spend/mo=${m.perCompleteMonth} inc/mo=${i.perCompleteMonth} surplus=${s} runway=${rw} savingsRate=${sr} tier=${m.completeness.tier}`);
  }
}

console.log('\nP. period pins (investigation §12) and refusals');
{
  const at = (spec: PeriodSpec, ceiling = CEIL) => resolvePeriod(spec, ceiling);
  check('this month = MTD 09-01..09-16, TO_DATE, not calendar-complete', at({ preset: 'MTD' }).from === '2026-09-01' && at({ preset: 'MTD' }).to === CEIL && at({ preset: 'MTD' }).kind === 'TO_DATE' && !at({ preset: 'MTD' }).calendarComplete);
  check('last month = { month: 2026-08 }, whole', at({ month: '2026-08' }).calendarComplete && at({ month: '2026-08' }).days === 31);
  check('PAST_MONTH is a CALENDAR month back, exclusive of the anchor day: 08-17..09-16', at({ preset: 'PAST_MONTH' }).from === '2026-08-17');
  check('PAST_QUARTER = 06-17..09-16 (92 days)', at({ preset: 'PAST_QUARTER' }).from === '2026-06-17' && at({ preset: 'PAST_QUARTER' }).days === 92);
  check('PAST_6_MONTHS = 03-17..09-16; PAST_YEAR = 2025-09-17..09-16', at({ preset: 'PAST_6_MONTHS' }).from === '2026-03-17' && at({ preset: 'PAST_YEAR' }).from === '2025-09-17');
  check('YTD = 01-01..09-16; QTD = 07-01..09-16', at({ preset: 'YTD' }).from === '2026-01-01' && at({ preset: 'QTD' }).from === '2026-07-01');
  check('completeMonths ends on the last month-end BEFORE the ceiling\'s month', at({ completeMonths: 1 }).from === '2026-08-01' && at({ completeMonths: 1 }).to === '2026-08-31');
  check('…and on a month-end ceiling that month counts as complete', at({ completeMonths: 1 }, '2026-08-31').to === '2026-08-31' && at({ completeMonths: 1 }, '2026-08-31').from === '2026-08-01');
  check('completeMonths 24 = 2024-09-01..2026-08-31', at({ completeMonths: 24 }).from === '2024-09-01');
  check('a quarter and a year resolve to their calendar bounds; a future end is cut at the ceiling and says so',
    at({ quarter: '2026-Q2' }).from === '2026-04-01' && at({ quarter: '2026-Q2' }).to === '2026-06-30'
      && at({ year: 2026 }).to === CEIL && at({ year: 2026 }).clampedToCeiling && !at({ year: 2026 }).calendarComplete);
  check('February in a leap year closes on the 29th', at({ month: '2024-02' }).to === '2024-02-29');
  const prev = (spec: PeriodSpec, to: CompareToSpec = 'PREVIOUS') => resolveCompareTo(at(spec), spec, to, CEIL);
  check('previous of a whole year is the year before; of a year TO DATE, the same elapsed days of last year',
    prev({ year: 2025 }).from === '2024-01-01' && prev({ year: 2025 }).to === '2024-12-31'
      && prev({ year: 2026 }).kind === 'ELAPSED_EQUIVALENT' && prev({ year: 2026 }).from === '2025-01-01' && prev({ year: 2026 }).days === at({ year: 2026 }).days);
  check('previous of an explicit 30 days is the 30 days ending the day before',
    prev({ from: '2026-08-18', to: '2026-09-16' }).from === '2026-07-19' && prev({ from: '2026-08-18', to: '2026-09-16' }).to === '2026-08-17');
  check('SAME_PERIOD_LAST_YEAR moves both ends back a year', prev({ month: '2026-08' }, 'SAME_PERIOD_LAST_YEAR').from === '2025-08-01' && prev({ month: '2026-08' }, 'SAME_PERIOD_LAST_YEAR').to === '2025-08-31');
  check('a run of named whole months is a COMPLETE_MONTHS period', completeMonthsPeriod('2026-07', '2026-08', 'x', CEIL).calendarComplete && completeMonthsPeriod('2026-07', '2026-08', 'x', CEIL).days === 62);
  check('the default measured window is the forecast authority\'s own constant, by reference', OBSERVED_SPENDING_WINDOW_MONTHS === 3);

  const bad = (raw: unknown) => 'unavailable' in (parsePeriodSpec(raw) as object);
  check('two shapes at once is refused, not resolved to one of them', bad({ month: '2026-08', completeMonths: 3 }));
  check('nothing at all is refused', bad({}) && bad(null) && bad('last month'));
  check('malformed values are refused by name', bad({ month: '2026-13' }) && bad({ month: 'August' }) && bad({ quarter: '2026-Q5' })
    && bad({ completeMonths: 0 }) && bad({ completeMonths: 2.5 }) && bad({ from: '2026-09-01' }) && bad({ from: '2026-09-10', to: '2026-09-01' }) && bad({ preset: 'LAST_WEEKEND' }));
  check('well-formed values are accepted, case-insensitively where it is harmless',
    !bad({ preset: 'mtd' }) && !bad({ quarter: '2026-q3' }) && !bad({ year: 2025 }) && !bad({ from: '2026-01-01', to: '2026-01-31' }));
  check('compareTo takes the two words or a period, nothing else',
    parseCompareToSpec('previous') === 'PREVIOUS' && parseCompareToSpec('SAME_PERIOD_LAST_YEAR') === 'SAME_PERIOD_LAST_YEAR'
      && 'unavailable' in (parseCompareToSpec('LAST_DECADE') as object) && !('unavailable' in (parseCompareToSpec({ month: '2026-07' }) as object)));
}

console.log('\nS. source scans');
{
  const code = (rel: string) => readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const noStrings = (src: string) => src.replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  const measures = ['period.ts', 'measure.ts', 'baseline.ts'].map((f) => noStrings(code(`lib/ai/measures/${f}`))).join('\n');
  check('no day-normalisation anywhere in the measures: no `/ days`, `/ 30`, `* 30`, `windowDays`',
    !/\/\s*(?:\w+\.)?days\b|\/\s*30\b|\*\s*30\b|windowDays/.test(measures));
  check('the period module asks the ONE preset parser', /compareToForPreset\(/.test(measures));
  check('the measures never import a forecast authority — cadence arithmetic arrives through the sanctioned adapter',
    !/@\/lib\/forecast\//.test(readFileSync('lib/ai/measures/baseline.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
      && /from '@\/lib\/forecast\/cadence'/.test(readFileSync('lib/ai/forecast/income-evidence.ts', 'utf8')));
  check('the measures never touch a transaction row or a database', !/queryTransactions|from '@\/lib\/db'|prisma/i.test(code('lib/ai/measures/measure.ts') + code('lib/ai/measures/baseline.ts') + code('lib/ai/measures/period.ts')));
  const baseline = code('lib/ai/measures/baseline.ts');
  check('the expense baseline is chosen by the canonical resolver — imported, not re-implemented',
    /import \{ resolveExpenseBaseline[^}]*\} from '@\/lib\/liquidity\/expense-baseline'/.test(baseline)
      && (baseline.match(/resolveExpenseBaseline\(\{/g) ?? []).length === 2);
  check('…and no precedence is decided here: `declared` is only ever typed and handed to it',
    !/\bdeclared\b/.test(baseline.replace(/declared\?: number \| null/g, '').replace(/declared: e\.declared/g, '')));
  const tools = noStrings(code('lib/ai/conversation/tools.ts'));
  check('the tool file holds no second baseline resolver and no precedence of its own',
    !/resolveExpenseBaseline\(/.test(tools) && /resolveExpenseBaselineFromEvidence\(/.test(tools) && !/\bDECLARED\b|\bMEASURED\b/.test(tools));
  check('the two heads are on the surface; no per-question tool was added',
    /name: ''/.test(tools) && ['measure_flows', 'get_baselines'].every((n) => readFileSync('lib/ai/conversation/tools.ts', 'utf8').includes(`name: '${n}'`))
      && !/get_monthly_spending|compare_spending|get_savings_rate|get_runway|get_surplus|compare_income|compare_categories/.test(readFileSync('lib/ai/conversation/tools.ts', 'utf8')));
  const engine = noStrings(code('lib/ai/intelligence/annotations/engine.ts'));
  check('the assessment no longer divides the income window by its days', !/incomeTotal\s*\/\s*windowDays/.test(engine) && /computeAverageMonthlyIncome\(/.test(engine));
  const brief = noStrings(code('lib/ai/brief/package.ts'));
  check('the Brief prints the canonical baseline, not the raw measurement',
    /monthlyExpenses:\s*moneyOrNull\(a\.liquidity\.estimatedMonthlyExpense\)/.test(brief) && !/cashFlow\.estimatedMonthlyExpenses/.test(brief));
}

console.log(failures === 0 ? `\nM1 MEASURES: ${passed} checks passed` : `\n${failures} FAILED (${passed} passed)`);
process.exit(failures === 0 ? 0 : 1);
