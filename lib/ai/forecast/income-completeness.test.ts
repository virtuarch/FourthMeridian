/**
 * lib/ai/forecast/income-completeness.test.ts  (AI RELIABILITY 2026-10-16)
 *
 * What a projection's income term HOLDS, per stream — through the REAL chain:
 * cadence → activity licence → current amount → dated events → projectCash's
 * fold. No fixture invents an `excluded` list; the fold produces it.
 *
 *   npx tsx lib/ai/forecast/income-completeness.test.ts
 */

import { deriveCadence, isCadence } from '@/lib/forecast/cadence';
import { resolveStreamActivity } from '@/lib/forecast/stream-activity';
import { deriveCurrentPeriodicAmount, periodicCashEvents } from '@/lib/forecast/periodic-amount';
import { FlowRole, type FlowRoleKind, type FutureCashEvent } from '@/lib/forecast/future-cash-event';
import { projectCash } from '@/lib/forecast/projection';
import { addDays } from '@/lib/forecast/_time';
import { incomeCompleteness, MATERIALITY, type IncomeCompleteness } from './income-completeness';
import type { ResolvedIncomeStream } from './streams';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const AS_OF = '2026-10-16';
const TO = '2026-12-31';

/** A biweekly stream ending on `lastISO`, its amounts oldest → newest. */
function stream(key: string, amounts: number[], lastISO: string, role: FlowRoleKind = FlowRole.INCOME): ResolvedIncomeStream {
  const dates = amounts.map((_, i) => addDays(lastISO, -14 * (amounts.length - 1 - i)));
  const cadence = deriveCadence(dates, key);
  const activity = resolveStreamActivity({ cadence, settlements: dates, observedThroughISO: AS_OF, asOfISO: AS_OF });
  const amount = isCadence(cadence)
    ? deriveCurrentPeriodicAmount(dates.map((d, i) => ({ dateISO: d, value: amounts[i], currency: 'USD' })), cadence)
    : null;
  return { sourceKey: key, label: key, role, cadence, activity, amount,
    projectionEligible: activity.mayGenerateExpectedOccurrences, settledDepository: true,
    observationCount: dates.length, truncated: false };
}

function run(streams: ResolvedIncomeStream[], openingCash = 20_000): { c: IncomeCompleteness; closing: number; inflow: number } {
  const events: FutureCashEvent[] = streams.flatMap((s) => s.amount
    ? periodicCashEvents(s.activity, s.cadence as never, s.amount, AS_OF, TO, s.role, true) : []);
  const p = projectCash({ openingCash, events, fromISO: AS_OF, toISO: TO, currency: 'USD',
    spending: { kind: 'USER_ASSUMED', dailyRate: 150, monthlyAmount: null, statedAs: 'test' } });
  const c = incomeCompleteness({ streams, events, excludedIds: new Set(p.excluded.map((x) => x.id)),
    fromISO: AS_OF, toISO: TO, openingCash });
  return { c, closing: p.closing!, inflow: p.totals!.inflow };
}

const FLAT = [5267.10, 5267.13, 5286.64, 5286.65, 5286.63, 5286.40, 5306.12, 5286.64, 5286.64, 5286.64, 5286.64];

// 1. A stable payroll: COMPLETE, and the per-stream total restates the fold's income term.
{
  const { c, inflow } = run([stream('payroll', [...FLAT, 5286.64], '2026-10-09')]);
  const pay = c.streams[0];
  check('1a stable payroll ⇒ COMPLETE, PRESENT, every occurrence counted',
    c.status === 'COMPLETE' && pay.status === 'PRESENT' && pay.counted === pay.occurrencesInHorizon && pay.counted > 0,
    JSON.stringify(pay));
  check('1b Σ per-stream totals equals the fold\'s income term to the cent',
    Math.abs(c.projectedIncomeTotal - inflow) < 0.01, `${c.projectedIncomeTotal} vs ${inflow}`);
  check('1c counted / excluded are the INCOME events the fold actually counted (not generated)',
    c.incomeEventsCounted === pay.counted && c.incomeEventsExcluded === 0);
}

// 2. One high newest paycheck: the level stands, the deviation is disclosed with its arithmetic.
{
  const { c } = run([stream('payroll', [...FLAT, 6770.32], '2026-10-09')]);
  const pay = c.streams[0];
  check('2a one high newest paycheck ⇒ PRESENT_LATEST_DEVIATES, still counted, COMPLETE',
    c.status === 'COMPLETE' && pay.status === 'PRESENT_LATEST_DEVIATES' && pay.counted > 0 && pay.level !== null
      && Math.abs(pay.level - 5286.64) < 0.01, JSON.stringify(pay));
  check('2b ifLatestIsNewLevel = (latest − level) × counted, computed — never left to prose',
    !!pay.ifLatestIsNewLevel && Math.abs(pay.ifLatestIsNewLevel.total - (6770.32 - pay.level!) * pay.counted) < 0.01);
}

// 3. A payroll whose level is NOT established (two at a new level): INCOMPLETE, never silently $0.
{
  const { c } = run([stream('payroll', [...FLAT.slice(0, 10), 6770.32, 6770.32], '2026-10-09')]);
  const pay = c.streams[0];
  check('3a amount unestablished on a CURRENT payroll ⇒ AMOUNT_UNESTABLISHED, material, projection INCOMPLETE',
    c.status === 'INCOMPLETE' && pay.status === 'AMOUNT_UNESTABLISHED' && pay.material === true && pay.counted === 0
      && pay.occurrencesInHorizon > 0, JSON.stringify(pay));
  check('3b the omission is sized from the platform\'s own last observed deposit',
    pay.lastObserved?.amount === 6770.32 && pay.omittedAtLastObserved === Math.round(pay.occurrencesInHorizon * 6770.32 * 100) / 100
      && c.omittedAtLastObserved === pay.omittedAtLastObserved);
}

// 4. A tiny variable deposit stream with no level: listed, but immaterial ⇒ the projection stays COMPLETE.
{
  const { c } = run([stream('payroll', [...FLAT, 5286.64], '2026-10-09'), stream('interest-like', [12.1, 30.5, 8.2, 22.4, 15.0, 9.9, 26.3, 28.84], '2026-10-10')]);
  const tiny = c.streams.find((l) => l.stream === 'interest-like')!;
  check('4a an unpriced stream below MATERIALITY is listed (AMOUNT_UNESTABLISHED, material false) and does NOT make the projection incomplete',
    c.status === 'COMPLETE' && tiny.status === 'AMOUNT_UNESTABLISHED' && tiny.material === false,
    JSON.stringify({ status: c.status, tiny }));
  check('4b materiality is a share of opening cash + counted income, with a floor', MATERIALITY.SHARE === 0.01 && MATERIALITY.FLOOR_USD === 50);
}

// 5. A lapsed stream: reported as LAPSED, generates nothing, never makes a projection incomplete.
{
  const { c } = run([stream('payroll', [...FLAT, 5286.64], '2026-10-09'), stream('old-job', [5015.68, 5015.68, 5015.68, 5015.68, 5015.68], '2025-12-24')]);
  const old = c.streams.find((l) => l.stream === 'old-job')!;
  check('5 a stream that stopped is LAPSED with 0 occurrences and the projection is COMPLETE',
    old.status === 'LAPSED' && old.occurrencesInHorizon === 0 && c.status === 'COMPLETE', JSON.stringify(old));
}

// 6. INTEREST role never decides completeness, however unpriced.
{
  const { c } = run([stream('payroll', [...FLAT, 5286.64], '2026-10-09'), stream('int', [0.01, 0.09, 0.03, 0.10], '2026-10-01', FlowRole.INTEREST)], 10);
  check('6 an unpriced INTEREST stream is reported but never makes the projection incomplete',
    c.status === 'COMPLETE' && c.streams.some((l) => l.role === 'INTEREST'));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
