/**
 * lib/ai/conversation/projection-temporal.test.ts — FM-AUDIT-008 / 009 / 011
 *
 * Projection temporal correctness, pinned before S1 compounds it:
 *
 *   A. PAYDAY — an occurrence an observed settlement already paid is in today's
 *      balance, so it is never ALSO generated as expected income. Activity is
 *      resolved by the production resolver from settlement dates, and events by
 *      the production generator (cadenceDerivedEvents → expectedOccurrencesBetween).
 *   B. LIABILITY OBLIGATIONS — a stated minimum is owed ONCE per calendar month,
 *      due at its month-end, whatever extra dates a rule or horizon adds to the
 *      spine; short months, leap years, a skipped grid month-end, several lines.
 *   C. DERIVED FLOORS — "N months of expenses" recomputes when a run changes the
 *      spending it depends on; an absolute dollar floor never moves.
 *
 * Standalone tsx script, pure — no DB, no clock.
 */

import { CadenceKind, CadenceProvenance, type Cadence } from '@/lib/forecast/cadence';
import { resolveStreamActivity, expectedOccurrencesBetween } from '@/lib/forecast/stream-activity';
import { cadenceDerivedEvents } from '@/lib/forecast/future-cash-event';
import {
  settleMovements, isMonthEndISO, monthEndsBetween, runScenarioLedger,
  type LiabilityLine, type SpinePoint, type PlannedMovement,
} from './scenario-ledger';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});

async function main(): Promise<void> {
  // ── A. payday ────────────────────────────────────────────────────────────
  console.log('A. a settled paycheque is not projected again');
  const biweekly: Cadence = { kind: CadenceKind.BIWEEKLY, anchorISO: '2026-09-04', provenance: CadenceProvenance.DERIVED, sourceKey: 'payroll@chk' };
  const PAYDAY = '2026-09-18';
  /** Activity as production resolves it, from what the ledger holds on `asOf`. */
  const activityAt = (asOf: string, settlements: string[], cadence: Cadence = biweekly) =>
    resolveStreamActivity({ cadence, settlements, observedThroughISO: asOf, asOfISO: asOf });
  const first = (asOf: string, settlements: string[], cadence: Cadence = biweekly) =>
    expectedOccurrencesBetween(activityAt(asOf, settlements, cadence), cadence, asOf, `${Number(asOf.slice(0, 4)) + 1}-12-31`)[0];

  check('day BEFORE payday: the first expected occurrence is payday',
    first('2026-09-17', ['2026-08-21', '2026-09-04']) === PAYDAY);
  check('payday, deposit NOT yet observed: payday itself is still expected (not in the balance)',
    first(PAYDAY, ['2026-08-21', '2026-09-04']) === PAYDAY);
  check('THE AUDIT CASE — payday, deposit observed: payday is NOT generated again; the next one is first',
    first(PAYDAY, ['2026-09-04', PAYDAY]) === '2026-10-02', first(PAYDAY, ['2026-09-04', PAYDAY]));
  check('day AFTER payday, deposit observed: the next occurrence is first',
    first('2026-09-19', ['2026-09-04', PAYDAY]) === '2026-10-02');
  check('day after payday, deposit late (not observed): yesterday\'s slot is NOT claimed — cash is only claimed forward',
    first('2026-09-19', ['2026-08-21', '2026-09-04']) === '2026-10-02');
  const semi: Cadence = { kind: CadenceKind.SEMIMONTHLY, anchorISO: '2026-09-10', daysOfMonth: [10, 25], provenance: CadenceProvenance.DERIVED, sourceKey: 'abacus@chk' };
  check('paid EARLY (the 24th for the 25th), asOf the 24th: the 25th is not generated',
    first('2026-09-24', ['2026-09-10', '2026-09-24'], semi) === '2026-10-10', first('2026-09-24', ['2026-09-10', '2026-09-24'], semi));
  check('…and on the 25th itself, still not', first('2026-09-25', ['2026-09-10', '2026-09-24'], semi) === '2026-10-10');
  const monthlyEnd: Cadence = { kind: CadenceKind.MONTHLY, anchorISO: '2026-01-31', daysOfMonth: [31], provenance: CadenceProvenance.DERIVED, sourceKey: 'rent-in@chk' };
  check('date boundary: a 31st-of-month cadence settled on Feb 28 satisfies February, so March 31 is first',
    first('2027-02-28', ['2027-01-29', '2027-02-26'], monthlyEnd) === '2027-03-31', first('2027-02-28', ['2027-01-29', '2027-02-26'], monthlyEnd));
  const events = cadenceDerivedEvents(activityAt(PAYDAY, ['2026-09-04', PAYDAY]), biweekly, PAYDAY, '2026-11-30', 'EARNED_INCOME' as never);
  check('the production event generator agrees: no event on the settled payday',
    events.length > 0 && events.every((e) => e.timing.kind === 'EXACT' && e.timing.dateISO > PAYDAY)
      && (events[0].timing as { dateISO: string }).dateISO === '2026-10-02');
  check('a stream the activity refuses still generates nothing', expectedOccurrencesBetween(
    { ...activityAt(PAYDAY, ['2026-09-04', PAYDAY]), mayGenerateExpectedOccurrences: false }, biweekly, PAYDAY, '2026-12-31').length === 0);

  // ── B. liability obligations ─────────────────────────────────────────────
  console.log('B. one minimum per obligation month');
  const card = (id = 'card', balance = 5_000, min = 100): LiabilityLine => ({ id, label: id, balance, apr: 24, minimumPayment: min });
  const sp = (dates: string[]): SpinePoint[] => dates.map((date) => ({ date, liquid: 20_000, isCheckpoint: isMonthEndISO(date) }));
  const mins = (dates: string[], asOf: string, lines: LiabilityLine[] = [card()]) => {
    const r = settleMovements([], [], sp(dates), 20_000, lines, asOf);
    return (d: string) => [...r.minimumsByDate.entries()].filter(([k]) => k <= d).reduce((t, [, v]) => t + v, 0);
  };
  const upTo = mins(['2026-06-30', '2026-07-31'], '2026-06-10');
  check('month-end grid: one minimum per month-end', upTo('2026-06-30') === 100 && upTo('2026-07-31') === 200);
  const midRule = mins(['2026-06-15', '2026-06-30', '2026-07-31'], '2026-06-10');
  check('THE AUDIT CASE — a rule dated the 15th adds a spine date, NOT a second June minimum',
    midRule('2026-06-15') === 0 && midRule('2026-06-30') === 100 && midRule('2026-07-31') === 200,
    `${midRule('2026-06-15')}/${midRule('2026-06-30')}/${midRule('2026-07-31')}`);
  const lateRule = mins(['2026-06-30', '2026-07-20', '2026-07-31'], '2026-06-10');
  check('a rule introduced after the month\'s first boundary (the 20th) adds nothing', lateRule('2026-07-20') === 100 && lateRule('2026-07-31') === 200);
  const midHorizon = mins(['2026-06-30', '2026-07-31', '2026-08-15'], '2026-06-10');
  check('a mid-month horizon: the partial month owes nothing yet', midHorizon('2026-08-15') === 200);
  check('a short month: February 2027 owes once, at Feb 28',
    isMonthEndISO('2027-02-28') && mins(['2027-01-31', '2027-02-14', '2027-02-28'], '2027-01-10')('2027-02-28') === 200);
  check('a leap year: Feb 28 2028 is NOT a month-end, Feb 29 is',
    !isMonthEndISO('2028-02-28') && isMonthEndISO('2028-02-29')
      && mins(['2028-02-28', '2028-02-29'], '2028-02-01')('2028-02-28') === 0
      && mins(['2028-02-28', '2028-02-29'], '2028-02-01')('2028-02-29') === 100);
  check('asOf on a month-end: that month is already in the balance and owes nothing',
    mins(['2026-07-31'], '2026-06-30')('2026-07-31') === 100);
  const skipped = mins(['2026-06-30', '2026-08-31'], '2026-06-10');
  check('a grid that skipped a month-end pays July once, late — never zero, never twice',
    skipped('2026-06-30') === 100 && skipped('2026-08-31') === 300);
  const two = mins(['2026-06-15', '2026-06-30', '2026-07-31'], '2026-06-10', [card('a', 5_000, 100), card('b', 2_000, 40)]);
  check('several liabilities: each pays its own minimum once per month', two('2026-06-30') === 140 && two('2026-07-31') === 280);
  const paidOff = mins(['2026-06-30', '2026-07-31'], '2026-06-10', [card('c', 150, 100)]);
  check('a minimum never exceeds what is owed', paidOff('2026-07-31') <= 150 + 150 * 0.24 * (51 / 365) + 0.01);
  // through the full ledger: cash and debt move by exactly one minimum per month
  const ledgerDates = ['2026-06-15', ...monthEndsBetween('2026-06-10', '2026-09-30')];
  const L = runScenarioLedger({ opening: { asOfISO: '2026-06-10', liquid: 20_000, investments: 0, debt: 5_000, otherAssets: 0,
    liabilities: [{ ...card(), apr: null }] }, spine: sp(ledgerDates), contributions: [], outflows: [], returns: [] });
  const sep = L.checkpoints.find((c) => c.date === '2026-09-30')!;
  check('ledger: four months, four minimums — debt 5,000 → 4,600 and cash 20,000 → 19,600 at 0% (not 4,500 / 19,500)',
    Math.abs(sep.debt.amount - 4_600) < 0.01 && Math.abs((sep.liquid?.amount ?? NaN) - 19_600) < 0.01, `debt ${sep.debt.amount} liquid ${sep.liquid?.amount}`);

  // ── C. derived floors ────────────────────────────────────────────────────
  console.log('C. a derived floor recomputes with its dependency');
  const { rebindDerivedFloors } = await import('./tools');
  const base = { amount: 5_000, source: 'OBSERVED' };
  const baseDerivation = { liquidFloor: 30_000, derivedFrom: { rule: '6 × 5000', monthsOfExpenses: 6,
    baseline: { amount: 5_000, basis: 'MEASURED' as const, note: 'observed' } } };
  const moves: PlannedMovement[] = [
    { date: '2026-10-31', label: 'keep 6 months', liquidFloor: 30_000, fractionOfExcess: 1, floorMonthsOfExpenses: 6 },
    { date: '2026-10-31', label: 'keep $10k', liquidFloor: 10_000, fractionOfExcess: 0.5 },
  ];
  const same = rebindDerivedFloors(moves, undefined, base, [baseDerivation]);
  check('at the base spending level nothing moves', !('unavailable' in same) && same.movements[0].liquidFloor === 30_000 && same.derivations[0] === baseDerivation);
  const cut = rebindDerivedFloors(moves, 4_000, base, [baseDerivation]);
  check('THE AUDIT CASE — a run at $4,000/month holds 6 × 4,000 = 24,000, not the uncut 30,000',
    !('unavailable' in cut) && cut.movements[0].liquidFloor === 24_000, JSON.stringify(!('unavailable' in cut) && cut.movements[0]));
  check('…and the echoed derivation says the run re-resolved it at its own level',
    !('unavailable' in cut) && cut.derivations[0].liquidFloor === 24_000 && /re-resolved at the 4000\/month/.test(cut.derivations[0].derivedFrom.baseline.note));
  check('an ABSOLUTE dollar floor never moves', !('unavailable' in cut) && cut.movements[1].liquidFloor === 10_000);
  check('the input movements are not mutated', moves[0].liquidFloor === 30_000);
  const zero = rebindDerivedFloors(moves, 0, base, [baseDerivation]);
  check('a run that spends nothing holds a zero derived floor (a solve\'s bracket reaches "cut everything")',
    !('unavailable' in zero) && zero.movements[0].liquidFloor === 0);
  const stated = rebindDerivedFloors(moves, 3_000, { amount: 6_000, source: 'USER_STATED' }, [baseDerivation]);
  check('a STATED base keeps the stated rung at the transformed level',
    !('unavailable' in stated) && stated.movements[0].liquidFloor === 18_000 && stated.derivations[0].derivedFrom.baseline.basis === 'STATED');

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall projection temporal checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
