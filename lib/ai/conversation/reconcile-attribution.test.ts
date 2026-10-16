/**
 * lib/ai/conversation/reconcile-attribution.test.ts  (AI RELIABILITY 2026-10-16)
 *
 * An in-flight variance decomposes EXACTLY through the projection identity
 * (closing = opening + income − dated outflows − dailyRate × days), for a
 * checkpoint that recorded its income term and for one that predates doing so;
 * and an INCOMPLETE projection is never recorded as a statement.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/reconcile-attribution.test.ts
 */

import { daysBetween } from '@/lib/forecast/_time';
import { attributeInFlightVariance, attributionSideFromCheckpoint, readCheckpoint, type AttributionSide } from './reconcile';
import { projectionStatement } from './memory-tools';
import { PROJECTION_BASIS_KEYS } from './memory-model';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: { amount: number }[]) => r2(xs.reduce((n, x) => n + x.amount, 0));

const H = '2027-03-31';
/** A side built FROM the identity, so the test cannot agree with the code by sharing its arithmetic. */
function side(asOfISO: string, o: number, income: number, outflows: number, rate: number, months: string[]): AttributionSide {
  return { value: r2(o + income - outflows - rate * daysBetween(asOfISO, H)), openingCash: o, dailyRate: rate,
    monthsAveraged: months, incomeProjected: income, outflowsProjected: outflows, asOfISO };
}

// 1. Both sides carry income and outflows: separate lines, exact.
{
  const then = side('2026-11-01', 12_000, 40_000, 1_200, 210.5, ['2026-08', '2026-09', '2026-10']);
  const now = side('2026-11-20', 13_400, 31_000, 1_200, 199.25, ['2026-08', '2026-09', '2026-10']);
  const a = attributeInFlightVariance(then, now, H);
  const variance = r2(now.value - then.value);
  check('1a the lines sum to the variance with no residual', a.exact && Math.abs(sum(a.lines) - variance) <= 0.02 && Math.abs(a.residual) <= 0.02,
    JSON.stringify({ variance, lines: a.lines.map((l) => [l.cause, l.amount]), residual: a.residual }));
  check('1b income and outflows are their own lines; the income line is the income moved',
    a.lines.some((l) => l.cause === 'PROJECTED_INCOME' && l.amount === -9_000) && a.lines.some((l) => l.cause === 'DATED_OUTFLOWS' && l.amount === 0));
  check('1c no definition-change note when the averaging window kept its length',
    !a.lines.find((l) => l.cause === 'SPENDING_RATE')!.derivation.includes('changed LENGTH'));
}

// 2. A legacy statement (no income term recorded): ONE net line, still exact, recovered from the stated figure.
{
  const full = side('2026-11-01', 12_000, 40_000, 0, 230.5, ['2026-09', '2026-10']);
  const then: AttributionSide = { ...full, incomeProjected: null, outflowsProjected: null };
  const now = side('2026-11-14', 15_600, 6, 0, 178.8, ['2026-08', '2026-09', '2026-10']);
  const a = attributeInFlightVariance(then, now, H);
  const net = a.lines.find((l) => l.cause === 'INCOME_NET_OF_OUTFLOWS');
  check('2a legacy: exact, and the income term is one NET line (never split by a guess)',
    a.exact && !!net && !a.lines.some((l) => l.cause === 'PROJECTED_INCOME') && Math.abs(net.amount - (6 - 40_000)) <= 0.02,
    JSON.stringify(a.lines.map((l) => [l.cause, l.amount])));
  check('2b a different averaging-window LENGTH is named as a change of measure',
    a.lines.find((l) => l.cause === 'SPENDING_RATE')!.derivation.includes('changed LENGTH (2 → 3 months)'));
  check('2d when the start moved, the income line says income projected in between is timing, not lost',
    /no longer projected: what arrived is now inside opening cash/.test(net!.derivation));
  check('2c the spending line calls dailyRate SPENDING, an outflow — never a drift',
    /SPENDING \(an outflow, not a drift\)/.test(a.lines.find((l) => l.cause === 'SPENDING_RATE')!.derivation));
}

// 2e. With the elapsed window's projected income, the income line splits into TIMING + remainder, still exact.
{
  const full = side('2026-11-01', 12_000, 40_000, 0, 230.5, ['2026-09', '2026-10']);
  const then: AttributionSide = { ...full, incomeProjected: null, outflowsProjected: null };
  const now = side('2026-11-14', 17_000, 35_000, 0, 230.5, ['2026-09', '2026-10']);
  const a = attributeInFlightVariance(then, now, H, 5_000);
  const t = a.lines.find((l) => l.cause === 'INCOME_TIMING');
  const rest = a.lines.find((l) => l.cause === 'INCOME_NET_OF_OUTFLOWS');
  check('2e a payment that simply ARRIVED is a TIMING line (−elapsed income), the remainder is 0, and the sum is exact',
    a.exact && t?.amount === -5_000 && rest !== undefined && Math.abs(rest.amount) <= 0.02,
    JSON.stringify(a.lines.map((l) => [l.cause, l.amount])));
}

// 3. An unexplained residual is reported, never absorbed.
{
  const then = side('2026-11-01', 12_000, 40_000, 0, 200, ['2026-10']);
  const now = { ...side('2026-11-10', 12_500, 38_000, 0, 200, ['2026-10']) };
  now.value = r2(now.value + 123.45); // a figure the identity does not produce
  const a = attributeInFlightVariance(then, now, H);
  check('3 a residual the identity cannot explain is an UNATTRIBUTED line and exact=false',
    !a.exact && a.lines.at(-1)!.cause === 'UNATTRIBUTED' && Math.abs(a.lines.at(-1)!.amount - 123.45) < 0.02);
}

// 4. The stated side is read only from an OBSERVED-spending checkpoint.
{
  const base = { id: 'm', subject: `liquid-${H}`, statedAs: 's', statedAt: '2026-11-01T22:00:00.000Z' };
  const ok = readCheckpoint({ ...base, payload: { metric: 'liquid', horizon: H, value: 1, basis: { spendingSource: 'OBSERVED', dailyRate: 2, openingCash: 3 } } });
  const side1 = 'unusable' in ok ? null : attributionSideFromCheckpoint(ok);
  check('4a a stored statement becomes a side dated by its statedAt day', side1?.asOfISO === '2026-11-01' && side1.incomeProjected === null);
  const noRate = readCheckpoint({ ...base, payload: { metric: 'liquid', horizon: H, value: 1, basis: { spendingSource: 'OBSERVED', openingCash: 3 } } });
  check('4b without a spending rate there is no attribution (reported as unavailable, not guessed)',
    !('unusable' in noRate) && attributionSideFromCheckpoint(noRate) === null);
}

// 5. The checkpoint writer: an INCOMPLETE figure is not a statement; a complete one records its income term.
{
  const result = (kind: string) => ({ horizon: { to: H, asOf: '2026-11-01' }, projection: { endingCash: 5000, kind,
    basis: { openingCash: 1, spending: { source: 'OBSERVED', dailyRate: 2, monthsAveraged: ['2026-10'] },
      incomeEventsCounted: 4, incomeProjected: 9000, outflowsProjected: 10 } } });
  check('5a an INCOMPLETE_ESTIMATE is never recorded as what we said', projectionStatement('project_cash', result('INCOMPLETE_ESTIMATE'), '2026-11-01') === null);
  const st = projectionStatement('project_cash', result('EVIDENCE_BASED_ESTIMATE'), '2026-11-01');
  check('5b a complete estimate records incomeProjected / outflowsProjected for a later exact attribution',
    st !== null && st.basis.incomeProjected === 9000 && st.basis.outflowsProjected === 10);
  check('5c and both keys are in the closed basis key set', st !== null
    && Object.keys(st.basis).every((k) => (PROJECTION_BASIS_KEYS as readonly string[]).includes(k)));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
