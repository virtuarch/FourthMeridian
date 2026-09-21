/**
 * lib/ai/forecast/assemble-spending.test.ts — S1-2
 *
 * The spending schedule reaches the projection's ONE spend term, through the
 * forecast adapter, and nothing else:
 *   1. inert — no rules ⇒ the assembly is identical to one built without the field;
 *   2. the cumulative projection moves by exactly the spending the rules removed;
 *   3. an interval of it is still the difference of two cumulative runs, and its
 *      spend carries the same schedule;
 *   4. the range moves by the same departure at both ends;
 *   5. a STATED total is transformed too, with category rates from the same months;
 *   6. the licensed engine ignores spending changes — and the outcome says so.
 *
 * Standalone tsx script. Pure.
 */

import { assembleForecast, projectInterval } from './assemble';
import type { ResolvedIncomeStream } from './streams';
import { FinanceDomains, type AccountsSectionData, type SpaceContext_AI } from '@/lib/ai/types';
import { buildMonthlyBreakdown } from '@/lib/ai/assemblers/transactions';
import { resolveStreamActivity } from '@/lib/forecast/stream-activity';
import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { AmountBasis, EventProvenance, FlowRole } from '@/lib/forecast/future-cash-event';
import { PeriodBasis } from '@/lib/forecast/spending-baseline';
import { AssumptionOrigin, StatementMode, type ForecastHorizon, type UserStatement } from '@/lib/forecast/policy';
import type { SpendingChangeRule } from '@/lib/forecast/spending-change';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const cents = (a: number | null | undefined, b: number) => typeof a === 'number' && Math.abs(a - b) < 0.005;

const AS_OF = '2026-09-21';
const HORIZON: ForecastHorizon = { fromISO: AS_OF, toISO: '2027-12-31',
  origin: AssumptionOrigin.USER_REQUESTED, statedAs: 'through 2027-12-31' } as unknown as ForecastHorizon;

// Jun–Aug: Dining 1,500 · Utilities 800 · Shopping 1,700, one 300 Shopping refund in August.
const rows: Record<string, unknown>[] = [];
for (const m of ['2026-06', '2026-07', '2026-08']) {
  rows.push({ id: `${m}a`, date: new Date(`${m}-05T12:00:00Z`), amount: -1_500, currency: 'USD', category: 'Dining', flowType: 'SPENDING' });
  rows.push({ id: `${m}b`, date: new Date(`${m}-10T12:00:00Z`), amount: -800, currency: 'USD', category: 'Utilities', flowType: 'SPENDING' });
  rows.push({ id: `${m}c`, date: new Date(`${m}-15T12:00:00Z`), amount: -1_700, currency: 'USD', category: 'Shopping', flowType: 'SPENDING' });
}
rows.push({ id: 'refund', date: new Date('2026-08-20T12:00:00Z'), amount: 300, currency: 'USD', category: 'Shopping', flowType: 'REFUND' });
const monthlyBreakdown = buildMonthlyBreakdown(rows as never, [], '2026-06-01', AS_OF, null);

const accounts = { totalLiquid: 20_000, totalLiabilities: 0, totalInvestments: 0, totalDigitalAssets: 0,
  redactedCount: 0, totalsUnconverted: false,
  counts: { liquid: 1, liabilities: 0, investments: 0, digitalAssets: 0, realAssets: 0 } } as unknown as AccountsSectionData;
const ctx = { space: { name: 'S', reportingCurrency: 'USD' }, domains: {
  [FinanceDomains.ACCOUNTS]: { data: accounts },
  [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: { monthlyBreakdown } },
} } as unknown as SpaceContext_AI;

const DINING = { category: 'Dining', class: 'WHOLE_BUCKET' as const, meaning: 'restaurants AND groceries' };
const CUT: SpendingChangeRule = { id: 's1', op: 'SCALE', scope: DINING, fromISO: '2027-01-01', multiplier: 0.8 };
const build = (extra: { spendingChanges?: SpendingChangeRule[]; statements?: UserStatement[]; streams?: ResolvedIncomeStream[] } = {}) =>
  assembleForecast({ ctx, streams: extra.streams ?? [], horizon: HORIZON, asOfISO: AS_OF,
    ...(extra.statements ? { statements: extra.statements } : {}),
    ...(extra.spendingChanges ? { spendingChanges: extra.spendingChanges } : {}) });

// ── 1. inert ─────────────────────────────────────────────────────────────────
console.log('1. with no spending changes the assembly is exactly what it was');
{
  const without = build();
  const empty = build({ spendingChanges: [] });
  check('an empty rule list builds the SAME assembly as no field at all (deep-equal, no schedule, no outcome)',
    JSON.stringify(empty) === JSON.stringify(without) && !('spendingChanges' in empty)
      && !('spendingSchedule' in (empty.projectionInput ?? {})));
  check('the observed rate is the net 3,900 over Jun–Aug', cents(without.observedSpending?.monthlyRate, 3_900));
}

// ── 2. the cumulative projection ─────────────────────────────────────────────
console.log('2. the projection moves by exactly the spending removed');
const base = build();
const cut = build({ spendingChanges: [CUT] });
{
  const sc = cut.spendingChanges!;
  check('applied, with the Dining line read from the SAME months (Jun–Aug) at 1,500',
    sc.applied === true && sc.categoryRates.find((c) => c.category === 'Dining')?.monthly === 1_500
      && JSON.stringify(sc.baseline.months) === '["2026-06","2026-07","2026-08"]');
  // 300/month removed for all of 2027: 365 days × 300 / (365/12) = 3,600 exactly.
  check('Dining −20% from January: 300 a month for 365 days = 3,600 removed',
    sc.applied && cents(sc.spendingRemoved, 3_600), sc.applied ? String(sc.spendingRemoved) : sc.reason);
  check('the closing moves by EXACTLY that', cents((cut.projection?.closing ?? 0) - (base.projection?.closing ?? 0), 3_600));
  check('the component says the changes were applied and by how much',
    cut.projection!.components.some((c) => /with your spending changes applied/.test(c.label) && /-3600\.00/.test(c.derivation)));
  check('the assumptions say the changes are a supposition, not a measurement',
    cut.projection!.assumptions.some((a) => /supposition about their future/.test(a)));
  check('the licensed forecast and the events are untouched by a spending rule',
    JSON.stringify(cut.forecast) === JSON.stringify(base.forecast) && JSON.stringify(cut.events) === JSON.stringify(base.events));
}

// ── 3. intervals ─────────────────────────────────────────────────────────────
console.log('3. an interval is still the difference of two cumulative runs');
{
  const i = projectInterval(cut, { fromISO: '2027-01-01', toISO: '2027-06-30' })!;
  const toMid = assembleForecast({ ctx, streams: [], horizon: { ...HORIZON, toISO: '2027-06-30' } as ForecastHorizon,
    asOfISO: AS_OF, spendingChanges: [CUT] });
  const toDec31 = assembleForecast({ ctx, streams: [], horizon: { ...HORIZON, toISO: '2026-12-31' } as ForecastHorizon,
    asOfISO: AS_OF, spendingChanges: [CUT] });
  check('interval closing === the cumulative run to 2027-06-30, and opening === the run to 2026-12-31',
    cents(i.closing?.cash, toMid.projection!.closing!) && cents(i.opening?.cash, toDec31.projection!.closing!));
  // 181 days at (3,900 − 300)/(365/12).
  const spend = i.components.find((c) => /spending/.test(c.label))!.value;
  check('the interval\'s spend carries the schedule: 181 days at 3,600/month', cents(spend, 181 * 3_600 / (365 / 12)), `${spend}`);
  const before = projectInterval(cut, { fromISO: '2026-10-01', toISO: '2026-12-31' })!;
  check('an interval wholly before the rule spends at the unchanged rate and says nothing about changes',
    cents(before.components.find((c) => /spending/.test(c.label))!.value, 92 * 3_900 / (365 / 12))
      && !before.components.some((c) => /spending changes/.test(c.label)));
}

// ── 4. range ─────────────────────────────────────────────────────────────────
console.log('4. the range moves by the same departure at both ends');
{
  check('low and high both move by 3,600', cents(cut.projection!.range!.low - base.projection!.range!.low, 3_600)
    && cents(cut.projection!.range!.high - base.projection!.range!.high, 3_600));
}

// ── 5. a stated total ────────────────────────────────────────────────────────
console.log('5. a STATED total is transformed, the category line still measured');
{
  const stated: UserStatement = { mode: StatementMode.ASSERTS_FACT, statedAs: 'assumed monthly spending 5000',
    asOfISO: AS_OF, subject: { kind: 'SPENDING_LEVEL', amount: 5_000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY } };
  const a = build({ statements: [stated] });
  const b = build({ statements: [stated], spendingChanges: [CUT] });
  const sc = b.spendingChanges!;
  check('baseline basis STATED_TOTAL at 5,000, Dining still the measured 1,500 over Jun–Aug',
    sc.applied && sc.baseline.basis === 'STATED_TOTAL' && sc.baseline.monthly === 5_000
      && sc.categoryRates.find((c) => c.category === 'Dining')?.monthly === 1_500 && JSON.stringify(sc.baseline.months) === '["2026-06","2026-07","2026-08"]');
  // A stated level accrues by the MEAN GREGORIAN month (the engine's constant), and
  // the schedule converts by the base's own: 300 × 365 / (365.2425/12) = 3,597.54.
  const removed = sc.applied ? sc.spendingRemoved : NaN;
  check('…and the closing moves by exactly the spending removed, at the stated level\'s own constant (3,597.54)',
    cents(removed, 300 * 365 / (365.2425 / 12)) && cents((b.projection?.closing ?? 0) - (a.projection?.closing ?? 0), removed),
    `${removed} / ${(b.projection?.closing ?? 0) - (a.projection?.closing ?? 0)}`);
  check('…with NO drift on the days before the rule (2026 at the unchanged stated rate)',
    sc.applied && sc.schedule[0].toISO === '2026-12-31' && sc.schedule[0].daily === sc.baseline.daily);
}

// ── 6. the licensed path ignores them, visibly ───────────────────────────────
console.log('6. the licensed engine ignores spending changes, and the outcome says so');
{
  const cadence = { kind: CadenceKind.BIWEEKLY, anchorISO: '2026-09-11', sourceKey: 'pay',
    provenance: CadenceProvenance.DERIVED, observationCount: 19, confidence: 1, reason: 'biweekly', toleranceDays: 2 } as unknown as Cadence;
  const activity = resolveStreamActivity({ cadence, settlements: ['2026-08-14', '2026-08-28', '2026-09-11'],
    observedThroughISO: AS_OF, asOfISO: AS_OF });
  const PAY = { sourceKey: 'pay', label: 'Pay', role: FlowRole.INCOME, cadence, activity,
    amount: { assertable: true, value: 3_000, currency: 'USD', provenance: EventProvenance.DERIVED, basis: AmountBasis.UNKNOWN,
      basisProvenance: null, regimeStartISO: '2026-04-10', observationCount: 6, spread: 0.001, verdicts: [], reason: 'level' },
    projectionEligible: activity.mayGenerateExpectedOccurrences, settledDepository: true, observationCount: 19, truncated: false,
  } as unknown as ResolvedIncomeStream;
  const facts: UserStatement[] = [
    { mode: StatementMode.ASSERTS_FACT, statedAs: 'I spend 4,000', asOfISO: AS_OF,
      subject: { kind: 'SPENDING_LEVEL', amount: 4_000, currency: 'USD', periodBasis: PeriodBasis.MONTHLY } },
    { mode: StatementMode.ASSERTS_FACT, statedAs: 'my pay is take-home', asOfISO: AS_OF,
      subject: { kind: 'STREAM_AMOUNT_BASIS', sourceKey: 'pay', basis: AmountBasis.NET } },
  ];
  const lic = build({ streams: [PAY], statements: facts });
  const licCut = build({ streams: [PAY], statements: facts, spendingChanges: [CUT] });
  check('precondition: the licensed path answers this fixture', !('refused' in lic.forecast) && lic.forecast.fullCashPath.closing !== null);
  const o = licCut.spendingChanges!;
  check('the outcome is NOT applied, names the rule, and says the figures are without it',
    o.applied === false && JSON.stringify(o.ruleIds) === '["s1"]' && /NONE was applied/.test(o.reason));
  check('…and the licensed forecast is byte-identical with and without the rule',
    JSON.stringify(licCut.forecast) === JSON.stringify(lic.forecast) && licCut.projection === undefined);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall assemble-spending checks passed');
