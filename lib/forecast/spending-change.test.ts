/**
 * lib/forecast/spending-change.test.ts — S1-1
 *
 * The pure spending-change primitive: the algebra, interval semantics (a rule
 * stops mattering after its inclusive `to`), ordering, refusals, the
 * category → total reconciliation, conservation, and the execution record.
 *
 * Standalone tsx script. Pure: no DB, no clock.
 */

import {
  applySpendingChanges, monthlyRateAt, spendOver, DAYS_PER_MONTH,
  type SpendingChangeRule, type SpendingBaseline, type CategoryRate, type SpendingScope,
} from './spending-change';
import { deriveCategorySpendingRates } from './observed-spending';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a: number | null | undefined, b: number, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;

const ASOF = '2026-12-15';
const HORIZON = '2027-12-31';
const MONTHS = ['2026-09', '2026-10', '2026-11'];
const BASE: SpendingBaseline = { monthly: 5_000, basis: 'MEASURED', months: MONTHS, values: [5_000, 5_000, 5_000] };
const cat = (category: string, monthly: number): CategoryRate => ({ category, monthly, months: MONTHS, values: [monthly, monthly, monthly] });
const CATS = [cat('Dining', 1_000), cat('Shopping', 1_500), cat('Travel', 200)];
const DINING: SpendingScope = { category: 'Dining', class: 'WHOLE_BUCKET', meaning: 'restaurants AND groceries' };
const SHOPPING: SpendingScope = { category: 'Shopping', class: 'WHOLE_BUCKET', meaning: 'general merchandise' };
const TRAVEL: SpendingScope = { category: 'Travel', class: 'DIRECT', meaning: 'travel' };
const rule = (id: string, r: Omit<SpendingChangeRule, 'id'>): SpendingChangeRule => ({ id, ...r });
const run = (rules: SpendingChangeRule[], categoryRates = CATS, baseline = BASE) =>
  applySpendingChanges({ baseline, categoryRates, rules, asOfISO: ASOF, horizonISO: HORIZON });
/** Dining's rate on a date, read back off the TOTAL: T − (R − c_Dining). */
const diningOn = (r: ReturnType<typeof run>, d: string) => monthlyRateAt(r.schedule, BASE.monthly, d) - (BASE.monthly - 1_000);

// ── 1. the three operations ──────────────────────────────────────────────────
console.log('1. SCALE, DELTA, SET_RATE on a category — the total moves by the category delta, once');
{
  const s = run([rule('s1', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.8 })]);
  check('SCALE 0.8 on Dining (1,000): total 5,000 → 4,800 from January 1', near(monthlyRateAt(s.schedule, 5_000, '2027-01-01'), 4_800)
    && near(monthlyRateAt(s.schedule, 5_000, '2026-12-31'), 5_000));
  const d = run([rule('d1', { op: 'DELTA', scope: SHOPPING, fromISO: '2027-03-01', monthly: -500 })]);
  check('DELTA −500 on Shopping: total 4,500 from March', near(monthlyRateAt(d.schedule, 5_000, '2027-03-01'), 4_500));
  const r = run([rule('r1', { op: 'SET_RATE', scope: TRAVEL, fromISO: '2027-06-01', monthly: 300 })]);
  check('SET_RATE 300 on Travel (200): total 5,100 — a stated level can raise spending', near(monthlyRateAt(r.schedule, 5_000, '2027-06-01'), 5_100));
  const stop = run([rule('z', { op: 'SET_RATE', scope: DINING, fromISO: '2027-01-01', monthly: 0 })]);
  check('STOP is SET_RATE 0: total 4,000', near(monthlyRateAt(stop.schedule, 5_000, '2027-02-01'), 4_000));
  const tot = run([rule('t', { op: 'SCALE', scope: null, fromISO: '2027-01-01', multiplier: 0.9 })]);
  check('an omitted category is TOTAL spending: 0.9 × 5,000 = 4,500', near(monthlyRateAt(tot.schedule, 5_000, '2027-05-01'), 4_500));
}

// ── 2. intervals, not history — the brief's pinned example ──────────────────
console.log('2. a rule stops mattering after its inclusive `to`');
{
  const r = run([
    rule('A', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', toISO: '2027-03-31', multiplier: 0.8 }),
    rule('B', { op: 'SCALE', scope: DINING, fromISO: '2027-02-01', toISO: '2027-04-30', multiplier: 0.9 }),
  ]);
  const got = ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15'].map((d) => diningOn(r, d));
  check('Dining 1,000: January 800, February 720, March 720, April 900, May 1,000',
    [800, 720, 720, 900, 1_000].every((v, i) => near(got[i], v)), got.join(', '));
  check('…the boundaries are exact: March 31 still 720, April 1 already 900, April 30 900, May 1 1,000',
    near(diningOn(r, '2027-03-31'), 720) && near(diningOn(r, '2027-04-01'), 900)
      && near(diningOn(r, '2027-04-30'), 900) && near(diningOn(r, '2027-05-01'), 1_000));
  const d = run([
    rule('A', { op: 'DELTA', scope: DINING, fromISO: '2027-01-01', toISO: '2027-03-31', monthly: -300 }),
    rule('B', { op: 'DELTA', scope: DINING, fromISO: '2027-02-01', toISO: '2027-04-30', monthly: -100 }),
  ]);
  check('DELTA expires too: 700 / 600 / 600 / 900 / 1,000',
    [700, 600, 600, 900, 1_000].every((v, i) => near(diningOn(d, ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15'][i]), v)));
  const s = run([
    rule('A', { op: 'SET_RATE', scope: DINING, fromISO: '2027-01-01', toISO: '2027-03-31', monthly: 400 }),
    rule('B', { op: 'SCALE', scope: DINING, fromISO: '2027-02-01', toISO: '2027-04-30', multiplier: 0.5 }),
  ]);
  check('SET_RATE expires too: 400 / 200 / 200 / then B alone on the BASELINE 500 / 1,000',
    [400, 200, 200, 500, 1_000].every((v, i) => near(diningOn(s, ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15'][i]), v)));
  const later = run([
    rule('A', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.8 }),
    rule('B', { op: 'SET_RATE', scope: DINING, fromISO: '2027-03-01', toISO: '2027-04-30', monthly: 500 }),
  ]);
  check('a later SET_RATE replaces the earlier-starting rule while it runs, and the earlier rule resumes after: 800 / 500 / 800',
    near(diningOn(later, '2027-02-01'), 800) && near(diningOn(later, '2027-03-01'), 500) && near(diningOn(later, '2027-05-01'), 800));
}

// ── 3. mid-month dates and stacking ──────────────────────────────────────────
console.log('3. exact daily dates; sequential rules stack');
{
  const r = run([rule('m', { op: 'SET_RATE', scope: DINING, fromISO: '2027-03-15', monthly: 0 })]);
  const march = spendOver(r.schedule, 5_000 / DAYS_PER_MONTH, '2027-02-28', '2027-03-31');
  const expected = (14 * 5_000 + 17 * 4_000) / DAYS_PER_MONTH;
  check('a March 15 start: 14 days at the old rate + 17 at the new, never rounded to a month', near(march, expected, 1e-7), `${march} vs ${expected}`);
  const seq = run([
    rule('jan', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.8 }),
    rule('jul', { op: 'SCALE', scope: DINING, fromISO: '2027-07-01', multiplier: 0.9 }),
  ]);
  check('20% from January then another 10% from July: 800 then 720 (0.72)',
    near(diningOn(seq, '2027-06-30'), 800) && near(diningOn(seq, '2027-07-01'), 720));
  const both = run([
    rule('c', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.5 }),
    rule('t', { op: 'DELTA', scope: null, fromISO: '2027-01-01', monthly: -1_000 }),
  ]);
  check('category rules fold first, then TOTAL rules on the result: 5,000 − 500 − 1,000 = 3,500', near(monthlyRateAt(both.schedule, 5_000, '2027-02-01'), 3_500));
}

// ── 4. refusals ──────────────────────────────────────────────────────────────
console.log('4. refused whole, by name');
{
  const bad = run([
    rule('a', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01' }),
    rule('b', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 1 }),
    rule('c', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: -0.2 }),
    rule('d', { op: 'DELTA', scope: DINING, fromISO: '2027-01-01', monthly: 0 }),
    rule('e', { op: 'SET_RATE', scope: DINING, fromISO: '2027-01-01', monthly: -5 }),
    rule('f', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.8, monthly: 5 }),
    rule('g', { op: 'START' as never, scope: DINING, fromISO: '2027-01-01', monthly: 5 }),
    rule('h', { op: 'SCALE', scope: DINING, fromISO: '2027-02-30x', multiplier: 0.8 }),
    rule('i', { op: 'SCALE', scope: DINING, fromISO: '2027-03-01', toISO: '2027-02-01', multiplier: 0.8 }),
  ]);
  check('nine malformed rules: nine refusals, nothing applied', bad.rejected.length === 9 && bad.executions.length === 0
    && bad.schedule.length === 1 && bad.schedule[0].monthly === 5_000, JSON.stringify(bad.rejected.map((x) => x.input)));
  check('START is not an operation — the refusal says STOP is SET_RATE 0', /SET_RATE 0/.test(bad.rejected.find((x) => /rule g/.test(x.input))!.reason));
  const clash = run([
    rule('x', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.8 }),
    rule('y', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.85 }),
    rule('z', { op: 'SCALE', scope: SHOPPING, fromISO: '2027-01-01', multiplier: 0.9 }),
  ]);
  check('same scope + same start date: BOTH refused (nothing orders them); another scope on that date still runs',
    clash.rejected.length === 2 && clash.executions.length === 1 && clash.executions[0].ruleId === 'z');
}

// ── 5. reconciliation, clamps, conservation ─────────────────────────────────
console.log('5. reconciliation: T − R = Σ(c_k(d) − c_k), never assuming Σ c_k = R');
{
  // Σ c_k = 2,700 ≠ R = 5,000: the other 2,300 is carried inside R, untouched.
  const r = run([
    rule('a', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.7 }),
    rule('b', { op: 'DELTA', scope: SHOPPING, fromISO: '2027-01-01', monthly: -200 }),
  ]);
  check('Σ c_k (2,700) ≠ R (5,000): T = 5,000 + (700 − 1,000) + (1,300 − 1,500) = 4,500', near(monthlyRateAt(r.schedule, 5_000, '2027-02-01'), 4_500));
  const none = run([]);
  check('no rules ⇒ one segment at R, and spend is BIT-IDENTICAL to the pre-S1 accrual',
    none.schedule.length === 1 && none.schedule[0].monthly === 5_000
      && spendOver(none.schedule, 5_000 / DAYS_PER_MONTH, ASOF, HORIZON) === (5_000 / DAYS_PER_MONTH) * 381
      && none.spendingRemoved === 0);
  const clamp = run([rule('big', { op: 'DELTA', scope: DINING, fromISO: '2027-01-01', monthly: -5_000 })]);
  check('a DELTA larger than the line clamps the LINE at 0 (total 4,000) and says so',
    near(monthlyRateAt(clamp.schedule, 5_000, '2027-02-01'), 4_000) && clamp.executions[0].clampedAtZero === true);
  const floor = run([rule('all', { op: 'DELTA', scope: null, fromISO: '2027-01-01', monthly: -9_000 })]);
  check('total spending is never negative: a TOTAL DELTA of −9,000 gives 0', near(monthlyRateAt(floor.schedule, 5_000, '2027-02-01'), 0) && floor.executions[0].clampedAtZero);
  const cons = run([
    rule('A', { op: 'SCALE', scope: DINING, fromISO: '2027-01-01', toISO: '2027-03-31', multiplier: 0.8 }),
    rule('B', { op: 'SCALE', scope: DINING, fromISO: '2027-02-01', toISO: '2027-04-30', multiplier: 0.9 }),
  ]);
  const bySegments = cons.schedule.reduce((t, s) => {
    const from = s.fromISO, to = s.toISO;
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    return t + (5_000 - s.monthly) / DAYS_PER_MONTH * days;
  }, 0);
  // Jan 31d × 200 + Feb 28d × 280 + Mar 31d × 280 + Apr 30d × 100, per DAYS_PER_MONTH.
  const hand = (31 * 200 + 28 * 280 + 31 * 280 + 30 * 100) / DAYS_PER_MONTH;
  check(`conservation: spendingRemoved = Σ segments (R − T) × days = ${hand.toFixed(4)}`,
    near(cons.spendingRemoved, hand, 1e-7) && near(bySegments, hand, 1e-7), `${cons.spendingRemoved}`);
}

// ── 6. the execution record ─────────────────────────────────────────────────
console.log('6. what each rule did');
{
  const r = run([
    rule('A', { op: 'SCALE', scope: DINING, fromISO: '2026-11-01', toISO: '2027-03-31', multiplier: 0.8 }),
    rule('B', { op: 'SCALE', scope: DINING, fromISO: '2027-02-01', multiplier: 0.9 }),
    rule('C', { op: 'SCALE', scope: TRAVEL, fromISO: '2028-02-01', multiplier: 0.5 }),
    rule('D', { op: 'SCALE', scope: SHOPPING, fromISO: '2026-01-01', toISO: '2026-06-30', multiplier: 0.5 }),
    rule('E', { op: 'SCALE', scope: { category: 'Fee', class: 'DIRECT', meaning: 'fees' }, fromISO: '2027-01-01', multiplier: 0.5 }),
  ]);
  const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map((id) => r.executions.find((x) => x.ruleId === id)!);
  check('A asked from 2026-11-01 (before asOf) and GOVERNED from the day after asOf', A.requested.fromISO === '2026-11-01'
    && A.governed?.fromISO === '2026-12-16' && A.governed?.toISO === '2027-03-31');
  check('A: Dining 1,000 → 800, baseline months named, class WHOLE_BUCKET echoed', near(A.monthlyBefore, 1_000) && near(A.monthlyAfter, 800)
    && JSON.stringify(A.baseline.months) === JSON.stringify(MONTHS) && A.category?.class === 'WHOLE_BUCKET');
  check('B folds AFTER A on its first day: 800 → 720; the two name each other as overlapping',
    near(B.monthlyBefore, 800) && near(B.monthlyAfter, 720) && B.overlapsRules?.includes('A') === true && A.overlapsRules?.includes('B') === true);
  check('C starts after the horizon: ran false, affected nothing, with the reason', !C.ran && !C.affectedProjection && /after this projection ends/.test(C.reason ?? ''));
  check('D ended before asOf: ran false — that spending is measured, not projected', !D.ran && /measured, not projected/.test(D.reason ?? ''));
  check('E on a line with no spending in the window: RAN, but moved nothing — and says so', E.ran && !E.affectedProjection && E.baseline.monthly === 0);
  check('a rule\'s spendingRemoved is its marginal effect (A with B present ≠ A alone)',
    A.spendingRemoved > 0 && !near(A.spendingRemoved, run([rule('A', { op: 'SCALE', scope: DINING, fromISO: '2026-11-01', toISO: '2027-03-31', multiplier: 0.8 })]).spendingRemoved, 1e-6));
}

// ── 7. category rates over the SAME months ──────────────────────────────────
console.log('7. category rates: the same months as the total, the ledger line\'s net');
{
  const months = [
    { month: '2026-08', byCategory: [{ category: 'Dining', total: 9_999 }] },
    { month: '2026-09', byCategory: [{ category: 'Dining', total: 1_200 }, { category: 'Travel', total: 3_000, netTotal: 100 }] },
    { month: '2026-10', byCategory: [{ category: 'Dining', total: 900 }] },
    { month: '2026-11', byCategory: [{ category: 'Dining', total: 900 }, { category: 'Shopping', total: 600 }] },
  ];
  const rates = deriveCategorySpendingRates(months, ['2026-09', '2026-10', '2026-11']);
  const by = Object.fromEntries(rates.map((x) => [x.category, x]));
  check('only the window\'s months: Dining (1,200 + 900 + 900) / 3 = 1,000 — August\'s 9,999 is not in it', near(by.Dining.monthly, 1_000));
  check('the ledger line\'s NET: Travel 100 (a 2,900 refund), then absent ⇒ 0 for the mean: 33.33', near(by.Travel.monthly, 100 / 3)
    && JSON.stringify(by.Travel.values) === '[100,0,0]');
  check('every line names the SAME months as the total', rates.every((x) => JSON.stringify(x.months) === '["2026-09","2026-10","2026-11"]'));
  check('no window ⇒ no rates', deriveCategorySpendingRates(months, []).length === 0);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall spending-change checks passed');
