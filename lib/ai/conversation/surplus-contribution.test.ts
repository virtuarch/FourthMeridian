/**
 * lib/ai/conversation/surplus-contribution.test.ts
 *
 * A SHARE OF WHAT EACH MONTH ADDS — the arithmetic, proved against a spine.
 *
 * ⚠️ CONSERVATION IS THE TEST THAT MATTERS. Redirecting projected cash into
 * investments moves money between two lines; it does not create any. At a 0%
 * return the net worth of an allocated scenario must equal the baseline's at
 * every checkpoint, to the cent. A primitive that fails that is not a
 * reallocation, it is a machine for inventing wealth, and it would do it four
 * years out where nobody can check.
 *
 * ⚠️ AND THE SECOND ONE IS THAT IT IS NOT `fractionOfLiquid`. A share of the
 * BALANCE sweeps money that was already there; a share of the SURPLUS cannot.
 * The two are held apart here by the cash paths they produce, not by their names.
 *
 *   npx tsx lib/ai/conversation/surplus-contribution.test.ts
 */

import {
  expandContributions, settleMovements, runScenarioLedger, monthEndsBetween,
  MAX_EXPANDED_CONTRIBUTIONS,
  type ContributionSpec, type LedgerOpening, type SpinePoint, type LedgerResult,
} from './scenario-ledger';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const ASOF = '2026-09-13';
const OPENING: LedgerOpening = {
  asOfISO: ASOF, liquid: 15_000, investments: 20_000, debt: 0, otherAssets: 0 };

/**
 * A cash path shaped like the live Space's: an ordinary month adds $6,000, a
 * three-payroll month adds $11,000, and one month falls. The first point is the
 * stub between `asOf` and the first month-end.
 */
const MONTHLY_ADDS: [string, number][] = [
  ['2026-09-30', 2_800], ['2026-10-31', 6_000], ['2026-11-30', 6_000],
  ['2026-12-31', 11_000], ['2027-01-31', 6_000], ['2027-02-28', -4_000],
  ['2027-03-31', 0], ['2027-04-30', 6_000], ['2027-05-31', 6_000],
  ['2027-06-30', 6_000], ['2027-07-31', 11_000], ['2027-08-31', 6_000],
  ['2027-09-30', 6_000], ['2027-10-31', 6_000], ['2027-11-30', 6_000],
  ['2027-12-31', 6_000],
];
const HORIZON = '2027-12-31';

function spine(checkpoints: string[] = [HORIZON]): SpinePoint[] {
  let liquid = OPENING.liquid;
  return MONTHLY_ADDS.map(([date, add]) => {
    liquid += add;
    return { date, liquid, isCheckpoint: checkpoints.includes(date) };
  });
}

const run = (specs: ContributionSpec[], opts: { returns?: { fromISO: string; toISO: string;
  annualPct: number }[]; checkpoints?: string[]; outflows?: { date: string; amount: number;
  label: string }[] } = {}): LedgerResult => {
  const { movements, rejected } = expandContributions(specs, ASOF, HORIZON);
  const r = runScenarioLedger({ opening: OPENING, spine: spine(opts.checkpoints),
    contributions: movements, outflows: opts.outflows ?? [], returns: opts.returns ?? [] });
  return { ...r, rejected: [...rejected, ...r.rejected] };
};
const last = (r: LedgerResult) => r.checkpoints[r.checkpoints.length - 1];
const contribs = (r: LedgerResult) => r.movements.filter((m) => m.kind === 'CONTRIBUTION');
const surplusAt = (r: LedgerResult, date: string) =>
  contribs(r).find((m) => m.date === date);

console.log('1. CONSERVATION — the invariant the whole slice rests on');
{
  const base = run([]);
  for (const fraction of [1, 0.75, 0.5, 0.01]) {
    const allocated = run([{ surplusFraction: fraction }]);
    const b = last(base).netWorth!.amount, a = last(allocated).netWorth!.amount;
    check(`${fraction * 100}% of surplus at 0% return leaves net worth untouched`,
      a === b, `${a} vs ${b}`);
    const moved = contribs(allocated).reduce((s, m) => s + m.amount, 0);
    check(`…cash is lower by exactly the contributed principal`,
      last(allocated).liquid!.amount === Math.round((last(base).liquid!.amount - moved) * 100) / 100,
      `moved ${moved}`);
    check('…investments are higher by exactly the same figure',
      last(allocated).investments.amount
        === Math.round((last(base).investments.amount + moved) * 100) / 100);
  }
  // Every checkpoint, not only the last: a difference that cancels at the horizon
  // would still be a wrong table.
  const every = run([{ surplusFraction: 0.75 }], { checkpoints: MONTHLY_ADDS.map(([d]) => d) });
  const baseEvery = run([], { checkpoints: MONTHLY_ADDS.map(([d]) => d) });
  check('net worth matches the baseline at EVERY checkpoint, not just the horizon',
    every.checkpoints.every((c, i) => c.netWorth!.amount === baseEvery.checkpoints[i].netWorth!.amount),
    `${every.checkpoints.length} checkpoints`);
}

console.log('\n2. THE BASE IS THE MONTH, AND IT IS NOT RECURSIVE');
{
  const r = run([{ surplusFraction: 0.75 }]);
  check('an ordinary $6,000 month contributes $4,500',
    surplusAt(r, '2026-10-31')?.amount === 4_500, String(surplusAt(r, '2026-10-31')?.amount));
  check('…and the month it was taken from is on the record',
    surplusAt(r, '2026-10-31')?.projectedSurplus === 6_000);
  check('a three-payroll $11,000 month contributes proportionally more, $8,250',
    surplusAt(r, '2026-12-31')?.amount === 8_250, String(surplusAt(r, '2026-12-31')?.amount));
  check('the NEXT month is unaffected by what the previous one took',
    surplusAt(r, '2027-01-31')?.amount === 4_500 && surplusAt(r, '2027-01-31')?.projectedSurplus === 6_000);
  // ⚠️ THE RECURSION TEST. A share computed off the running balance would shrink
  // every month; off the projection it does not.
  const ordinary = contribs(r).filter((m) => m.projectedSurplus === 6_000);
  check('every ordinary month contributes the same amount — no compounding shrinkage',
    ordinary.length >= 8 && ordinary.every((m) => m.amount === 4_500), `${ordinary.length} months`);
  check('two rules over the same month each take a share of the SAME month',
    (() => {
      const two = run([{ surplusFraction: 0.5, label: 'a' }, { surplusFraction: 0.25, label: 'b' }]);
      const oct = contribs(two).filter((m) => m.date === '2026-10-31');
      return oct.length === 2 && oct[0].amount === 3_000 && oct[1].amount === 1_500;
    })());
}

console.log('\n3. A MONTH THAT ADDS NOTHING CONTRIBUTES NOTHING');
{
  const r = run([{ surplusFraction: 1 }]);
  const neg = surplusAt(r, '2027-02-28');
  check('a falling month contributes zero, not a negative amount', neg?.amount === 0);
  check('…and says what the month actually did', neg?.projectedSurplus === -4_000);
  check('a flat month contributes zero too', surplusAt(r, '2027-03-31')?.amount === 0);
  check('…and no deficit is carried into the next month',
    surplusAt(r, '2027-04-30')?.amount === 6_000);
  check('no investments were sold to fund a falling month',
    contribs(r).every((m) => m.amount >= 0));
  check('the whole run never moves more than the months added',
    contribs(r).reduce((s, m) => s + m.amount, 0)
      === MONTHLY_ADDS.filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0));
}

console.log('\n4. THE OPENING BALANCE IS NEVER SWEPT');
{
  const r = run([{ surplusFraction: 1 }]);
  const firstMonth = surplusAt(r, '2026-09-30');
  check('the first contribution is the stub month only, not the $15,000 already held',
    firstMonth?.amount === 2_800, String(firstMonth?.amount));
  check('…and its base is the projection start, so nothing earlier is in scope',
    firstMonth?.projectedSurplus === 2_800);
  // At 100% every gain goes in, so what is left is the opening balance less the
  // months that FELL — which the rule deliberately does not claw back.
  const fell = MONTHLY_ADDS.filter(([, v]) => v < 0).reduce((s, [, v]) => s + v, 0);
  check('at a 100% share the cash left over is the opening balance, less the falling months',
    last(r).liquid!.amount === OPENING.liquid + fell,
    `${last(r).liquid!.amount} = ${OPENING.liquid} + ${fell}`);
  // ⚠️ THE CONTROL STARTS ON A 31st, because `addMonths` clamps and a schedule
  // begun on the 30th lands on the 30th of every month — dates this spine does
  // not carry. A fair comparison needs both rules on the same month-ends.
  check('…while a 100% share of the BALANCE leaves the account empty instead',
    last(run([{ from: '2026-10-31', cadence: 'monthly', fractionOfLiquid: 1 }])).liquid!.amount
      <= 0.01);
}

console.log('\n5. IT IS NOT `fractionOfLiquid`');
{
  const surplus = run([{ surplusFraction: 0.75 }]);
  const balance = run([{ from: '2026-10-31', cadence: 'monthly', fractionOfLiquid: 0.75 }]);
  check('the two produce materially different cash paths',
    Math.abs(last(surplus).liquid!.amount - last(balance).liquid!.amount) > 10_000,
    `surplus ${last(surplus).liquid!.amount} vs balance ${last(balance).liquid!.amount}`);
  check('a share of the BALANCE moves more than the months ever added',
    contribs(balance).reduce((s, m) => s + m.amount, 0)
      > MONTHLY_ADDS.reduce((s, [, v]) => s + Math.max(v, 0), 0));
  check('a share of the SURPLUS never can',
    contribs(surplus).reduce((s, m) => s + m.amount, 0)
      <= MONTHLY_ADDS.reduce((s, [, v]) => s + Math.max(v, 0), 0));
  check('both still conserve net worth at 0% — they differ in composition only',
    last(surplus).netWorth!.amount === last(balance).netWorth!.amount);
  check('a balance share still reports its own basis, unchanged',
    contribs(balance)[0].fractionOfLiquid === 0.75
      && contribs(balance)[0].surplusFraction === undefined
      && contribs(balance)[0].projectedSurplus === undefined);
}

console.log('\n6. RETURNS GO THROUGH THE ONE ENGINE');
{
  const at8 = [{ fromISO: ASOF, toISO: HORIZON, annualPct: 8 }];
  const base = run([], { returns: at8 });
  const allocated = run([{ surplusFraction: 0.75 }], { returns: at8 });
  check('with a return, allocating beats the baseline',
    last(allocated).netWorth!.amount > last(base).netWorth!.amount,
    `${last(allocated).netWorth!.amount} vs ${last(base).netWorth!.amount}`);
  const moved = contribs(allocated).reduce((s, m) => s + m.amount, 0);
  const growthOnContributions =
    last(allocated).investments.amount - last(base).investments.amount - moved;
  check('…and the entire difference is growth ON the contributed principal',
    Math.abs((last(allocated).netWorth!.amount - last(base).netWorth!.amount)
      - growthOnContributions) < 0.02,
    `${growthOnContributions.toFixed(2)}`);
  check('the existing pot still earns the same rate it did without contributions',
    Math.abs(last(base).investments.amount - OPENING.investments * Math.pow(1.08, 474 / 365)) < 1);
  check('growth is reported apart from principal',
    Math.abs(last(allocated).movements.investmentGrowthToDate - growthOnContributions
      - (last(base).investments.amount - OPENING.investments)) < 0.02);
  check('a higher rate reaches further',
    last(run([{ surplusFraction: 0.75 }],
      { returns: [{ fromISO: ASOF, toISO: HORIZON, annualPct: 10 }] })).netWorth!.amount
      > last(allocated).netWorth!.amount);
}

console.log('\n7. WHAT A RULE MAY SAY');
{
  const bad = (spec: unknown) => expandContributions([spec as ContributionSpec], ASOF, HORIZON);
  for (const [name, spec] of [
    ['zero', { surplusFraction: 0 }],
    ['negative', { surplusFraction: -0.5 }],
    ['above one', { surplusFraction: 1.5 }],
    ['not a number', { surplusFraction: Number.NaN }],
    ['infinite', { surplusFraction: Number.POSITIVE_INFINITY }],
    ['a string', { surplusFraction: '0.75' as unknown as number }],
  ] as [string, unknown][]) {
    const r = bad(spec);
    check(`a ${name} share is refused, not clamped`,
      r.movements.length === 0 && r.rejected.length === 1, r.rejected[0]?.reason?.slice(0, 60));
  }
  // ⚠️ EXACTLY ONE BASIS. Two bases in one rule is two scenarios in one sentence.
  for (const [name, spec] of [
    ['a share AND an amount', { surplusFraction: 0.75, amount: 5_000 }],
    ['a share AND a balance share', { surplusFraction: 0.75, fractionOfLiquid: 0.5 }],
    ['all three', { surplusFraction: 0.75, fractionOfLiquid: 0.5, amount: 100 }],
  ] as [string, unknown][]) {
    const r = bad(spec);
    check(`${name} is refused rather than silently prioritised`,
      r.movements.length === 0 && /EXACTLY ONE/.test(r.rejected[0]?.reason ?? ''));
  }
  check('a window that ends before it starts is refused',
    bad({ surplusFraction: 1, from: '2027-06-30', to: '2026-10-31' }).rejected.length === 1);
  check('a window entirely after the horizon is refused',
    bad({ surplusFraction: 1, from: '2030-01-01' }).rejected.length === 1);
}

console.log('\n8. THE WINDOW');
{
  const partial = run([{ surplusFraction: 1, from: '2027-04-01', to: '2027-07-31' }]);
  check('it starts at the first month-end inside the window',
    contribs(partial)[0].date === '2027-04-30', contribs(partial)[0].date);
  check('…and stops at the last', contribs(partial).slice(-1)[0].date === '2027-07-31');
  check('…taking that month\'s own surplus, not the stretch since the projection began',
    contribs(partial)[0].projectedSurplus === 6_000 && contribs(partial)[0].amount === 6_000);
  check('nothing before the window contributes',
    contribs(partial).every((m) => m.date >= '2027-04-30'));
  check('an unwindowed rule runs from the first month-end to the horizon',
    (() => { const r = contribs(run([{ surplusFraction: 1 }]));
      return r[0].date === '2026-09-30' && r.slice(-1)[0].date === HORIZON; })());
  check('the month-end grid is the shared one',
    JSON.stringify(contribs(run([{ surplusFraction: 1 }])).map((m) => m.date))
      === JSON.stringify(monthEndsBetween(ASOF, HORIZON)));
}

console.log('\n9. THE EXISTING BASES ARE UNTOUCHED');
{
  const fixed = run([{ from: '2026-10-31', cadence: 'monthly', amount: 1_000 }]);
  check('a fixed monthly amount still contributes exactly that amount',
    contribs(fixed).every((m) => m.amount === 1_000) && contribs(fixed).length === 15,
    `${contribs(fixed).length} months`);
  check('…and still conserves net worth at 0%',
    last(fixed).netWorth!.amount === last(run([])).netWorth!.amount);
  const yearly = run([{ from: '2026-12-31', cadence: 'yearly', amount: 10_000 }]);
  check('a yearly cadence still steps twelve months', contribs(yearly).length === 2
    && contribs(yearly)[1].date === '2027-12-31');
  const oneOff = run([{ onDate: '2026-12-31', amount: 5_000 }]);
  check('a one-off still lands once', contribs(oneOff).length === 1);
  check('a sub-dollar amount is still refused as a fraction in disguise',
    expandContributions([{ onDate: '2026-12-31', amount: -0.5 }], ASOF, HORIZON)
      .rejected.length === 1);
  check('the expansion cap still applies', MAX_EXPANDED_CONTRIBUTIONS === 600);
  check('a fixed rule carries no surplus fields',
    contribs(fixed)[0].surplusFraction === undefined
      && contribs(fixed)[0].projectedSurplus === undefined);
}

console.log('\n10. WHEN THE PROJECTION CANNOT SAY');
{
  const holed: SpinePoint[] = spine([HORIZON]).map((p) =>
    (p.date === '2026-11-30' ? { ...p, liquid: null } : p));
  const { movements } = expandContributions([{ surplusFraction: 1 }], ASOF, HORIZON);
  const r = runScenarioLedger({ opening: OPENING, spine: holed, contributions: movements,
    outflows: [], returns: [] });
  check('a month with no balance at one end is refused, not guessed',
    r.rejected.length === 2 && r.rejected.every((x) => /surplus cannot be stated/.test(x.reason)),
    `${r.rejected.length} refusals`);
  check('…and the months around it still run',
    r.movements.filter((m) => m.kind === 'CONTRIBUTION').length === MONTHLY_ADDS.length - 2);
  check('a base date missing from the spine is refused too',
    settleMovements([{ date: '2027-01-31', label: 'x', surplusFraction: 1,
      baseDate: '2099-12-31' }], [], spine(), OPENING.liquid).rejected.length === 1);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
