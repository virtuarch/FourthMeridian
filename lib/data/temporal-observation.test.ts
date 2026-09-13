/**
 * lib/data/temporal-observation.test.ts
 *
 * FIRST, LAST, HIGHEST, LOWEST — owned by code, proved here.
 *
 * ⚠️ THE FAILURE THIS PINS IS A REAL ONE. Asked when debt first hit zero, the
 * assistant answered 2026-04-24 — a day whose debt, in the same payload it was
 * reading, was $5,353.81. The true first observed zero was 2026-07-22. The
 * series held both. Scanning an ordered series for a predicate is arithmetic,
 * and the arithmetic now lives here.
 *
 *   npx tsx lib/data/temporal-observation.test.ts
 */

import {
  findObservation, sameMoney, MONEY_EPSILON, NEEDS_THRESHOLD,
  type SeriesPoint, type TemporalOperation,
} from './snapshot-window';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const pt = (date: string, value: number): SeriesPoint =>
  ({ date: new Date(`${date}T00:00:00.000Z`), value });
const at = (m: { match: SeriesPoint } | null) => m && m.match.date.toISOString().slice(0, 10);
const prev = (m: { previous: SeriesPoint | null } | null) =>
  m?.previous ? m.previous.date.toISOString().slice(0, 10) : null;

/**
 * The real July shape from this Space's debt series, to the cent — including
 * the day the model got wrong and the float residue four days after payoff.
 */
const DEBT = [
  pt('2026-04-24', 5353.81),
  pt('2026-07-16', 3555.050000000001),
  pt('2026-07-17', 17.12000000000003),
  pt('2026-07-19', 17.12),
  pt('2026-07-21', 89.46),
  pt('2026-07-22', 0),
  pt('2026-07-23', 175.4600000000002),
  pt('2026-07-28', 2.842170943040401e-14),
  pt('2026-08-14', 0),
];

console.log('1. THE QUESTION THAT WAS ANSWERED WRONG');
{
  const first = findObservation(DEBT, 'first_below', 0);
  check('first observed zero debt is 2026-07-22', at(first) === '2026-07-22', String(at(first)));
  check('…and never 2026-04-24, whose debt was $5,353.81', at(first) !== '2026-04-24');
  check('the value returned IS zero, so the date and the amount cannot disagree',
    first?.match.value === 0);
  check('it says what it crossed from', prev(first) === '2026-07-21' && first?.previous?.value === 89.46);
  check('last observed zero is the latest one, not the first', at(findObservation(DEBT, 'last_below', 0)) === '2026-08-14');
}

console.log('\n2. THRESHOLDS');
{
  check('first below $1,000 is the 17th, not the day the run ended',
    at(findObservation(DEBT, 'first_below', 1000)) === '2026-07-17');
  check('…and its previous observation is the $3,555 day',
    prev(findObservation(DEBT, 'first_below', 1000)) === '2026-07-16');
  check('first at or above $5,000 is the April day',
    at(findObservation(DEBT, 'first_above', 5000)) === '2026-04-24');
  check('last at or above $100 is the $175 day',
    at(findObservation(DEBT, 'last_above', 100)) === '2026-07-23');
  check('a threshold nothing meets returns no match, not a nearest guess',
    findObservation(DEBT, 'first_above', 1e9) === null);
  check('a crossing operation with no threshold refuses',
    findObservation(DEBT, 'first_below') === null
      && findObservation(DEBT, 'first_below', Number.NaN) === null);
  check('…and the contract says which operations need one',
    NEEDS_THRESHOLD.first_below && NEEDS_THRESHOLD.last_above
      && !NEEDS_THRESHOLD.minimum && !NEEDS_THRESHOLD.maximum);
}

console.log('\n3. EXTREMES, AND WHICH DAY OWNS A TIE');
{
  check('maximum is the April day', at(findObservation(DEBT, 'maximum')) === '2026-04-24');
  check('minimum is the FIRST day at the low, not the last',
    at(findObservation(DEBT, 'minimum')) === '2026-07-22', String(at(findObservation(DEBT, 'minimum'))));
  const flat = [pt('2026-05-19', 3984.37), pt('2026-05-20', 3968.05), pt('2026-05-21', 3968.05)];
  check('a balance that sits at its low for two days reports the earlier one',
    at(findObservation(flat, 'minimum')) === '2026-05-20');
  check('a single observation is its own extreme', at(findObservation([pt('2026-01-01', 5)], 'maximum')) === '2026-01-01');
  check('…and has no previous observation', findObservation([pt('2026-01-01', 5)], 'maximum')?.previous === null);
  check('an empty series answers nothing rather than zero', findObservation([], 'minimum') === null);
}

console.log('\n4. MONEY, NOT FLOATS');
{
  // ⚠️ THE LIVE SERIES REALLY HOLDS THIS. 2.842170943040401e-14 is a debt of
  // nothing; `value <= 0` calls it a debt.
  const residue = [pt('2026-07-28', 2.842170943040401e-14)];
  check('a residue of 2.8e-14 is at or below zero', at(findObservation(residue, 'first_below', 0)) === '2026-07-28');
  check('…and one cent is NOT', findObservation([pt('2026-07-28', 0.01)], 'first_below', 0) === null);
  check('half a cent is the boundary, and it is not crossed',
    findObservation([pt('x', MONEY_EPSILON)], 'first_below', 0) === null
      && findObservation([pt('x', MONEY_EPSILON - 1e-9)], 'first_below', 0) !== null);
  check('the same rule decides a tie', sameMoney(32575.96000000001, 32575.96) && !sameMoney(10, 10.01));
  check('a threshold above works the same way',
    findObservation([pt('x', 999.999)], 'first_above', 1000) !== null
      && findObservation([pt('x', 999.99)], 'first_above', 1000) === null);
  check('nothing is rounded on the way out — the stored value is returned',
    findObservation(DEBT, 'first_below', 1000)?.match.value === 17.12000000000003);
}

console.log('\n5. AN UNESTABLISHED VALUE IS NOT A LOW');
{
  const withHole = [pt('2026-01-01', 100), { date: new Date('2026-02-01T00:00:00.000Z'), value: Number.NaN },
    pt('2026-03-01', 50)];
  check('a non-finite observation is skipped, not read as zero',
    at(findObservation(withHole, 'minimum')) === '2026-03-01');
  check('…and it does not become somebody\'s previous observation',
    prev(findObservation(withHole, 'minimum')) === '2026-01-01');
  check('a series of nothing but holes answers nothing',
    findObservation([{ date: new Date(), value: Number.NaN }], 'minimum') === null);
}

console.log('\n6. EVERY OPERATION IS ANSWERABLE');
{
  const ops: TemporalOperation[] = ['minimum', 'maximum', 'first_below',
    'first_above', 'last_below', 'last_above'];
  for (const op of ops) {
    const r = findObservation(DEBT, op, 100);
    check(`${op} returns an observation that is in the series`,
      r !== null && DEBT.some((p) => p.date.getTime() === r.match.date.getTime()
        && p.value === r.match.value));
  }
  check('every operation is declared in the threshold contract',
    ops.every((op) => op in NEEDS_THRESHOLD));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
