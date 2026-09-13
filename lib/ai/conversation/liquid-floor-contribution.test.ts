/**
 * lib/ai/conversation/liquid-floor-contribution.test.ts
 *
 * KEEP THIS MUCH LIQUID; ALLOCATE A SHARE OF WHAT IS ABOVE IT — the arithmetic,
 * proved against a spine that rises, crosses the floor, falls back under it, and
 * recovers.
 *
 * ⚠️ IT IS A STOCK RULE AND THE TESTS HOLD IT APART FROM THE FLOW RULE. Asked
 * "keep $50k and invest everything above it", the live runtime ran a 100%
 * surplus share from the month after the floor was reached: the crossing month's
 * excess stayed in cash for ever and, after a falling month, every recovery was
 * swept so the floor was never rebuilt. §11 below runs that substitute on the
 * same spine and pins the difference, so the primitive cannot quietly collapse
 * back into it.
 *
 * ⚠️ CONSERVATION IS THE TEST THAT MATTERS, as it is for the surplus share: at a
 * 0% return the net worth of an allocated scenario equals the baseline's at every
 * checkpoint, to the cent.
 *
 *   npx tsx lib/ai/conversation/liquid-floor-contribution.test.ts
 */

import {
  expandContributions, runScenarioLedger, growthFactor, monthEndsBetween,
  type ContributionSpec, type LedgerOpening, type SpinePoint, type LedgerResult,
} from './scenario-ledger';
import { findScenarioCrossing } from './scenario-crossing';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const ASOF = '2026-09-13';
const FLOOR = 50_000;
const OPENING: LedgerOpening = {
  asOfISO: ASOF, liquid: 22_000, investments: 10_000, debt: 5_000, otherAssets: 0 };

/**
 * Cash rises $6,000 a month, crosses the floor at 2027-01-31 (52,000), keeps
 * rising, then a −$9,000 month drops it to 49,000; two recovering months stay
 * under the line; June is back over it.
 */
const PATH: [string, number][] = [
  ['2026-09-30', 28_000], ['2026-10-31', 34_000], ['2026-11-30', 40_000],
  ['2026-12-31', 46_000], ['2027-01-31', 52_000], ['2027-02-28', 58_000],
  ['2027-03-31', 49_000], ['2027-04-30', 50_000], ['2027-05-31', 56_000],
  ['2027-06-30', 62_000],
];
const HORIZON = PATH[PATH.length - 1][0];
const spineOf = (path: [string, number][] = PATH): SpinePoint[] =>
  path.map(([date, liquid]) => ({ date, liquid, isCheckpoint: true }));

type Ret = { fromISO: string; toISO: string; annualPct: number };
const run = (specs: ContributionSpec[], opts: { returns?: Ret[];
  outflows?: { date: string; amount: number; label: string }[];
  path?: [string, number][]; opening?: LedgerOpening } = {}): LedgerResult => {
  const path = opts.path ?? PATH;
  const { movements, rejected } = expandContributions(specs, ASOF, path[path.length - 1][0]);
  const r = runScenarioLedger({ opening: opts.opening ?? OPENING, spine: spineOf(path),
    contributions: movements, outflows: opts.outflows ?? [], returns: opts.returns ?? [] });
  return { ...r, rejected: [...rejected, ...r.rejected] };
};
const at = (r: LedgerResult, date: string) => r.checkpoints.find((c) => c.date === date)!;
const contribs = (r: LedgerResult) => r.movements.filter((m) => m.kind === 'CONTRIBUTION');
const contribAt = (r: LedgerResult, date: string) => contribs(r).find((m) => m.date === date);
const FLOOR_ALL: ContributionSpec = { liquidFloor: FLOOR, fractionOfExcess: 1 };

console.log('1. BELOW THE FLOOR — nothing moves (A)');
{
  const r = run([FLOOR_ALL]);
  for (const d of ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']) {
    check(`${d}: rising but under the floor contributes nothing`,
      contribAt(r, d)?.amount === 0 && at(r, d).liquid!.amount === at(run([]), d).liquid!.amount);
  }
  check('…and each of those months is on the record as one the rule sat out',
    contribs(r).filter((m) => m.date <= '2026-12-31').every((m) => (m.availableBefore ?? 0) <= FLOOR));
}

console.log('\n2. THE FIRST MONTH ABOVE THE FLOOR — exactly the excess (B, G)');
{
  const r = run([FLOOR_ALL]);
  const first = contribAt(r, '2027-01-31')!;
  check('the crossing month sweeps the excess and only the excess',
    first.amount === 2_000 && first.availableBefore === 52_000, JSON.stringify(first));
  check('…leaving cash AT the floor, not above it', at(r, '2027-01-31').liquid!.amount === FLOOR);
  check('…and investments up by the same figure',
    at(r, '2027-01-31').investments.amount === OPENING.investments + 2_000);
  check('the next month sweeps that month\'s whole gain; cash stays pinned at the floor',
    contribAt(r, '2027-02-28')!.amount === 6_000 && at(r, '2027-02-28').liquid!.amount === FLOOR);
  check('a positive-surplus path settles at the floor every month it is above it (G)',
    ['2027-01-31', '2027-02-28', '2027-06-30'].every((d) => at(r, d).liquid!.amount === FLOOR));
}

console.log('\n3. THE FLOOR IS NOT A GUARANTEE — a falling month (D), then recovery (E)');
{
  const r = run([FLOOR_ALL]);
  const fall = contribAt(r, '2027-03-31')!;
  check('a falling month contributes zero', fall.amount === 0);
  check('…cash falls under the floor — the spine did that, the rule did not',
    at(r, '2027-03-31').liquid!.amount === 41_000 && fall.availableBefore === 41_000);
  check('…and nothing is sold to put it back',
    at(r, '2027-03-31').investments.amount === at(r, '2027-02-28').investments.amount);
  check('a recovering month still under the line stays paused',
    contribAt(r, '2027-04-30')!.amount === 0 && at(r, '2027-04-30').liquid!.amount === 42_000);
  check('…and so does the next', contribAt(r, '2027-05-31')!.amount === 0
    && at(r, '2027-05-31').liquid!.amount === 48_000);
  check('back over the line, the rule resumes with exactly the CURRENT excess (E)',
    contribAt(r, '2027-06-30')!.amount === 4_000 && at(r, '2027-06-30').liquid!.amount === FLOOR,
    JSON.stringify(contribAt(r, '2027-06-30')));
  check('the months under the floor are countable off the movements',
    contribs(r).filter((m) => (m.availableBefore ?? 0) <= FLOOR).length === 7);
}

console.log('\n4. A SHARE OF THE EXCESS (F)');
{
  const r = run([{ liquidFloor: FLOOR, fractionOfExcess: 0.5 }]);
  check('half the excess moves; cash lands above the floor by the other half',
    contribAt(r, '2027-01-31')!.amount === 1_000 && at(r, '2027-01-31').liquid!.amount === 51_000);
  check('the retained half is eligible again next month — not lost, not swept twice',
    contribAt(r, '2027-02-28')!.availableBefore === 57_000
      && contribAt(r, '2027-02-28')!.amount === 3_500);
  check('on this path the half share has moved less in total than the whole share at every checkpoint',
    r.checkpoints.every((c, i) => c.movements.contributionsToDate.total
      <= run([FLOOR_ALL]).checkpoints[i].movements.contributionsToDate.total));
}

console.log('\n5. CONSERVATION (H) — at 0% the rule only moves money between lines');
{
  const base = run([]);
  for (const spec of [FLOOR_ALL, { liquidFloor: FLOOR, fractionOfExcess: 0.5 },
    { liquidFloor: 10_000, fractionOfExcess: 1 }] as ContributionSpec[]) {
    const r = run([spec]);
    check(`floor ${(spec as { liquidFloor: number }).liquidFloor} / ${(spec as { fractionOfExcess: number }).fractionOfExcess}: net worth equals the baseline at EVERY checkpoint`,
      r.checkpoints.every((c, i) => c.netWorth!.amount === base.checkpoints[i].netWorth!.amount));
    check('…cash is lower by exactly what was contributed, investments higher by the same',
      r.checkpoints.every((c, i) =>
        c.liquid!.amount === base.checkpoints[i].liquid!.amount - c.movements.contributionsToDate.total
        && c.investments.amount === OPENING.investments + c.movements.contributionsToDate.total));
  }
}

console.log('\n6. RETURNS (I, J) — growth on invested principal only; eligibility never reads investments');
{
  const flat = run([FLOOR_ALL]);
  const ret: Ret[] = [{ fromISO: ASOF, toISO: HORIZON, annualPct: 12 }];
  const grown = run([FLOOR_ALL], { returns: ret });
  check('with a return the allocated path beats the flat one at every checkpoint after the first contribution',
    grown.checkpoints.every((c, i) => c.netWorth!.amount >= flat.checkpoints[i].netWorth!.amount));
  check('the existing pot grows at the rate regardless of the rule',
    at(grown, '2026-11-30').investments.amount
      === Math.round(OPENING.investments * growthFactor(ret, ASOF, '2026-11-30') * 100) / 100);
  check('a contribution earns from its own date onward — nothing on the day it is made',
    at(grown, '2027-01-31').investments.amount
      === Math.round((OPENING.investments * growthFactor(ret, ASOF, '2027-01-31') + 2_000) * 100) / 100);
  check('the liquid path is identical with or without a return',
    grown.checkpoints.every((c, i) => c.liquid!.amount === flat.checkpoints[i].liquid!.amount));
  const neg = run([FLOOR_ALL], { returns: [{ fromISO: ASOF, toISO: HORIZON, annualPct: -20 }] });
  check('a negative return lowers investments and touches neither cash nor the contributions (J)',
    neg.checkpoints.every((c, i) => c.liquid!.amount === flat.checkpoints[i].liquid!.amount
      && c.investments.amount <= flat.checkpoints[i].investments.amount
      && c.movements.contributionsToDate.total === flat.checkpoints[i].movements.contributionsToDate.total));
}

console.log('\n7. ONE-OFF MOVEMENTS (K, L) — outflows settle first');
{
  const bonus = run([FLOOR_ALL], { outflows: [{ date: '2026-12-31', amount: -15_000, label: 'bonus' }] });
  check('a bonus that lifts cash over the floor is swept the same month (K)',
    contribAt(bonus, '2026-12-31')!.amount === 11_000 && at(bonus, '2026-12-31').liquid!.amount === FLOOR,
    JSON.stringify(contribAt(bonus, '2026-12-31')));
  check('…and net worth still equals baseline + bonus at 0%',
    at(bonus, '2026-12-31').netWorth!.amount === at(run([]), '2026-12-31').netWorth!.amount + 15_000);
  const car = run([FLOOR_ALL], { outflows: [{ date: '2027-02-28', amount: 20_000, label: 'car' }] });
  check('an outflow that drops cash under the floor: no contribution that month (L)',
    contribAt(car, '2027-02-28')!.amount === 0 && contribAt(car, '2027-02-28')!.availableBefore === 36_000);
  check('…no investments sold', at(car, '2027-02-28').investments.amount === at(car, '2027-01-31').investments.amount);
  check('…the outflow was read BEFORE the floor rule on the same date',
    car.movements.findIndex((m) => m.kind === 'OUTFLOW') < car.movements.findIndex((m) => m.date === '2027-02-28' && m.kind === 'CONTRIBUTION'));
  check('…conservation with the outflow: baseline − 20,000 at every later checkpoint',
    car.checkpoints.filter((c) => c.date >= '2027-02-28').every((c) =>
      c.netWorth!.amount === at(run([]), c.date).netWorth!.amount - 20_000));
}

console.log('\n8. FLOOR ALREADY EXCEEDED TODAY (C)');
{
  const r = run([{ liquidFloor: 10_000, fractionOfExcess: 1 }]);
  check('the first month-end sweeps everything above the floor, opening excess included',
    contribAt(r, '2026-09-30')!.amount === 18_000 && at(r, '2026-09-30').liquid!.amount === 10_000);
  check('…and every month after moves exactly that month\'s gain',
    contribAt(r, '2026-10-31')!.amount === 6_000);
  check('a zero floor is a legal rule: invest every dollar held',
    at(run([{ liquidFloor: 0, fractionOfExcess: 1 }]), '2026-09-30').liquid!.amount === 0);
}

console.log('\n9. WHAT A RULE MAY SAY');
{
  const bad = (spec: unknown) => expandContributions([spec as ContributionSpec], ASOF, HORIZON);
  for (const [name, spec] of [
    ['a negative floor', { liquidFloor: -1, fractionOfExcess: 1 }],
    ['a floor that is not a number', { liquidFloor: Number.NaN, fractionOfExcess: 1 }],
    ['a zero share', { liquidFloor: FLOOR, fractionOfExcess: 0 }],
    ['a negative share', { liquidFloor: FLOOR, fractionOfExcess: -0.5 }],
    ['a share above one', { liquidFloor: FLOOR, fractionOfExcess: 1.5 }],
    ['a share that is not a number', { liquidFloor: FLOOR, fractionOfExcess: '1' as unknown as number }],
    ['a floor without a share', { liquidFloor: FLOOR }],
    ['a share without a floor', { fractionOfExcess: 1 }],
  ] as [string, unknown][]) {
    const r = bad(spec);
    check(`${name} is refused, not clamped or defaulted`,
      r.movements.length === 0 && r.rejected.length === 1, r.rejected[0]?.reason?.slice(0, 70));
  }
  // ⚠️ EXACTLY ONE BASIS, and the floor pair is one basis.
  for (const [name, spec] of [
    ['a floor AND an amount', { liquidFloor: FLOOR, fractionOfExcess: 1, amount: 5_000 }],
    ['a floor AND a balance share', { liquidFloor: FLOOR, fractionOfExcess: 1, fractionOfLiquid: 0.5 }],
    ['a floor AND a surplus share', { liquidFloor: FLOOR, fractionOfExcess: 1, surplusFraction: 0.75 }],
    ['half a floor AND a surplus share', { liquidFloor: FLOOR, surplusFraction: 0.75 }],
  ] as [string, unknown][]) {
    const r = bad(spec);
    check(`${name} is refused rather than silently prioritised`,
      r.movements.length === 0 && /EXACTLY ONE/.test(r.rejected[0]?.reason ?? ''));
  }
  check('a window that ends before it starts is refused',
    bad({ liquidFloor: FLOOR, fractionOfExcess: 1, from: '2027-06-30', to: '2026-10-31' }).rejected.length === 1);
  check('a window entirely after the horizon is refused',
    bad({ liquidFloor: FLOOR, fractionOfExcess: 1, from: '2030-01-01' }).rejected.length === 1);
  check('a well-formed rule is accepted with no rejection',
    bad(FLOOR_ALL).rejected.length === 0 && bad(FLOOR_ALL).movements.length === PATH.length);
}

console.log('\n10. THE WINDOW');
{
  const late = run([{ liquidFloor: FLOOR, fractionOfExcess: 1, from: '2027-03-01', to: '2027-05-31' }]);
  check('nothing moves before the window even though cash was over the floor',
    contribs(late).every((m) => m.date >= '2027-03-31') && at(late, '2027-02-28').liquid!.amount === 58_000);
  check('inside the window the rule reads the balance as it then stands',
    contribAt(late, '2027-03-31')!.amount === 0 && contribAt(late, '2027-05-31')!.amount === 6_000);
  check('…and stops at `to`', contribs(late).slice(-1)[0].date === '2027-05-31');
  check('an unwindowed rule runs from the first month-end to the horizon',
    (() => { const c = contribs(run([FLOOR_ALL])); return c[0].date === '2026-09-30' && c.slice(-1)[0].date === HORIZON; })());
  check('the month-end grid is the shared one',
    contribs(run([FLOOR_ALL])).map((m) => m.date).join(',') === monthEndsBetween(ASOF, HORIZON).join(','));
}

console.log('\n11. IT IS NOT THE SURPLUS SHARE — the substitute the live runtime chose');
{
  const floor = run([FLOOR_ALL]);
  // "Reach $50k, then invest 100% of surplus from the following month" — what the
  // model ran when it had no floor to state. Same spine, same engine.
  const substitute = run([{ surplusFraction: 1, from: '2027-02-01' }]);
  check('the substitute leaves the crossing month\'s excess in cash for ever',
    at(substitute, '2027-01-31').liquid!.amount === 52_000 && at(substitute, '2027-02-28').liquid!.amount === 52_000
    && at(floor, '2027-02-28').liquid!.amount === FLOOR);
  check('after the fall the substitute sweeps every recovery and never rebuilds the floor',
    at(substitute, '2027-06-30').liquid!.amount === 43_000 && at(floor, '2027-06-30').liquid!.amount === FLOOR,
    `${at(substitute, '2027-06-30').liquid!.amount} vs ${at(floor, '2027-06-30').liquid!.amount}`);
  check('both conserve net worth at 0% — they differ in composition only',
    floor.checkpoints.every((c, i) => c.netWorth!.amount === substitute.checkpoints[i].netWorth!.amount));
  check('a floor rule and a surplus rule on the same date settle in insertion order, second reads what the first left',
    (() => {
      const r = run([FLOOR_ALL, { surplusFraction: 1, from: '2027-01-01' }]);
      const jan = r.movements.filter((m) => m.date === '2027-01-31' && m.kind === 'CONTRIBUTION');
      const feb = r.movements.filter((m) => m.date === '2027-02-28' && m.kind === 'CONTRIBUTION');
      // January: floor first (52,000 → 2,000), then the surplus share takes the month's
      // 6,000 from the SPINE, not the balance, so cash ends 6,000 under the floor —
      // reported, not clamped. February: the floor rule reads what both left (50,000)
      // and moves nothing; the surplus share moves its 6,000 again.
      return jan[0].liquidFloor === FLOOR && jan[0].amount === 2_000
        && jan[1].surplusFraction === 1 && jan[1].amount === 6_000
        && at(r, '2027-01-31').liquid!.amount === 44_000
        && feb[0].liquidFloor === FLOOR && feb[0].availableBefore === 50_000 && feb[0].amount === 0
        && at(r, '2027-02-28').liquid!.amount === 44_000;
    })());
}

console.log('\n12. PROJECTION AND CROSSING AGREE (M)');
{
  const ret: Ret[] = [{ fromISO: ASOF, toISO: HORIZON, annualPct: 7 }];
  const projection = run([FLOOR_ALL], { returns: ret });
  const found = findScenarioCrossing({ checkpoints: projection.checkpoints, opening: projection.opening,
    metric: 'netWorth', direction: 'at_or_above', threshold: 60_000 });
  check('the crossing walks the same ledger and lands on a real checkpoint',
    found.crossing !== null && at(projection, found.crossing!.checkpoint.date).netWorth!.amount === found.crossing!.value);
  check('…whose composition is the projection\'s own at that date',
    found.crossing!.checkpoint.liquid!.amount === at(projection, found.crossing!.checkpoint.date).liquid!.amount);
  const liquidCross = findScenarioCrossing({ checkpoints: run([]).checkpoints, opening: OPENING as never,
    metric: 'liquid', direction: 'at_or_above', threshold: FLOOR });
  check('the baseline liquid crossing IS the floor rule\'s first contributing month',
    liquidCross.crossing?.checkpoint.date === contribs(projection).find((m) => m.amount > 0)!.date);
}

console.log('\n13. A LONG HORIZON (N)');
{
  const long: [string, number][] = monthEndsBetween(ASOF, '2056-09-13').map((d, i) => [d, 22_000 + (i + 1) * 6_000]);
  const t0 = Date.now();
  const r = run([FLOOR_ALL], { path: long, returns: [{ fromISO: ASOF, toISO: '2056-09-13', annualPct: 7 }] });
  const ms = Date.now() - t0;
  check('361 month-ends settle and compose well under a second', ms < 1000 && r.checkpoints.length === long.length, `${ms} ms`);
  check('cash is pinned at the floor from the crossing month to the end',
    r.checkpoints.filter((c) => c.date >= '2027-01-31').every((c) => c.liquid!.amount === FLOOR));
  check('no rejection, no warning on a plan that funds itself', r.rejected.length === 0 && r.warnings.length === 0);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
