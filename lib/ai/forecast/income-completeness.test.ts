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
import { incomeCompleteness, continuationOf, isOmittedLine, MATERIALITY, OMITTED_STATUSES, RECENT_SILENCE,
  type IncomeCompleteness } from './income-completeness';
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

// ═══════════════════════════════════════════════════════════════════════════
// FIN-001 (2026-10-22) — the SIBLING: continuation unestablished, not amount.
//
// The runtime audit's fixture, verbatim: a biweekly payroll, 11 flat on-time
// paychecks of $3,000, newest slot 2026-10-02; the 2026-10-16 slot has come due
// (5 days before as-of 2026-10-21) and is unpaid. Before this slice the stream
// read UNKNOWN/SILENT ⇒ LAPSED ⇒ COMPLETE ⇒ `project_cash` said
// EVIDENCE_BASED_ESTIMATE with $15,000 of remaining paychecks silently at $0.
// ═══════════════════════════════════════════════════════════════════════════
{
  const ASOF = '2026-10-21', END = '2026-12-31';
  /** A biweekly stream, amounts oldest → newest, judged at ASOF with the feed reaching `through`. */
  const fixture = (dates: string[], amounts: number[], through: string | null, role: FlowRoleKind = FlowRole.INCOME): ResolvedIncomeStream => {
    const key = 'Acme Payroll';
    const cadence = deriveCadence(dates, key);
    const activity = resolveStreamActivity({ cadence, settlements: dates, observedThroughISO: through, asOfISO: ASOF });
    const amount = isCadence(cadence)
      ? deriveCurrentPeriodicAmount(dates.map((d, i) => ({ dateISO: d, value: amounts[i], currency: 'USD' })), cadence) : null;
    return { sourceKey: key, label: key, role, cadence, activity, amount,
      projectionEligible: activity.mayGenerateExpectedOccurrences, settledDepository: true,
      observationCount: dates.length, truncated: false };
  };
  const biweekly = (lastISO: string, n: number) => Array.from({ length: n }, (_, i) => addDays(lastISO, -14 * (n - 1 - i)));
  const runAt = (streams: ResolvedIncomeStream[], openingCash = 20_000) => {
    const events: FutureCashEvent[] = streams.flatMap((s) => s.amount
      ? periodicCashEvents(s.activity, s.cadence as never, s.amount, ASOF, END, s.role, true) : []);
    const p = projectCash({ openingCash, events, fromISO: ASOF, toISO: END, currency: 'USD',
      spending: { kind: 'USER_ASSUMED', dailyRate: 150, monthlyAmount: null, statedAs: 'test' } });
    const c = incomeCompleteness({ streams, events, excludedIds: new Set(p.excluded.map((x) => x.id)),
      fromISO: ASOF, toISO: END, openingCash });
    return { c, closing: p.closing!, inflow: p.totals!.inflow };
  };
  const FLAT3K = Array(11).fill(3000) as number[];

  // F1. The audit fixture: one slot overdue, feed current ⇒ RECENTLY_SILENT, INCOMPLETE, bound $15,000.
  {
    const s = fixture(biweekly('2026-10-02', 11), FLAT3K, ASOF);
    const { c, inflow } = runAt([s]);
    const pay = c.streams[0];
    check('F1a activity SILENT with one covered miss (the engine\'s licence is unchanged)',
      s.activity.state === 'SILENT' && s.activity.missedOccurrences === 1 && s.projectionEligible === false, JSON.stringify(s.activity));
    check('F1b continuation = RECENTLY_SILENT', continuationOf(s) === 'RECENTLY_SILENT');
    check('F1c status RECENTLY_SILENT, projection INCOMPLETE — never EVIDENCE_BASED under a complete label',
      pay.status === 'RECENTLY_SILENT' && c.status === 'INCOMPLETE' && pay.material === true, JSON.stringify(pay));
    check('F1d the fold still counted $0 for it (the licence decides cash; this slice decides the label)',
      inflow === 0 && pay.counted === 0 && c.projectedIncomeTotal === 0);
    check('F1e the bound is the five remaining slots (10-30, 11-13, 11-27, 12-11, 12-25) × $3,000 = $15,000',
      pay.occurrencesInHorizon === 5 && pay.omittedAtLastObserved === 15000 && c.omittedAtLastObserved === 15000,
      JSON.stringify({ n: pay.occurrencesInHorizon, bound: pay.omittedAtLastObserved }));
    check('F1f the silence is stated in the engine\'s numbers: last satisfied 2026-10-02, 1 unsatisfied slot, feed through as-of',
      pay.silence?.lastSatisfiedOccurrence === '2026-10-02' && pay.silence.unsatisfiedOccurrences === 1
        && pay.silence.ledgerObservedThrough === ASOF, JSON.stringify(pay.silence));
    check('F1g the line is an OMITTED line for the tool layer', isOmittedLine(pay) && OMITTED_STATUSES.has('RECENTLY_SILENT'));
  }

  // F2. Skipped one cycle, then resumed ⇒ CURRENT again, level unchanged, COMPLETE.
  {
    const dates = [...biweekly('2026-09-04', 10), '2026-10-02', '2026-10-16'];
    const s = fixture(dates, Array(12).fill(3000) as number[], ASOF);
    const { c } = runAt([s]);
    check('F2 a stream that skipped 2026-09-18 and resumed is CURRENT, PRESENT, level $3,000, COMPLETE',
      s.activity.state === 'CURRENT' && c.streams[0].status === 'PRESENT' && c.streams[0].level === 3000 && c.status === 'COMPLETE',
      JSON.stringify({ state: s.activity.state, line: c.streams[0] }));
  }

  // F3. A changed amount (new regime) is the regime walk's business and is unaffected.
  {
    const s = fixture(biweekly('2026-10-16', 11), [...Array(8).fill(3000), 3300, 3300, 3300] as number[], ASOF);
    const { c, inflow } = runAt([s]);
    check('F3 three paychecks at a new level ⇒ PRESENT at $3,300, five projected = $16,500, COMPLETE',
      c.streams[0].status === 'PRESENT' && c.streams[0].level === 3300 && inflow === 16500 && c.status === 'COMPLETE',
      JSON.stringify({ line: c.streams[0], inflow }));
  }

  // F4. Discontinued: five unpaid slots ⇒ LAPSED, disclosed, non-blocking.
  {
    const s = fixture(biweekly('2026-08-07', 11), FLAT3K, ASOF);
    const { c } = runAt([s]);
    const pay = c.streams[0];
    check('F4a five covered misses ⇒ LAPSED and the projection stays COMPLETE',
      s.activity.missedOccurrences === 5 && continuationOf(s) === 'LAPSED' && pay.status === 'LAPSED' && c.status === 'COMPLETE',
      JSON.stringify(pay));
    check('F4b disclosed with its silence, but carries NO bound and is not an omitted line',
      pay.silence?.unsatisfiedOccurrences === 5 && pay.omittedAtLastObserved === undefined && !isOmittedLine(pay));
  }

  // F5. The boundary: two unpaid slots are still recent; three are discontinued.
  {
    const two = fixture(biweekly('2026-09-18', 11), FLAT3K, ASOF);
    const three = fixture(biweekly('2026-09-04', 11), FLAT3K, ASOF);
    check('F5a RECENT_SILENCE allows two unsatisfied slots', RECENT_SILENCE.MAX_UNSATISFIED_OCCURRENCES === 2);
    check('F5b two unpaid slots ⇒ RECENTLY_SILENT, INCOMPLETE, bound = remaining five × $3,000',
      continuationOf(two) === 'RECENTLY_SILENT' && runAt([two]).c.status === 'INCOMPLETE'
        && runAt([two]).c.omittedAtLastObserved === 15000);
    check('F5c three unpaid slots ⇒ LAPSED, COMPLETE', continuationOf(three) === 'LAPSED' && runAt([three]).c.status === 'COMPLETE');
  }

  // F6. Feed stale: the sync clock stops before the due slot ⇒ UNKNOWN, blocking, with the bound.
  {
    const s = fixture(biweekly('2026-10-02', 11), FLAT3K, '2026-10-10');
    const { c } = runAt([s]);
    const pay = c.streams[0];
    check('F6a activity UNKNOWN: zero observed misses, one due slot the feed could not see',
      s.activity.state === 'UNKNOWN' && s.activity.missedOccurrences === 0 && s.activity.unobservedDueOccurrences === 1,
      JSON.stringify(s.activity));
    check('F6b status UNKNOWN, projection INCOMPLETE, bound $15,000 — a stale feed is not a complete estimate',
      continuationOf(s) === 'UNKNOWN' && pay.status === 'UNKNOWN' && c.status === 'INCOMPLETE'
        && pay.omittedAtLastObserved === 15000 && pay.silence?.ledgerObservedThrough === '2026-10-10', JSON.stringify(pay));
    const far = fixture(biweekly('2026-07-10', 11), FLAT3K, '2026-07-12');
    check('F6c however far behind the feed is, nobody looked: UNKNOWN, never LAPSED', continuationOf(far) === 'UNKNOWN');
  }

  // F7. On-time control: the newest slot paid, feed current ⇒ PRESENT and $15,000 projected (unchanged).
  {
    const s = fixture(biweekly('2026-10-16', 11), FLAT3K, ASOF);
    const { c, inflow } = runAt([s]);
    check('F7 on time ⇒ CURRENT, PRESENT, five paychecks counted = $15,000, COMPLETE',
      s.activity.state === 'CURRENT' && c.streams[0].status === 'PRESENT' && inflow === 15000
        && c.streams[0].counted === 5 && c.status === 'COMPLETE', JSON.stringify({ line: c.streams[0], inflow }));
  }

  // F8. Materiality still governs: a recently silent $20 stream beside a live payroll does not block.
  {
    const pay = fixture(biweekly('2026-10-16', 11), FLAT3K, ASOF);
    const tiny = { ...fixture(biweekly('2026-10-02', 11), Array(11).fill(20) as number[], ASOF), sourceKey: 'tiny', label: 'tiny' };
    const { c } = runAt([pay, tiny]);
    const t = c.streams.find((l) => l.stream === 'tiny')!;
    check('F8 an immaterial recently-silent stream is listed (material false) and the projection stays COMPLETE',
      t.status === 'RECENTLY_SILENT' && t.material === false && t.omittedAtLastObserved === 100 && c.status === 'COMPLETE', JSON.stringify(t));
  }

  // F9. INTEREST never decides completeness, recently silent or not.
  {
    const int = fixture(biweekly('2026-10-02', 11), Array(11).fill(500) as number[], ASOF, FlowRole.INTEREST);
    const { c } = runAt([int], 10);
    check('F9 a recently silent INTEREST stream is disclosed but never blocks',
      c.streams[0].status === 'RECENTLY_SILENT' && c.status === 'COMPLETE');
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
