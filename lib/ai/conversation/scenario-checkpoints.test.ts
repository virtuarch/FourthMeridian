/**
 * lib/ai/conversation/scenario-checkpoints.test.ts
 *
 * WHICH DATES A TABLE HAS ROWS FOR — pinned purely.
 *
 * ⚠️ THE DEFECT THIS PINS. A 2029 horizon defaulted to four yearly rows and
 * `quarterly` could not be asked for, so a quarterly table was interpolated by
 * the model; a 102-month monthly request kept 79 rows and the horizon and
 * silently dropped 2033-06..2034-12, and the model filled the hole. Every check
 * below is about DATES: nothing here computes money, and nothing here may.
 *
 *   npx tsx lib/ai/conversation/scenario-checkpoints.test.ts
 */

import {
  quarterEndsBetween, yearEndsBetween, periodEndsBetween, defaultCadence, planCheckpoints,
  compactMovements, compactExcludedEvents, describePlan, MAX_SCENARIO_CHECKPOINTS, MONTHLY_DEFAULT_MAX_DAYS,
  MOVEMENTS_SHOWN, CADENCES,
} from './scenario-checkpoints';
import { monthEndsBetween, expandContributions, runScenarioLedger,
  type SpinePoint } from './scenario-ledger';
import { findScenarioCrossing } from './scenario-crossing';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const ASOF = '2026-09-13';
const ascendingUnique = (ds: string[]) => ds.every((d, i) => i === 0 || d > ds[i - 1]);

console.log('A. quarter-ends are generated, off the month-end grid');
{
  const q = quarterEndsBetween(ASOF, '2027-12-31');
  check('every calendar quarter-end after asOf, through the horizon',
    q.join(',') === '2026-09-30,2026-12-31,2027-03-31,2027-06-30,2027-09-30,2027-12-31', q.join(','));
  check('each is a month-end the monthly grid also has',
    q.every((d) => monthEndsBetween(ASOF, '2027-12-31').includes(d)));
  check('a horizon that is not a quarter-end is appended as the last row (B)',
    quarterEndsBetween(ASOF, '2035-02-28').slice(-1)[0] === '2035-02-28'
      && quarterEndsBetween(ASOF, '2035-02-28').slice(-2)[0] === '2034-12-31');
  check('a horizon that IS a quarter-end is not duplicated',
    quarterEndsBetween(ASOF, '2027-06-30').filter((d) => d === '2027-06-30').length === 1);
  check('an asOf on a quarter-end excludes that day (strictly after)',
    quarterEndsBetween('2026-09-30', '2027-03-31').join(',') === '2026-12-31,2027-03-31');
  check('the yearly generator still ends at the horizon and is still December',
    yearEndsBetween(ASOF, '2030-06-30').join(',') === '2026-12-31,2027-12-31,2028-12-31,2029-12-31,2030-06-30');
  for (const c of CADENCES) {
    const ds = periodEndsBetween(c, ASOF, '2046-09-13');
    check(`${c}: ascending, unique, horizon last`, ascendingUnique(ds) && ds.slice(-1)[0] === '2046-09-13', String(ds.length));
  }
  check('35 quarterly rows to 2035-02-28 (34 quarter-ends plus the horizon) — the investigation\'s expected table',
    quarterEndsBetween(ASOF, '2035-02-28').length === 35, String(quarterEndsBetween(ASOF, '2035-02-28').length));
}

console.log('\nD–F. the default cadence');
{
  check(`monthly within ${MONTHLY_DEFAULT_MAX_DAYS} days (18 months)`, defaultCadence(ASOF, '2028-03-13') === 'monthly'
    && defaultCadence(ASOF, '2027-12-31') === 'monthly');
  check('a day past eighteen months is quarterly', defaultCadence(ASOF, '2028-03-15') === 'quarterly');
  check('to 2029-12-31 — the dogfood horizon — is now quarterly, not four yearly rows',
    defaultCadence(ASOF, '2029-12-31') === 'quarterly'
      && planCheckpoints({ asOfISO: ASOF, toISO: '2029-12-31' }).dates.length === 14);
  check('quarterly while the quarters fit the ceiling (twenty years)',
    defaultCadence(ASOF, '2046-06-30') === 'quarterly'
      && quarterEndsBetween(ASOF, '2046-06-30').length === MAX_SCENARIO_CHECKPOINTS);
  check('one quarter past that is yearly — a default never arrives with an omission',
    defaultCadence(ASOF, '2046-09-13') === 'yearly'
      && planCheckpoints({ asOfISO: ASOF, toISO: '2046-09-13' }).omitted === undefined);
  check('thirty years is yearly by default', defaultCadence(ASOF, '2056-09-13') === 'yearly');
  const p = planCheckpoints({ asOfISO: ASOF, toISO: '2029-12-31' });
  check('a default plan says it was a default', p.source === 'DEFAULT' && p.requested === null);
}

console.log('\nG. an explicit cadence wins');
{
  const m = planCheckpoints({ asOfISO: ASOF, toISO: '2029-12-31', requested: 'monthly' });
  check('explicit monthly below the ceiling: 40 rows, nothing omitted',
    m.cadence === 'monthly' && m.source === 'REQUESTED' && m.dates.length === 40 && !m.omitted);
  const y = planCheckpoints({ asOfISO: ASOF, toISO: '2027-06-30', requested: 'yearly' });
  check('explicit yearly on a short horizon: December and the horizon',
    y.dates.join(',') === '2026-12-31,2027-06-30' && y.source === 'REQUESTED');
  const q = planCheckpoints({ asOfISO: ASOF, toISO: '2035-02-28', requested: 'quarterly' });
  check('explicit quarterly to 2035-02-28: 35 rows ending at the horizon',
    q.dates.length === 35 && q.dates.slice(-1)[0] === '2035-02-28' && q.cadence === 'quarterly' && !q.omitted);
}

console.log('\nH–I. the ceiling: thinned to a coarser regular cadence, and the omission is named');
{
  const p = planCheckpoints({ asOfISO: ASOF, toISO: '2035-02-28', requested: 'monthly' });
  check('102 monthly rows exceed the ceiling → quarterly is returned',
    p.cadence === 'quarterly' && p.source === 'THINNED' && p.requested === 'monthly');
  check('…35 rows, horizon last, ascending, unique',
    p.dates.length === 35 && p.dates.slice(-1)[0] === '2035-02-28' && ascendingUnique(p.dates));
  check('…every returned date was in the requested grid',
    p.dates.every((d) => monthEndsBetween(ASOF, '2035-02-28').includes(d)));
  check('…and the omission counts exactly the month-ends that fell out',
    p.omitted?.how === 'THINNED' && p.omitted.count === 102 - 35
      && p.omitted.from === '2026-10-31' && p.omitted.to === '2035-01-31', JSON.stringify(p.omitted));
  check('…the once-invented rows are all real dates now',
    ['2033-06-30', '2033-09-30', '2033-12-31', '2034-03-31', '2034-06-30', '2034-09-30', '2034-12-31']
      .every((d) => p.dates.includes(d)));
  check('no clamp is reported on a thinned plan', p.clampedTo === undefined);

  const q = planCheckpoints({ asOfISO: ASOF, toISO: '2056-09-13', requested: 'quarterly' });
  check('121 quarterly rows → yearly (31), the horizon kept',
    q.cadence === 'yearly' && q.dates.length === 31 && q.dates.slice(-1)[0] === '2056-09-13'
      && q.omitted?.count === 121 - 31 && q.omitted.how === 'THINNED');
  const mm = planCheckpoints({ asOfISO: ASOF, toISO: '2056-09-13', requested: 'monthly' });
  check('361 monthly rows → walks past quarterly to yearly, omission counted against MONTHLY',
    mm.cadence === 'yearly' && mm.omitted?.count === 361 - 31 && mm.requested === 'monthly');

  // The last resort: yearly itself past the ceiling.
  const far = planCheckpoints({ asOfISO: ASOF, toISO: '2126-09-13', requested: 'yearly' });
  check('a hundred years yearly: clamped, horizon kept, the contiguous hole named',
    far.clampedTo === MAX_SCENARIO_CHECKPOINTS && far.dates.length === MAX_SCENARIO_CHECKPOINTS
      && far.dates.slice(-1)[0] === '2126-09-13' && far.omitted?.how === 'CLAMPED'
      && far.omitted.from === '2105-12-31' && far.omitted.to === '2125-12-31' && far.omitted.count === 21,
    JSON.stringify(far.omitted));
  check('…and it is the only path that clamps', [p, q, mm].every((x) => x.clampedTo === undefined));
  check('the same request always plans the same dates',
    JSON.stringify(planCheckpoints({ asOfISO: ASOF, toISO: '2035-02-28', requested: 'monthly' }))
      === JSON.stringify(p));
}

console.log('\nJ. no fabricated checkpoints — every planned date is a ledger state');
{
  const p = planCheckpoints({ asOfISO: ASOF, toISO: '2035-02-28', requested: 'monthly' });
  // A spine with a value only on the planned dates, as prepareScenario builds it.
  const spine: SpinePoint[] = monthEndsBetween(ASOF, '2035-02-28').map((date, i) =>
    ({ date, liquid: 15_000 + (i + 1) * 6_000, isCheckpoint: p.dates.includes(date) }));
  const { movements } = expandContributions([{ liquidFloor: 50_000, fractionOfExcess: 1 }], ASOF, '2035-02-28');
  const ledger = runScenarioLedger({ opening: { asOfISO: ASOF, liquid: 15_000, investments: 20_000, debt: 0, otherAssets: 0 },
    spine, contributions: movements, outflows: [], returns: [{ fromISO: ASOF, toISO: '2035-02-28', annualPct: 7 }] });
  check('the ledger emits exactly the planned dates, in order',
    ledger.checkpoints.map((c) => c.date).join(',') === p.dates.join(','));
  check('a quarterly row equals the same date\'s row from a monthly run of the same ledger (no second path)',
    (() => {
      const full = runScenarioLedger({ opening: ledger.opening, spine: spine.map((s) => ({ ...s, isCheckpoint: true })),
        contributions: movements, outflows: [], returns: [{ fromISO: ASOF, toISO: '2035-02-28', annualPct: 7 }] });
      return ledger.checkpoints.every((c) => JSON.stringify({ ...c, movements: undefined })
        === JSON.stringify({ ...full.checkpoints.find((f) => f.date === c.date)!, movements: undefined }));
    })());
  check('N. the crossing walked on the full monthly ledger lands on a date the quarterly table also shows or brackets',
    (() => {
      const full = runScenarioLedger({ opening: ledger.opening, spine: spine.map((s) => ({ ...s, isCheckpoint: true })),
        contributions: movements, outflows: [], returns: [{ fromISO: ASOF, toISO: '2035-02-28', annualPct: 7 }] });
      const hit = findScenarioCrossing({ checkpoints: full.checkpoints, opening: full.opening,
        metric: 'netWorth', direction: 'at_or_above', threshold: 300_000 });
      const after = ledger.checkpoints.find((c) => c.date >= hit.crossing!.checkpoint.date)!;
      return hit.crossing !== null && (after.netWorth!.amount >= 300_000);
    })());
}

console.log('\nK–L. movement compaction');
{
  const { movements } = expandContributions([{ liquidFloor: 50_000, fractionOfExcess: 1 }], ASOF, '2056-09-13');
  const spine: SpinePoint[] = monthEndsBetween(ASOF, '2056-09-13').map((date, i) =>
    ({ date, liquid: 15_000 + (i + 1) * 6_000, isCheckpoint: true }));
  const ledger = runScenarioLedger({ opening: { asOfISO: ASOF, liquid: 15_000, investments: 20_000, debt: 0, otherAssets: 0 },
    spine, contributions: movements, outflows: [{ date: '2027-06-30', amount: 4_000, label: 'trip' }], returns: [] });
  const c = compactMovements(ledger.movements);
  check(`361 contributions + 1 outflow → the first ${MOVEMENTS_SHOWN} shown, all counted`,
    c.count === 362 && c.first.length === MOVEMENTS_SHOWN && c.compacted === true && !!c.note);
  check('contribution total equals the ledger\'s own total to date at the horizon (conserved)',
    c.contributions.total === ledger.checkpoints[ledger.checkpoints.length - 1].movements.contributionsToDate.total
      && c.contributions.count === 361);
  check('outflow total and count likewise', c.outflows.total === 4_000 && c.outflows.count === 1);
  check('the shown movements are the first applied, verbatim',
    JSON.stringify(c.first) === JSON.stringify(ledger.movements.slice(0, MOVEMENTS_SHOWN)));
  const small = compactMovements(ledger.movements.slice(0, 5));
  check('five movements are not compacted and carry no note', small.compacted === false && small.first.length === 5 && !small.note);
  check('the compact form is far smaller than the list it stands for',
    JSON.stringify(c).length < JSON.stringify(ledger.movements).length / 10,
    `${JSON.stringify(c).length} B vs ${JSON.stringify(ledger.movements).length} B`);
}

console.log('\nM. one description of a plan, for every tool that plans');
{
  const plain = describePlan(planCheckpoints({ asOfISO: ASOF, toISO: '2029-12-31' }));
  check('a default plan: cadence, count, source, and nothing about omission',
    JSON.stringify(plain) === JSON.stringify({ granularity: 'quarterly', checkpoints: 14, cadenceSource: 'DEFAULT' }));
  const thinned = describePlan(planCheckpoints({ asOfISO: ASOF, toISO: '2035-02-28', requested: 'monthly' }));
  check('a thinned plan names what was asked, says why, and lists the omission with its meaning',
    thinned.granularity === 'quarterly' && thinned.requested === 'monthly' && /exceed 80/.test(String(thinned.thinning))
      && thinned.omitted?.count === 67 && /NO row/.test(String(thinned.omitted?.meaning)) && !('clampedTo' in thinned));
  const clamped = describePlan(planCheckpoints({ asOfISO: ASOF, toISO: '2126-09-13', requested: 'yearly' }));
  check('a clamped plan carries the ceiling and the contiguous hole', clamped.clampedTo === 80 && clamped.omitted?.how === 'CLAMPED');
}

console.log('\nN. excluded events are grouped by stream and reason');
{
  const events = [
    ...monthEndsBetween(ASOF, '2029-12-31').map((d) => ({ id: `INTEREST@acct1@${d}`, reason: 'no amount is established for this event' })),
    ...monthEndsBetween(ASOF, '2027-12-31').map((d) => ({ id: `FEE@acct2@${d}`, reason: 'no amount is established for this event' })),
    { id: 'BONUS@acct1@2027-03-01', reason: 'dated before the horizon opens' },
    { id: 'odd-id-without-date', reason: 'x' },
  ];
  const c = compactExcludedEvents(events);
  check('every occurrence is counted', c.count === events.length && c.compacted === true && !!c.note);
  check('one group per stream and reason, with span and occurrences',
    c.groups.length === 4 && c.groups[0].stream === 'INTEREST@acct1' && c.groups[0].occurrences === 40
      && c.groups[0].first === '2026-09-30' && c.groups[0].last === '2029-12-31'
      && c.groups[1].stream === 'FEE@acct2' && c.groups[1].occurrences === 16);
  check('an id without a date is its own stream', c.groups[3].stream === 'odd-id-without-date' && c.groups[3].first === '');
  check('the grouped form is a fraction of the list', JSON.stringify(c).length < JSON.stringify(events).length / 5,
    `${JSON.stringify(c).length} B vs ${JSON.stringify(events).length} B`);
  const few = compactExcludedEvents(events.slice(-2));
  check('two distinct events are not called compacted', few.compacted === false && few.groups.length === 2 && !few.note);
  check('an empty list is an empty, uncompacted group set', JSON.stringify(compactExcludedEvents([])) === JSON.stringify({ count: 0, groups: [], compacted: false }));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
