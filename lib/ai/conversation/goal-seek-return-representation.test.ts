/**
 * lib/ai/conversation/goal-seek-return-representation.test.ts — Slice A (A1 + A3 + A6)
 *
 * "What return do I need between now and Dec 31?" was answered "444% annualized".
 * The arithmetic was right; the representation was the only one the tool had.
 * These checks prove, below the model:
 *   1. the 89-day dogfood shape returns BOTH the period and the annualized
 *      return, and both reconcile to the one ledger growth factor;
 *   2. with contributions during the horizon, periodPct is the factor, NOT
 *      value-at-horizon ÷ opening;
 *   3. a 30-day horizon, 4. a one-year horizon, 5. a multi-year horizon;
 *   6–9. SOLVED / ALREADY_MET / OUT_OF_RANGE / INFEASIBLE, and an absurd but
 *      solvable target is SOLVED, not refused because a bracket was annual;
 *  10. ACT/365 everywhere in the result (no 365.25-day `years` beside it);
 *  11. crossing and projection output unchanged.
 *
 * Standalone tsx script. No DB, no network, no model.
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

import type { CashSpineReads, ToolContext } from './tools';
import {
  growthFactor, returnRepresentation, returnHorizon, solveForTarget,
  annualizedFromPeriodPct, periodFromAnnualizedPct,
} from './scenario-ledger';
import { elapsedBetween } from './scenario-crossing';
import { goalSeekFixtureReads as fixtureReads, GOAL_SEEK_FIXTURE } from './fixtures/goal-seek-dogfood';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// The dogfood: asOf 2026-10-03, by 2026-12-31 — 89 days, investments 25,385.
const { ASOF, DEC31, OPENING_INV } = GOAL_SEEK_FIXTURE;

async function main(): Promise<void> {
  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const reads = await fixtureReads(OPENING_INV);
  const readsEmpty = await fixtureReads(0);
  const ctx = (r: CashSpineReads): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, memoryClient: {} as never,
    readClient: {} as never, cashSpineReads: r, plan: { pending: emptyPlan(), scenarioRan: false } });
  const run = async (tool: string, args: Rec, r = reads): Promise<Rec> => (await findTool(tool)!.run(args, ctx(r))) as Rec;
  const seekReturn = (target: number, by: string, extra: Rec = {}, r = reads) =>
    run('scenario_goal_seek', { target, by, solveFor: 'annualReturnPct', measure: 'investments', ...extra }, r);
  /** Reconciliation: the representation is the factor the ledger grew the money by. */
  const reconciles = (gs: Rec): boolean => {
    const f = growthFactor([{ fromISO: ASOF, toISO: gs.by, annualPct: gs.required }], ASOF, gs.by);
    const r = gs.returnAtSolution;
    return near(r.growthFactor, f, 1e-6) && near(r.periodPct, (f - 1) * 100, 0.005)
      && near(r.annualizedPct, gs.required, 0.005)
      && near(1 + r.periodPct / 100, Math.pow(1 + r.annualizedPct / 100, gs.horizon.dayCount / 365), 1e-4);
  };

  // ── 0. the pure primitive ──────────────────────────────────────────────────
  console.log('0. returnRepresentation / returnHorizon');
  const h = returnHorizon(ASOF, DEC31);
  check('2026-10-03 → 2026-12-31 is 89 days, ACT/365', h.dayCount === 89 && h.dayCountConvention === 'ACT/365'
    && near(h.yearFraction, 89 / 365, 1e-6), JSON.stringify(h));
  const rep = returnRepresentation([{ fromISO: ASOF, toISO: DEC31, annualPct: 444.31 }], ASOF, DEC31);
  check('444.31%/yr over 89 days is +51.16% over the period — the pinned vector', rep.periodPct === 51.16
    && rep.annualizedPct === 444.31 && rep.compounding === 'EFFECTIVE_ANNUAL', JSON.stringify(rep));
  check('500%/yr over 89 days is +54.8%; over 30 days +15.9% (the old horizon-blind bracket)',
    near(periodFromAnnualizedPct(500, 89), 54.8, 0.05) && near(periodFromAnnualizedPct(500, 30), 15.9, 0.05));
  check('the conversions are inverses', near(annualizedFromPeriodPct(periodFromAnnualizedPct(444.31, 89), 89), 444.31, 1e-9));
  const leap = returnRepresentation([{ fromISO: '2027-10-03', toISO: '2028-10-03', annualPct: 8 }], '2027-10-03', '2028-10-03');
  check('a leap span is 366 actual days: 8%/yr is +8.0228% over it, and annualizes back to 8%',
    returnHorizon('2027-10-03', '2028-10-03').dayCount === 366 && rep && near(leap.periodPct, 8.02, 0.005)
      && leap.annualizedPct === 8, JSON.stringify(leap));
  const later = returnRepresentation([{ fromISO: '2026-11-01', toISO: DEC31, annualPct: 20 }], ASOF, DEC31);
  check('a rate that starts later: periodPct is the factor over the whole horizon, the annualized rate is effective over it',
    near(later.periodPct, (Math.pow(1.2, 60 / 365) - 1) * 100, 0.005) && (later.annualizedPct ?? 99) < 20, JSON.stringify(later));

  // ── 1. the 89-day dogfood shape ────────────────────────────────────────────
  console.log('1. the 89-day dogfood shape');
  const target89 = Math.round(OPENING_INV * Math.pow(5.4431, 89 / 365) * 100) / 100;
  const dog = await seekReturn(target89, DEC31);
  check('SOLVED, ~444.31%/yr', dog.outcome === 'SOLVED' && dog.feasible === true && near(dog.required, 444.31, 0.011),
    JSON.stringify({ outcome: dog.outcome, required: dog.required }));
  check('…and the period return over the actual horizon is ~+51.16%', near(dog.returnAtSolution?.periodPct, 51.16, 0.011),
    JSON.stringify(dog.returnAtSolution));
  check('both reconcile to the one ledger growth factor', reconciles(dog));
  check('the horizon is stated: 89 days, yearFraction 0.243836, ACT/365', dog.horizon.dayCount === 89
    && dog.horizon.yearFraction === 0.243836 && dog.horizon.startDate === ASOF && dog.horizon.endDate === DEC31);
  check('below a year, the default lead is periodPct', dog.returnAtSolution.leadWith === 'periodPct');
  check('the ledger at the answer reaches the target, and its investments are opening × factor',
    dog.scenario.checkpoints.at(-1).investments.amount >= target89 - 0.005
      && near(dog.scenario.checkpoints.at(-1).investments.amount, OPENING_INV * dog.returnAtSolution.growthFactor, 0.05));
  check('the derivation carries horizon, convention, both representations and the ledger terms',
    dog.derivation?.horizon?.dayCount === 89 && /dayCount\/365/.test(dog.derivation.horizon.compounding)
      && dog.derivation.investments.periodPct === dog.returnAtSolution.periodPct
      && dog.derivation.investments.annualizedPct === dog.returnAtSolution.annualizedPct
      && dog.derivation.investments.opening === OPENING_INV && typeof dog.derivation.terms.liquid === 'number',
    JSON.stringify(dog.derivation));

  // ── 2. contributions during the horizon ─────────────────────────────────────
  console.log('2. contributions during the horizon');
  const withC = await seekReturn(40_000, DEC31, { contributions: [{ from: '2026-10-31', cadence: 'monthly', amount: 2_000 }] });
  const atH = withC.scenario.checkpoints.at(-1).investments.amount;
  const ratioPct = (atH / OPENING_INV - 1) * 100;
  check('SOLVED with principal moved in', withC.outcome === 'SOLVED' && withC.derivation.investments.principalMovedIn > 0,
    JSON.stringify(withC.derivation?.investments));
  check('periodPct is growthFactor − 1, reconciled to the ledger', reconciles(withC));
  check('…and NOT value-at-horizon ÷ opening, which counts principal as return',
    Math.abs(withC.returnAtSolution.periodPct - ratioPct) > 5, `period ${withC.returnAtSolution.periodPct} vs ratio ${ratioPct}`);
  const inv = withC.derivation.investments;
  check('the identity holds: atHorizon = opening + principalMovedIn + growthFromReturn',
    near(inv.atHorizon, inv.opening + inv.principalMovedIn + inv.growthFromReturn, 0.011), JSON.stringify(inv));

  // ── 3. 30 days ──────────────────────────────────────────────────────────────
  console.log('3. a 30-day horizon');
  const NOV2 = '2026-11-02';
  const t30 = Math.round(OPENING_INV * 1.2 * 100) / 100;
  const g30 = await seekReturn(t30, NOV2);
  check('+20% in 30 days is SOLVED — the old 500%/yr bracket stopped at +15.9% and called it unreachable',
    g30.outcome === 'SOLVED' && near(g30.returnAtSolution.periodPct, 20, 0.011) && reconciles(g30),
    JSON.stringify({ o: g30.outcome, r: g30.returnAtSolution }));
  check('…the bound is stated in period terms: up to +500% over the horizon',
    g30.searchRange.periodTo === 500 && /period growth/.test(g30.searchRange.boundIn)
      && near(g30.searchRange.to, annualizedFromPeriodPct(500, 30), 0.01));

  // ── 4. one year ─────────────────────────────────────────────────────────────
  console.log('4. a one-year horizon');
  const Y1 = '2027-10-03';
  const g1 = await seekReturn(Math.round(OPENING_INV * 1.08 * 100) / 100, Y1);
  check('365 days: periodPct equals annualizedPct (± precision)', g1.horizon.dayCount === 365
    && near(g1.returnAtSolution.periodPct, g1.returnAtSolution.annualizedPct, 0.011) && near(g1.required, 8, 0.011) && reconciles(g1),
    JSON.stringify(g1.returnAtSolution));
  check('…and the search is the annual one, 0–500%/yr', g1.searchRange.to === 500 && g1.searchRange.periodTo === 500);

  // ── 5. multi-year ───────────────────────────────────────────────────────────
  console.log('5. a multi-year horizon');
  const Y5 = '2031-10-03';
  const g5 = await seekReturn(Math.round(OPENING_INV * 1.42 * 100) / 100, Y5);
  check('five years, ×1.42: ~7.27%/yr annualized, +42% cumulative', g5.outcome === 'SOLVED'
    && near(g5.required, 7.27, 0.02) && near(g5.returnAtSolution.periodPct, 42, 0.1) && reconciles(g5),
    JSON.stringify(g5.returnAtSolution));
  check('…and the default lead is annualizedPct', g5.returnAtSolution.leadWith === 'annualizedPct');
  check('a one-year horizon is not short: lead annualizedPct', g1.returnAtSolution.leadWith === 'annualizedPct');

  // ── 6–9. the four outcomes ──────────────────────────────────────────────────
  console.log('6–9. SOLVED / ALREADY_MET / OUT_OF_RANGE / INFEASIBLE');
  check('6. SOLVED is feasible, with a required value and the representation', dog.outcome === 'SOLVED' && dog.feasible === true
    && dog.alreadyMet === false);
  const met = await seekReturn(OPENING_INV - 1, DEC31);
  check('7. ALREADY_MET: required 0, period 0, feasible (compatibility)', met.outcome === 'ALREADY_MET' && met.feasible === true
    && met.alreadyMet === true && met.required === 0 && met.returnAtSolution.periodPct === 0, JSON.stringify(met).slice(0, 200));
  const oor = await seekReturn(OPENING_INV * 7, DEC31);
  check('8. OUT_OF_RANGE: the lever moves the result, the search stopped at +500% over the period',
    oor.outcome === 'OUT_OF_RANGE' && oor.feasible === false && oor.bestAtPeriodPct === 500
      && near(oor.bestReached, OPENING_INV * 6, 0.05), JSON.stringify(oor).slice(0, 300));
  check('…and it says the search stopped, never that it is impossible',
    /NOT a proof that it is impossible/.test(oor.meaning) && /not a limit of the arithmetic/.test(oor.reason));
  const inf = await seekReturn(10_000, DEC31, {}, readsEmpty);
  check('8. INFEASIBLE is distinct: no investments and nothing moved in ⇒ no return reaches it',
    inf.outcome === 'INFEASIBLE' && inf.feasible === false && /does not respond/.test(inf.reason), JSON.stringify(inf).slice(0, 300));
  const absurd = await seekReturn(100_000, DEC31);
  check('9. investments 100k by Dec 31 (+293.9% in 89 days) is SOLVED — absurd, but arithmetic',
    absurd.outcome === 'SOLVED' && near(absurd.returnAtSolution.periodPct, (100_000 / OPENING_INV - 1) * 100, 0.02) && reconciles(absurd),
    JSON.stringify({ o: absurd.outcome, r: absurd.returnAtSolution }));
  const cutAll = await run('scenario_goal_seek', { target: 1_000_000, by: DEC31, solveFor: 'monthlySpendingCut' });
  check('a STRUCTURAL bound (cut no more than all spending) exhausted is INFEASIBLE, not OUT_OF_RANGE',
    cutAll.outcome === 'INFEASIBLE' && cutAll.feasible === false && cutAll.bestAtPeriodPct === undefined,
    JSON.stringify(cutAll).slice(0, 300));
  const cOOR = await run('scenario_goal_seek', { target: 10_000_000, by: DEC31, solveFor: 'monthlyContribution', annualReturnPct: 50 });
  check('a SEARCH bound on a contribution exhausted is OUT_OF_RANGE', cOOR.outcome === 'OUT_OF_RANGE', JSON.stringify(cOOR).slice(0, 300));

  // The solver itself, below the tool.
  const lin = (x: number) => 1000 + 100 * x;
  check('solver: search bound exhausted ⇒ OUT_OF_RANGE', solveForTarget({ solveFor: 'x', evaluate: lin, target: 1e6, lo: 0, hi: 100, precision: 0.01 }).outcome === 'OUT_OF_RANGE');
  check('solver: structural bound exhausted ⇒ INFEASIBLE', solveForTarget({ solveFor: 'x', evaluate: lin, target: 1e6, lo: 0, hi: 100, precision: 0.01, bound: 'STRUCTURAL' }).outcome === 'INFEASIBLE');
  check('solver: flat ⇒ INFEASIBLE even under a search bound', solveForTarget({ solveFor: 'x', evaluate: () => 5, target: 10, lo: 0, hi: 100, precision: 0.01 }).outcome === 'INFEASIBLE');

  // ── 10. ACT/365 consistency ─────────────────────────────────────────────────
  console.log('10. one year convention per result');
  check('yearFraction × 365 = dayCount', near(dog.horizon.yearFraction * 365, dog.horizon.dayCount, 1e-3)
    && near(g5.horizon.yearFraction * 365, g5.horizon.dayCount, 1e-3));
  check('timeToTarget no longer carries a 365.25-day `years` beside the ACT/365 horizon',
    !('years' in dog.timeToTarget) && dog.timeToTarget.totalDays === dog.horizon.dayCount && typeof dog.timeToTarget.label === 'string');
  check('every path states the horizon, including a refusal', oor.horizon?.dayCount === 89 && inf.horizon?.dayCount === 89
    && cutAll.horizon?.dayCount === 89);

  // ── 11. crossing / projection unchanged ─────────────────────────────────────
  console.log('11. crossing and projection unchanged');
  check('elapsedBetween is still the display distance (365.25-day years) everywhere else',
    elapsedBetween(ASOF, DEC31).years === Math.round((89 / 365.25) * 100) / 100);
  const cross = await run('scenario_crossing', { threshold: OPENING_INV * 1.1, metric: 'investments', direction: 'at_or_above', annualReturnPct: 50, searchThrough: '2027-12-31' });
  check('a crossing still carries its elapsed distance with `years`, and no return representation',
    cross.crossing?.elapsed && 'years' in cross.crossing.elapsed && !('returnAtSolution' in cross), JSON.stringify(cross).slice(0, 300));
  const proj = await run('scenario_projection', { to: DEC31, annualReturnPct: 444.31, measure: 'investments' });
  check('a projection at 444.31%/yr lands investments at opening × the same factor the goal seek reported',
    near(proj.checkpoints.at(-1).investments.amount, OPENING_INV * rep.growthFactor, 0.05));

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
