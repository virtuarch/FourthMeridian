/**
 * lib/ai/conversation/liability-dynamics.test.ts
 *
 * LIABILITIES AS A MOVING LINE — the arithmetic, proved against a spine.
 *
 * ⚠️ FOUR IDENTITIES ARE THE WHOLE SLICE. A payment at 0% moves money between
 * cash and a balance and leaves net worth alone; interest raises a balance and
 * lowers net worth by exactly itself; a contribution moves money between cash
 * and investments; an outflow leaves. Everything else here — ranking, waterfall,
 * floor, overpayment — is a question of WHERE a settled amount goes, and every
 * case is checked against those identities at every checkpoint.
 *
 * ⚠️ AN UNKNOWN RATE IS NOT ZERO. The most dangerous answer this ledger could
 * give is a payoff date computed as if a card with no known APR charged
 * nothing. Section 9 is the release gate: a line with no rate accrues nothing,
 * is named as unmodelled, ranks last, and the result carries PARTIAL — and an
 * explicitly stated 0% is distinguishable from not knowing.
 *
 *   npx tsx lib/ai/conversation/liability-dynamics.test.ts
 */

import {
  expandContributions, runScenarioLedger, monthEndsBetween, solveForTarget, rankByApr,
  type ContributionSpec, type LedgerOpening, type SpinePoint, type LedgerResult, type LiabilityLine,
  type PlannedMovement, type AllocationTarget,
} from './scenario-ledger';
import { findScenarioCrossing } from './scenario-crossing';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const round2 = (n: number) => Math.round(n * 100) / 100;

const ASOF = '2026-09-13';
const HORIZON = '2029-12-31';
const DATES = monthEndsBetween(ASOF, HORIZON);
/** +$3,000 a month from $8,000; one −$9,000 month and one −$12,000 month. */
const SPINE_VALUE = (d: string, i: number) => {
  let v = 8_000 + (i + 1) * 3_000;
  if (d >= '2027-03-31') v -= 9_000;
  if (d >= '2028-01-31') v -= 12_000;
  return v;
};
const spine = (): SpinePoint[] => DATES.map((d, i) => ({ date: d, liquid: SPINE_VALUE(d, i), isCheckpoint: true }));
const spineAt = (d: string) => SPINE_VALUE(d, DATES.indexOf(d));

const line = (id: string, balance: number, apr: number | null, minimumPayment: number | null): LiabilityLine =>
  ({ id, label: id, balance, apr, minimumPayment });
const opening = (liabilities: LiabilityLine[], extraDebt = 0): LedgerOpening => ({
  asOfISO: ASOF, liquid: 8_000, investments: 5_000, otherAssets: 0,
  debt: round2(liabilities.reduce((t, l) => t + Math.max(0, l.balance), 0) + extraDebt), liabilities });
type Ret = { fromISO: string; toISO: string; annualPct: number };
/** A fixed amount on every month-end, exactly as the goal seek's solved schedule is built. */
interface Grid { grid: true; amount: number; target?: unknown }
const monthly = (amount: number, target?: unknown): Grid => ({ grid: true, amount, target });
const toTargets = (t: unknown): AllocationTarget[] | undefined => t === undefined ? undefined
  : (Array.isArray(t) ? t : [t]).map((x) => (x === 'investments' || x === 'highest_apr') ? x as AllocationTarget
    : typeof x === 'string' ? { liability: x } : x as AllocationTarget);
const gridMovements = (g: Grid): PlannedMovement[] => DATES.map((date) => ({ date, label: 'monthly', amount: g.amount,
  ...(toTargets(g.target) ? { targets: toTargets(g.target) } : {}) }));
const run = (liabilities: LiabilityLine[], specs: (ContributionSpec | Grid)[] = [], opts: {
  outflows?: { date: string; amount: number; label: string }[]; returns?: Ret[]; extraDebt?: number } = {}): LedgerResult => {
  const grids = specs.filter((x): x is Grid => (x as Grid).grid === true);
  const { movements, rejected } = expandContributions(specs.filter((x) => !(x as Grid).grid) as ContributionSpec[], ASOF, HORIZON);
  const all = [...movements, ...grids.flatMap(gridMovements)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const r = runScenarioLedger({ opening: opening(liabilities, opts.extraDebt), spine: spine(),
    contributions: all, outflows: opts.outflows ?? [], returns: opts.returns ?? [] });
  return { ...r, rejected: [...rejected, ...r.rejected] };
};
/** The contribution SPEC form, for what expandContributions refuses. */
const spec = (amount: number, target?: unknown): ContributionSpec =>
  ({ from: ASOF, cadence: 'monthly', amount, ...(target === undefined ? {} : { target: toTargets(target) }) } as ContributionSpec);
const at = (r: LedgerResult, d: string) => r.checkpoints.find((c) => c.date === d)!;
const liab = (r: LedgerResult, d: string, id: string) => at(r, d).liabilities!.find((l) => l.id === id)!;
const payoff = (r: LedgerResult) => r.checkpoints.find((c) => c.debt.amount === 0)?.date ?? null;
const baselineNW = (d: string) => spineAt(d) + 5_000;
/** Identity V, at every checkpoint. */
const identityHolds = (r: LedgerResult) => r.checkpoints.every((c) =>
  c.netWorth!.amount === round2(c.liquid!.amount + c.investments.amount + c.otherAssets.amount - c.debt.amount));

console.log('A. one liability, 0% APR, $200 stated minimum, nothing else');
{
  const r = run([line('card', 2_400, 0, 200)]);
  check('pays exactly 200 a month; no interest ever', r.checkpoints.every((c) => liab(r, c.date, 'card').interest === 0)
    && liab(r, '2026-09-30', 'card').minimumPaid === 200 && at(r, '2026-09-30').debt.amount === 2_200);
  check('debt-free after twelve payments, the last clamped to the balance', payoff(r) === '2027-08-31'
    && liab(r, '2027-08-31', 'card').minimumPaid === 200 && liab(r, '2027-09-30', 'card').minimumPaid === 0, String(payoff(r)));
  check('U. 0% payment identity at every checkpoint: liquid −paid, debt −paid, net worth = baseline − opening debt',
    r.checkpoints.every((c) => c.liquid!.amount === round2(spineAt(c.date) - c.movements.minimumPaymentsToDate)
      && c.debt.amount === round2(Math.max(0, 2_400 - c.movements.minimumPaymentsToDate))
      && c.netWorth!.amount === round2(baselineNW(c.date) - 2_400)));
  check('V. net-worth identity at every checkpoint', identityHolds(r));
  check('the line is reported COMPLETE for interest (a rate of 0 is a rate)', r.liabilities?.interestBasis === 'COMPLETE');
}

console.log('\nB. one liability, 24% APR, $300 minimum — ACT/365 on the carried balance');
{
  const r = run([line('card', 10_000, 24, 300)]);
  const sep = liab(r, '2026-09-30', 'card');
  const expected = round2(10_000 * 0.24 * 17 / 365);
  check('interest for the 17 days to the first month-end, before the minimum', sep.interest === expected
    && sep.closing === round2(10_000 + expected - 300), `${sep.interest} vs ${expected}`);
  check('U. interest identity: debt +interest, net worth −interest, liquid −minimum only',
    at(r, '2026-09-30').netWorth!.amount === round2(baselineNW('2026-09-30') - 10_000 - expected)
      && at(r, '2026-09-30').liquid!.amount === spineAt('2026-09-30') - 300);
  const oct = liab(r, '2026-10-31', 'card');
  check('the next month accrues on the reduced balance over 31 days', oct.interest === round2(sep.closing * 0.24 * 31 / 365));
  check('the running total of interest is on every checkpoint', at(r, '2026-10-31').movements.interestToDate === round2(sep.interest + oct.interest));
  check('Y. a $300 minimum on $10k at 24% does not clear inside the horizon — never crosses', payoff(r) === null && at(r, HORIZON).debt.amount > 0);
  check('V. identity', identityHolds(r));
}

console.log('\nC/D. two liabilities, different rates, $1,000 extra monthly to highest_apr — the waterfall');
{
  const r = run([line('A', 3_000, 29.99, 100), line('B', 6_000, 18, 150)], [monthly(1_000, 'highest_apr')]);
  check('the extra goes to the higher rate first', liab(r, '2026-09-30', 'A').extraPaid === 1_000 && liab(r, '2026-09-30', 'B').extraPaid === 0);
  const clearing = r.checkpoints.find((c) => liab(r, c.date, 'A').closing === 0)!.date;
  const a = liab(r, clearing, 'A'), b = liab(r, clearing, 'B');
  check('O. in the month A clears, the SAME settlement continues to B', a.extraPaid + b.extraPaid === 1_000 && b.extraPaid > 0 && a.closing === 0,
    `${clearing}: A ${a.extraPaid}, B ${b.extraPaid}`);
  check('the movement records where the cash went', (() => {
    const m = r.movements.find((x) => x.date === clearing && x.kind === 'CONTRIBUTION')!;
    return m.placed!.liabilities.map((l) => l.id).join(',') === 'A,B' && m.amount === 1_000 && m.placed!.unplaced === 0;
  })());
  check('W. debt crosses zero, and the month before was positive', (() => {
    const f = findScenarioCrossing({ checkpoints: r.checkpoints, opening: r.opening, metric: 'debt', direction: 'at_or_below', threshold: 0 });
    return f.crossing !== null && f.crossing.previous !== null && f.crossing.previous.value > 0 && f.alreadySatisfied === null;
  })());
  check('after payoff the rule places nothing; the cash stays liquid', r.checkpoints.filter((c) => c.debt.amount === 0)
    .every((c) => r.movements.filter((m) => m.date === c.date && m.kind === 'CONTRIBUTION').every((m) => m.amount === 0 && m.placed!.unplaced === 1_000)));
  check('conservation: net worth = baseline − Σ opening debt − interest to date', r.checkpoints.every((c) =>
    c.netWorth!.amount === round2(baselineNW(c.date) - 9_000 - c.movements.interestToDate)));
  check('V. identity', identityHolds(r));
}

console.log('\nE/F. liquid floor $10k targeting highest_apr; pause under the floor, resume above it');
{
  const r = run([line('A', 60_000, 22, 250)], [{ liquidFloor: 10_000, fractionOfExcess: 1, target: 'highest_apr' } as ContributionSpec]);
  const before = r.checkpoints.filter((c) => c.date < '2027-03-31');
  check('while cash is above the floor the excess goes to the card and cash is pinned at 10k',
    before.every((c) => c.liquid!.amount === 10_000 && liab(r, c.date, 'A').extraPaid > 0));
  const fall = at(r, '2027-03-31');
  check('the falling month: minimum still paid, no extra, cash under the floor, nothing sold',
    liab(r, '2027-03-31', 'A').minimumPaid === 250 && liab(r, '2027-03-31', 'A').extraPaid === 0 && fall.liquid!.amount < 10_000 && fall.investments.amount === 5_000, String(fall.liquid!.amount));
  const resume = r.checkpoints.find((c) => c.date > '2027-03-31' && liab(r, c.date, 'A').extraPaid > 0);
  check('resumes with the current excess once cash is back over the floor', !!resume && resume.liquid!.amount === 10_000, resume?.date);
  check('the floor rule read cash AFTER the minimum (availableBefore = spine − 250 on the first month)',
    r.movements.find((m) => m.kind === 'CONTRIBUTION')!.availableBefore === spineAt('2026-09-30') - 250);
  check('V. identity', identityHolds(r));
}

console.log('\nG/H. overpayment');
{
  const r = run([line('A', 1_200, 0, null)], [monthly(5_000, 'A')]);
  const m = r.movements.find((x) => x.kind === 'CONTRIBUTION')!;
  check('G. a $5,000 rule against a $1,200 card pays 1,200; 3,800 was never consumed and stays liquid',
    m.amount === 1_200 && m.placed!.requested === 5_000 && m.placed!.unplaced === 3_800
      && at(r, '2026-09-30').liquid!.amount === spineAt('2026-09-30') - 1_200 && at(r, '2026-09-30').debt.amount === 0);
  check('…no cash destroyed: net worth = baseline − 1,200', at(r, '2026-09-30').netWorth!.amount === round2(baselineNW('2026-09-30') - 1_200));
  const r2 = run([line('A', 1_200, 0, null)], [monthly(5_000, ['A', 'investments'])]);
  check('H. with an investments fallback the 3,800 is invested in the same settlement',
    at(r2, '2026-09-30').investments.amount === 8_800 && at(r2, '2026-09-30').liquid!.amount === spineAt('2026-09-30') - 5_000
      && r2.movements.find((x) => x.kind === 'CONTRIBUTION')!.placed!.investments === 3_800);
  check('V. identity on both', identityHolds(r) && identityHolds(r2));
}

console.log('\nI/J/K. unknown APR vs stated 0% vs user override');
{
  const unknown = run([line('A', 4_000, null, 100)]);
  check('I. unknown rate: nothing accrues, payments still reduce it', unknown.checkpoints.every((c) => liab(unknown, c.date, 'A').interest === 0)
    && at(unknown, '2026-10-31').debt.amount === 3_800);
  check('…and the ledger says NONE of the owed lines had a rate', unknown.liabilities?.interestBasis === 'NONE'
    && unknown.liabilities?.unmodelled.length === 1 && /no rate is known/.test(unknown.liabilities!.unmodelled[0].reason));
  const zero = run([line('A', 4_000, 0, 100)]);
  check('J. an explicit 0% is COMPLETE, not unmodelled', zero.liabilities?.interestBasis === 'COMPLETE' && zero.liabilities?.unmodelled.length === 0);
  const override = run([{ ...line('A', 4_000, 18, 100), termsProvenance: { apr: 'USER_ASSUMED', minimumPayment: 'STATED' } }]);
  check('K. a user-assumed 18% accrues and is echoed as USER_ASSUMED', liab(override, '2026-09-30', 'A').interest === round2(4_000 * 0.18 * 17 / 365)
    && override.liabilities?.lines[0].termsProvenance?.apr === 'USER_ASSUMED');
}

console.log('\nL/M. unknown minimum, and minimum + extra do not double count');
{
  const r = run([line('A', 5_000, 20, null)]);
  check('L. no stated minimum: no baseline payment, the balance only accrues', r.checkpoints.every((c) => liab(r, c.date, 'A').minimumPaid === 0)
    && at(r, HORIZON).debt.amount > 5_000);
  const both = run([line('A', 5_000, 0, 300)], [monthly(500, 'A')]);
  const sep = liab(both, '2026-09-30', 'A');
  check('M. $300 minimum + $500 extra = $800 off the balance and $800 out of cash, counted once each',
    sep.minimumPaid === 300 && sep.extraPaid === 500 && sep.closing === 4_200
      && at(both, '2026-09-30').liquid!.amount === spineAt('2026-09-30') - 800
      && at(both, '2026-09-30').movements.minimumPaymentsToDate === 300 && at(both, '2026-09-30').movements.contributionsToDate.total === 500);
  check('V. identity', identityHolds(both));
}

console.log('\nN. deterministic tie-break');
{
  const tie = run([line('Z', 1_000, 20, null), line('A', 1_000, 20, null)], [monthly(500, 'highest_apr')]);
  check('equal rate, equal balance: id order (A before Z)', liab(tie, '2026-09-30', 'A').extraPaid === 500 && liab(tie, '2026-09-30', 'Z').extraPaid === 0);
  const tie2 = run([line('A', 1_000, 20, null), line('B', 3_000, 20, null)], [monthly(500, 'highest_apr')]);
  check('equal rate: larger balance first', liab(tie2, '2026-09-30', 'B').extraPaid === 500);
  check('rankByApr puts an unknown rate last', rankByApr([{ line: line('U', 9_000, null, null), balance: 9_000 },
    { line: line('K', 100, 5, null), balance: 100 }]).map((s) => s.line.id).join(',') === 'K,U');
}

console.log('\nP/Q/R. same-date composition');
{
  const two = run([line('A', 5_000, 20, 200)], [monthly(300, 'highest_apr'), monthly(400)]);
  check('P/R. a debt rule and an investment rule on one date both settle, in insertion order',
    liab(two, '2026-09-30', 'A').extraPaid === 300 && at(two, '2026-09-30').investments.amount === 5_400
      && at(two, '2026-09-30').liquid!.amount === spineAt('2026-09-30') - 200 - 300 - 400);
  const out = run([line('A', 50_000, 20, 200)], [{ liquidFloor: 5_000, fractionOfExcess: 1, target: 'highest_apr' } as ContributionSpec],
    { outflows: [{ date: '2026-10-31', amount: 20_000, label: 'car' }] });
  const oc = at(out, '2026-10-31');
  check('Q. outflow, then minimum, then the floor rule reads what is left (nothing)', liab(out, '2026-10-31', 'A').minimumPaid === 200
    && liab(out, '2026-10-31', 'A').extraPaid === 0
    && oc.liquid!.amount === round2(spineAt('2026-10-31') - 20_000 - oc.movements.minimumPaymentsToDate - oc.movements.contributionsToDate.total)
    && oc.movements.sincePreviousCheckpoint.contributions === 0, String(oc.liquid!.amount));
  check('V. identity', identityHolds(two) && identityHolds(out));
}

console.log('\nS/T. what is refused');
{
  const neg = expandContributions([spec(-500, 'A')], ASOF, HORIZON);
  check('S. a negative amount toward a liability is refused as borrowing', neg.movements.length === 0 && /borrowing/.test(neg.rejected[0]?.reason ?? ''));
  const negInv = expandContributions([spec(-500)], ASOF, HORIZON);
  check('…while a negative amount to investments is still a withdrawal', negInv.movements.length > 0 && negInv.rejected.length === 0);
  const unknownTarget = run([line('A', 1_000, 0, null)], [monthly(100, 'NOPE')]);
  check('T. an unknown liability id is refused by name, and nothing moves', unknownTarget.rejected.some((x) => /no liability NOPE/.test(x.reason))
    && unknownTarget.movements.filter((m) => m.kind === 'CONTRIBUTION').length === 0);
  const empty = expandContributions([spec(100, [])], ASOF, HORIZON);
  check('an empty target list is refused', empty.movements.length === 0 && /empty target/.test(empty.rejected[0]?.reason ?? ''));
  const bad = expandContributions([spec(100, 'sideways' as unknown as string)], ASOF, HORIZON);
  check('a target word the ledger does not know becomes a liability id and is refused at settlement', bad.movements.length > 0
    && run([line('A', 1, 0, null)], [monthly(100, 'sideways')]).rejected.some((x) => /no liability sideways/.test(x.reason)));
  const raw = expandContributions([{ from: ASOF, cadence: 'monthly', amount: 100, target: 'sideways' } as unknown as ContributionSpec], ASOF, HORIZON);
  check('…and a bare string that is not a known word is refused by the ledger contract itself', raw.movements.length === 0 && /must be/.test(raw.rejected[0]?.reason ?? ''));
}

console.log('\nX. already satisfied, and a withheld aggregate');
{
  const clear = run([line('A', 0, 20, 100)]);
  const f = findScenarioCrossing({ checkpoints: clear.checkpoints, opening: clear.opening, metric: 'debt', direction: 'at_or_below', threshold: 0 });
  check('X. nothing owed: already satisfied today, no crossing, NOT_APPLICABLE', f.alreadySatisfied !== null && f.crossing === null
    && clear.liabilities?.interestBasis === 'NOT_APPLICABLE');
  const credit = run([line('A', -35.64, null, null)]);
  check('a credit balance opens at 0 owed and never becomes negative debt', credit.checkpoints.every((c) => c.debt.amount === 0));
  const withheld = run([line('A', 2_000, 0, 100)], [], { extraDebt: 3_000 });
  check('debt the lines do not cover is held flat inside the aggregate', withheld.liabilities?.withheldAggregate === 3_000
    && at(withheld, '2026-09-30').debt.amount === 3_000 + 1_900 && identityHolds(withheld));
}

console.log('\nBackwards compatibility — no liabilities, no targets');
{
  const legacy = runScenarioLedger({ opening: { asOfISO: ASOF, liquid: 8_000, investments: 5_000, debt: 4_000, otherAssets: 0 },
    spine: spine(), contributions: expandContributions([spec(250), { surplusFraction: 0.5 }], ASOF, HORIZON).movements,
    outflows: [], returns: [{ fromISO: ASOF, toISO: HORIZON, annualPct: 7 }] });
  check('no `liabilities` key, no `placed`, debt held flat at the opening figure', !('liabilities' in legacy)
    && legacy.movements.every((m) => !('placed' in m)) && legacy.checkpoints.every((c) => c.debt.amount === 4_000 && !('liabilities' in c)));
  check('the new totals are zero, not absent', legacy.checkpoints.every((c) => c.movements.interestToDate === 0 && c.movements.minimumPaymentsToDate === 0));
}

console.log('\nPayload discipline — a run of negative months is one warning');
{
  const drowning = runScenarioLedger({ opening: { asOfISO: ASOF, liquid: 8_000, investments: 5_000, debt: 0, otherAssets: 0 },
    spine: DATES.map((d, i) => ({ date: d, liquid: 8_000 - (i + 1) * 3_000, isCheckpoint: true })),
    contributions: [], outflows: [], returns: [] });
  const neg = drowning.warnings.filter((w) => /Cash is negative/.test(w));
  check('thirty-eight negative month-ends collapse to one warning naming the span, the count and the low',
    neg.length === 1 && /at 38 month-ends from 2026-11-30 through 2029-12-31/.test(neg[0]) && /lowest -112000.00/.test(neg[0]), neg[0]?.slice(0, 120));
  const one = runScenarioLedger({ opening: { asOfISO: ASOF, liquid: 8_000, investments: 5_000, debt: 0, otherAssets: 0 },
    spine: [{ date: '2026-09-30', liquid: -10, isCheckpoint: true }, { date: '2026-10-31', liquid: 100, isCheckpoint: true }],
    contributions: [], outflows: [], returns: [] });
  check('a single negative month keeps its own, dated warning', one.warnings.length === 1 && /at 2026-09-30:/.test(one.warnings[0]));
}

console.log('\nZ. goal seek: the extra monthly payment that clears the debt by the horizon');
{
  const lines = [line('A', 12_000, 22, 150), line('B', 4_000, 15, 80)];
  const evaluate = (x: number) => {
    const r = run(lines, x > 0 ? [monthly(x, 'highest_apr')] : []);
    return -at(r, HORIZON).debt.amount;   // solved downward: minus debt rises with the payment
  };
  const solved = solveForTarget({ solveFor: 'monthlyContribution', evaluate, target: -0, lo: 0, hi: 16_000, precision: 0.01 });
  check('feasible, and the solved amount clears the debt by the horizon', solved.feasible && at(run(lines, [monthly((solved as { required: number }).required, 'highest_apr')]), HORIZON).debt.amount === 0,
    JSON.stringify(solved));
  check('…a cent less does not', !solved.feasible || at(run(lines, [monthly((solved as { required: number }).required - 0.01, 'highest_apr')]), HORIZON).debt.amount > 0);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
