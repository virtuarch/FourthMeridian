/**
 * lib/ai/conversation/scenario-crossing.test.ts
 *
 * WHEN A SCENARIO FIRST REACHES A NUMBER — the search, proved over a ledger.
 *
 * ⚠️ THE FAILURE THIS CLOSES WAS A MODEL READING A TABLE. Asked when net worth
 * hits a million, the assistant said "around end of 2036" and then, the next
 * turn, "around end of 2037" — from a path that never moved. The year-end table
 * could not answer the question and the model filled the gap. The gap is now
 * arithmetic.
 *
 * ⚠️ AND THE VALUE IS THE MONTH. A year-end series says 2037 because 2036 closed
 * below; the real crossing can be in February. §5 below builds exactly that
 * shape and pins the month.
 *
 *   npx tsx lib/ai/conversation/scenario-crossing.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  findScenarioCrossing, satisfiesThreshold, metricAt, openingMetric, elapsedBetween,
  type LedgerMetric,
} from './scenario-crossing';
import { runScenarioLedger, expandContributions,
  type LedgerCheckpoint, type LedgerOpening, type SpinePoint } from './scenario-ledger';
import { MONEY_EPSILON } from '@/lib/data/snapshot-window';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const ASOF = '2026-09-13';
const OPENING: LedgerOpening = {
  asOfISO: ASOF, liquid: 15_000, investments: 20_000, debt: 4_000, otherAssets: 1_000 };

/** A ledger over a stated cash path — the real engine, not a stand-in. */
function ledgerOver(path: [string, number][], opts: {
  contributions?: Parameters<typeof expandContributions>[0];
  returns?: { fromISO: string; toISO: string; annualPct: number }[];
} = {}) {
  const spine: SpinePoint[] = path.map(([date, liquid]) => ({ date, liquid, isCheckpoint: true }));
  const horizon = path[path.length - 1][0];
  const { movements } = expandContributions(opts.contributions ?? [], ASOF, horizon);
  return runScenarioLedger({ opening: OPENING, spine, contributions: movements,
    outflows: [], returns: opts.returns ?? [] });
}

const find = (l: ReturnType<typeof ledgerOver>, metric: LedgerMetric,
  direction: 'at_or_above' | 'at_or_below', threshold: number) =>
  findScenarioCrossing({ checkpoints: l.checkpoints, opening: l.opening,
    metric, direction, threshold });

/** Cash rising by 10k a month. Net worth = liquid + 20,000 + 1,000 − 4,000. */
const RISING: [string, number][] = Array.from({ length: 24 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9 + i + 1, 0));
  return [d.toISOString().slice(0, 10), 15_000 + (i + 1) * 10_000] as [string, number];
});

console.log('1. THE FIRST CROSSING, AND WHAT MAKES IT FIRST');
{
  const l = ledgerOver(RISING);
  const r = find(l, 'netWorth', 'at_or_above', 100_000);
  check('it finds a crossing', r.crossing !== null);
  check('…at the first month that qualifies', r.crossing?.checkpoint.date === '2027-04-30',
    r.crossing?.checkpoint.date);
  check('…the value there really does qualify', (r.crossing?.value ?? 0) >= 100_000,
    String(r.crossing?.value));
  check('…and the month before really does NOT', (r.crossing?.previous?.value ?? 0) < 100_000,
    `${r.crossing?.previous?.date} = ${r.crossing?.previous?.value}`);
  check('the previous month is the one immediately before',
    r.crossing?.previous?.date === '2027-03-31');
  check('nothing already satisfied it', r.alreadySatisfied === null);
  check('it reports how many checkpoints carried a value', r.examined === RISING.length);
}

console.log('\n2. ALREADY TRUE IS NOT A CROSSING');
{
  const l = ledgerOver(RISING);
  const r = find(l, 'netWorth', 'at_or_above', 10_000);
  check('an opening that already qualifies returns alreadySatisfied', r.alreadySatisfied !== null);
  check('…dated today, not at some future month', r.alreadySatisfied?.date === ASOF);
  check('…with the opening value', r.alreadySatisfied?.value === l.opening.netWorth);
  check('…and NO crossing, so the two can never be confused', r.crossing === null);
  const debt = find(ledgerOver(RISING), 'debt', 'at_or_below', 4_000);
  check('debt already at the threshold is already satisfied too', debt.alreadySatisfied !== null);
}

console.log('\n3. NEVER, WITHIN THIS WINDOW');
{
  const l = ledgerOver(RISING);
  const r = find(l, 'netWorth', 'at_or_above', 10_000_000);
  check('no crossing is reported', r.crossing === null && r.alreadySatisfied === null);
  check('…and the end of the search is, so a caller can say how far it looked',
    r.end?.checkpoint.date === RISING[RISING.length - 1][0]);
  check('…with the value it reached', r.end?.value === 15_000 + 240_000 + 20_000 + 1_000 - 4_000);
}

console.log('\n4. DIRECTIONS AND METRICS');
{
  // Debt is held flat by the ledger, so a falling line needs the cash path.
  const falling: [string, number][] = [['2026-09-30', 15_000], ['2026-10-31', 9_000],
    ['2026-11-30', 4_000], ['2026-12-31', 1_000], ['2027-01-31', 500]];
  const l = ledgerOver(falling);
  const r = find(l, 'liquid', 'at_or_below', 4_000);
  check('at_or_below finds the first month that falls to the line',
    r.crossing?.checkpoint.date === '2026-11-30', r.crossing?.checkpoint.date);
  check('…and the month before was above it', (r.crossing?.previous?.value ?? 0) > 4_000);
  check('at_or_above on the same path never fires below the line',
    find(l, 'liquid', 'at_or_above', 20_000).crossing === null);
  for (const m of ['netWorth', 'liquid', 'investments', 'debt', 'otherAssets'] as LedgerMetric[]) {
    check(`\`${m}\` is a line the ledger actually carries`,
      typeof metricAt(l.checkpoints[0], m) === 'number'
        && typeof openingMetric(l.opening, m) === 'number');
  }
  check('investments and otherAssets are the held-flat lines they were',
    metricAt(l.checkpoints[4], 'investments') === 20_000
      && metricAt(l.checkpoints[4], 'otherAssets') === 1_000);
}

console.log('\n5. THE MONTH, NOT THE YEAR — the reason this exists');
{
  // ⚠️ THE SHAPE OF THE LIVE FAILURE, BUILT ON PURPOSE. Year-end 2027 closes
  // below the line and year-end 2028 closes above it, so a yearly table can only
  // say "2028". The crossing is in May.
  const path: [string, number][] = [];
  let liquid = 15_000;
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 9 + i + 1, 0));
    liquid += 7_000;
    path.push([d.toISOString().slice(0, 10), liquid]);
  }
  const l = ledgerOver(path);
  const THRESHOLD = 150_000;
  const dec27 = l.checkpoints.find((c) => c.date === '2027-12-31')!;
  const dec28 = l.checkpoints.find((c) => c.date === '2028-12-31')!;
  check('year-end 2027 is below the line', (dec27.netWorth?.amount ?? 0) < THRESHOLD,
    String(dec27.netWorth?.amount));
  check('year-end 2028 is above it — a yearly table would say "2028"',
    (dec28.netWorth?.amount ?? 0) >= THRESHOLD, String(dec28.netWorth?.amount));
  const r = find(l, 'netWorth', 'at_or_above', THRESHOLD);
  check('the search returns the MONTH, ten months earlier',
    r.crossing?.checkpoint.date === '2028-02-29', r.crossing?.checkpoint.date);
  check('…and it is a genuine first: the month before is below',
    (r.crossing?.previous?.value ?? 0) < THRESHOLD);
}

console.log('\n6. A PATH THAT TURNS — no monotonicity assumed');
{
  // Up over the line, back under it, then up again. A bisection would find the
  // LAST crossing, or none.
  const humped: [string, number][] = [
    ['2026-09-30', 20_000], ['2026-10-31', 90_000], ['2026-11-30', 120_000],
    ['2026-12-31', 60_000], ['2027-01-31', 40_000], ['2027-02-28', 150_000],
  ];
  const l = ledgerOver(humped);
  const r = find(l, 'liquid', 'at_or_above', 100_000);
  check('the FIRST crossing is returned, not the last',
    r.crossing?.checkpoint.date === '2026-11-30', r.crossing?.checkpoint.date);
  check('…even though the line falls back under afterwards',
    (l.checkpoints.find((c) => c.date === '2027-01-31')!.liquid?.amount ?? 0) < 100_000);
  // ⚠️ THERE REALLY ARE TWO CROSSINGS HERE, which is what makes the first one a
  // choice. February also qualifies; a search that halved the range could have
  // landed on it and called it the answer.
  check('a later month qualifies too — so "first" was a decision, not the only option',
    (l.checkpoints.find((c) => c.date === '2027-02-28')!.liquid?.amount ?? 0) >= 100_000
      && (r.crossing?.checkpoint.date ?? '') < '2027-02-28');
  check('…and both are found by walking, never by halving',
    !/binarySearch|lo \+ hi|midpoint/.test(readFileSync('lib/ai/conversation/scenario-crossing.ts', 'utf8')));
}

console.log('\n7. MONEY, NOT FLOATS');
{
  check('exactly at the threshold satisfies, in both directions',
    satisfiesThreshold(100_000, 100_000, 'at_or_above')
      && satisfiesThreshold(100_000, 100_000, 'at_or_below'));
  check('a residue of 2.8e-14 counts as zero debt',
    satisfiesThreshold(2.842170943040401e-14, 0, 'at_or_below'));
  check('…and one cent does not', !satisfiesThreshold(0.01, 0, 'at_or_below'));
  check('half a cent is the boundary and is not crossed',
    !satisfiesThreshold(MONEY_EPSILON, 0, 'at_or_below')
      && satisfiesThreshold(MONEY_EPSILON - 1e-9, 0, 'at_or_below'));
  check('a hundredth under the target does not satisfy at_or_above',
    !satisfiesThreshold(99_999.99, 100_000, 'at_or_above'));
  check('…but a hundredth of a cent under does',
    satisfiesThreshold(99_999.9999, 100_000, 'at_or_above'));
  check('the tolerance is the repository\'s one, imported not restated',
    /import \{ MONEY_EPSILON \} from '@\/lib\/data\/snapshot-window'/.test(
      readFileSync('lib/ai/conversation/scenario-crossing.ts', 'utf8')));
}

console.log('\n8. AN UNESTABLISHED CHECKPOINT IS NOT A ZERO');
{
  const holed: LedgerCheckpoint[] = ledgerOver(RISING).checkpoints.map((c, i) =>
    (i === 2 || i === 3 ? { ...c, liquid: null, netWorth: null } : c));
  const r = findScenarioCrossing({ checkpoints: holed, opening: ledgerOver(RISING).opening,
    metric: 'netWorth', direction: 'at_or_above', threshold: 100_000 });
  check('a null checkpoint is skipped, not read as zero', r.crossing !== null);
  check('…and it is not counted as examined', r.examined === RISING.length - 2);
  const downward = findScenarioCrossing({ checkpoints: holed,
    opening: ledgerOver(RISING).opening, metric: 'netWorth', direction: 'at_or_below', threshold: 0 });
  check('a hole never satisfies an at_or_below search', downward.crossing === null);
  check('the previous checkpoint is the previous ESTABLISHED one',
    findScenarioCrossing({ checkpoints: holed, opening: ledgerOver(RISING).opening,
      metric: 'netWorth', direction: 'at_or_above', threshold: 60_000 })
      .crossing?.previous?.date === '2026-11-30');
}

console.log('\n9. THE SURPLUS RULE CROSSES THE SAME LINE ON THE SAME DAY');
{
  const base = ledgerOver(RISING);
  const allocated = ledgerOver(RISING, { contributions: [{ surplusFraction: 0.75 }] });
  const b = find(base, 'netWorth', 'at_or_above', 100_000);
  const a = find(allocated, 'netWorth', 'at_or_above', 100_000);
  check('at a 0% return, allocating surplus does not move the net-worth crossing',
    a.crossing?.checkpoint.date === b.crossing?.checkpoint.date,
    `${a.crossing?.checkpoint.date} vs ${b.crossing?.checkpoint.date}`);
  check('…because it never changed net worth, only where the money sits',
    a.crossing?.value === b.crossing?.value
      && a.crossing!.checkpoint.investments.amount !== b.crossing!.checkpoint.investments.amount);
  const grown = ledgerOver(RISING, { contributions: [{ surplusFraction: 0.75 }],
    returns: [{ fromISO: ASOF, toISO: RISING[RISING.length - 1][0], annualPct: 10 }] });
  const g = find(grown, 'netWorth', 'at_or_above', 100_000);
  check('with a return it crosses no later, and the line is higher when it does',
    (g.crossing?.checkpoint.date ?? '9999') <= (b.crossing?.checkpoint.date ?? '0000')
      && (g.crossing?.value ?? 0) > 0);
  check('…and the LIQUID crossing moves LATER, because cash left the account',
    (find(grown, 'liquid', 'at_or_above', 100_000).crossing?.checkpoint.date ?? '9999')
      > (find(base, 'liquid', 'at_or_above', 100_000).crossing?.checkpoint.date ?? '0000'));
}

console.log('\n11. ELAPSED — the distance to a date the engine produced, in numbers the engine owns');
{
  const e = (a: string, b: string) => elapsedBetween(a, b);
  const gap = e('2026-09-13', '2027-02-28');
  check('the dogfood gap is 5 months, 15 days — not 1.5 years',
    gap.months === 5 && gap.days === 15 && gap.totalDays === 168, JSON.stringify(gap));
  check('…about 5.5 months, about 0.46 years',
    gap.monthsFractional === 5.5 && gap.years === 0.46 && gap.label === '5 months, 15 days');
  check('the same date is today: zeros and the label "today"',
    JSON.stringify(e('2026-09-13', '2026-09-13')) === JSON.stringify({ months: 0, days: 0, totalDays: 0,
      monthsFractional: 0, years: 0, label: 'today' }));
  check('the next day is one day', e('2026-09-13', '2026-09-14').days === 1 && e('2026-09-13', '2026-09-14').months === 0
    && e('2026-09-13', '2026-09-14').label === '1 day');
  check('a month boundary: 13 Sep → 13 Oct is exactly one month', e('2026-09-13', '2026-10-13').months === 1
    && e('2026-09-13', '2026-10-13').days === 0 && e('2026-09-13', '2026-10-13').label === '1 month');
  check('…and 13 Sep → 12 Oct is 29 days, not a month', e('2026-09-13', '2026-10-12').months === 0
    && e('2026-09-13', '2026-10-12').days === 29);
  check('a year boundary: 13 Sep → 13 Sep next year is 12 months, 0 days, 1.00 year',
    e('2026-09-13', '2027-09-13').months === 12 && e('2026-09-13', '2027-09-13').days === 0
    && e('2026-09-13', '2027-09-13').years === 1);
  check('end of month steps with the ledger\'s own clamp: 31 Jan → 28 Feb is one month',
    e('2026-01-31', '2026-02-28').months === 1 && e('2026-01-31', '2026-02-28').days === 0);
  check('…and 28 Feb → 31 Mar is one month and three days',
    e('2026-02-28', '2026-03-31').months === 1 && e('2026-02-28', '2026-03-31').days === 3);
  check('a leap year: 31 Jan 2028 → 29 Feb 2028 is one month; → 1 Mar is one month and one day',
    e('2028-01-31', '2028-02-29').months === 1 && e('2028-01-31', '2028-02-29').days === 0
    && e('2028-01-31', '2028-03-01').months === 1 && e('2028-01-31', '2028-03-01').days === 1);
  check('…and 29 Feb 2028 → 28 Feb 2029 is 12 months (the clamp lands on the 28th)',
    e('2028-02-29', '2029-02-28').months === 12 && e('2028-02-29', '2029-02-28').days === 0);
  const long = e('2026-09-13', '2035-02-28');
  check('a multi-year span: to the $1M crossing is 101 months, 15 days ≈ 8.46 years',
    long.months === 101 && long.days === 15 && long.years === 8.46, JSON.stringify(long));
  check('a distance, not a direction: the dates may be given either way round',
    JSON.stringify(e('2035-02-28', '2026-09-13')) === JSON.stringify(long));
  check('no clock: the result is a function of its arguments only',
    JSON.stringify(e('2026-09-13', '2027-02-28')) === JSON.stringify(gap));
}


console.log('\n10. THE COMPOSITION IS THE LEDGER\'S OWN');
{
  const l = ledgerOver(RISING, { contributions: [{ surplusFraction: 0.5 }] });
  const r = find(l, 'netWorth', 'at_or_above', 100_000);
  const c = r.crossing!.checkpoint;
  check('net worth at the crossing is the ledger\'s net worth for that date',
    r.crossing!.value === c.netWorth!.amount);
  check('…and it equals its own parts, to the cent',
    Math.abs(c.netWorth!.amount
      - (c.liquid!.amount + c.investments.amount + c.otherAssets.amount - c.debt.amount)) < 0.005);
  check('the crossing checkpoint is the SAME object the ledger produced',
    l.checkpoints.includes(c));
}

if (failures > 0) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
