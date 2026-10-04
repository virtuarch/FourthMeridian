/**
 * lib/ai/conversation/provenance-origin.test.ts — "the user said X" requires the user's words
 *
 * The narrow provenance correction (owner, 2026-10-04). A direct tool argument is checked against
 * the user's own words with the SAME gate staging uses (`argumentFiguresStated`); it is still applied
 * where the contract allows, but only a licensed figure may be labelled the user's. Proven through the
 * real tools on fixture reads:
 *   1. spending the user said        → USER_STATED
 *   2. assumedMonthlySpending (B6)   → MODEL_SUPPLIED, same arithmetic, and never checkpointed
 *   3. a return the user said        → USER_STATED, as a scenario assumption
 *   4. a return the model supplied   → MODEL_SUPPLIED
 *   5. a solver's answer             → SOLVED (the returns it ran, and the result)
 *   6. an account's stored debt terms → USER_CONFIRMED, and no longer a "user assumption" on the lines;
 *      an assumed APR is USER_STATED or MODEL_SUPPLIED by the same gate
 * No money moves: every pair of runs above lands on the same figures.
 *
 * Standalone tsx script. No DB, no network, no model.
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

import type { CashSpineReads, ToolContext } from './tools';
import { goalSeekFixtureReads, GOAL_SEEK_FIXTURE } from './fixtures/goal-seek-dogfood';
import { turnEvidence } from './memory-model';
import { argumentFiguresStated } from './pending-plan';
import { projectionStatement } from './memory-tools';

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
const { ASOF, DEC31 } = GOAL_SEEK_FIXTURE;

async function main(): Promise<void> {
  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const base = await goalSeekFixtureReads();
  // The same Space with a card whose APR and minimum are stored ON THE ACCOUNT.
  const withCard: CashSpineReads = { ...base, accounts: async () => ({
    ...(await base.accounts()) as Rec, totalLiabilities: 3_000, netWorth: 20_000 + GOAL_SEEK_FIXTURE.OPENING_INV - 3_000,
    counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 1 },
    accounts: [{ id: 'card1', name: 'Card A', type: 'debt', visibilityLevel: 'FULL', balance: -3_000, amountOwed: 3_000,
      apr: 24, minimumPayment: 100 }] }) as never };
  const ctx = (said: string[], r: CashSpineReads = base): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never,
    memoryClient: {} as never, readClient: {} as never, cashSpineReads: r,
    plan: { pending: emptyPlan(), scenarioRan: false }, turn: turnEvidence(said, []) });
  const run = async (tool: string, a: Rec, said: string[], r?: CashSpineReads): Promise<Rec> =>
    (await findTool(tool)!.run(a, ctx(said, r))) as Rec;
  const end = (r: Rec) => r.checkpoints.at(-1);

  console.log('0. the gate itself');
  const ev = turnEvidence(['Assume I spend $3,000 a month and earn 7% a year.'], []);
  check('a figure the user said is licensed; one they did not is not',
    argumentFiguresStated('assumedMonthlySpending', 3_000, ev) && !argumentFiguresStated('assumedMonthlySpending', 3_500, ev)
      && argumentFiguresStated('annualReturnPct', 7, ev) && !argumentFiguresStated('annualReturnPct', 8, ev));
  check('get_baselines\' direct figures use the same gate', argumentFiguresStated('statedMonthlySpending', 3_000, ev)
    && !argumentFiguresStated('statedMonthlyIncome', 9_000, ev));
  check('no evidence ⇒ never the user\'s', !argumentFiguresStated('assumedMonthlySpending', 3_000, undefined));

  console.log('\n1–2. spending: said vs supplied (B6)');
  const SAID_SPEND = ['Plan it as if I spend $3,000 a month.'];
  const sSaid = await run('scenario_projection', { to: DEC31, assumedMonthlySpending: 3_000 }, SAID_SPEND);
  const sModel = await run('scenario_projection', { to: DEC31, assumedMonthlySpending: 3_000 }, ['What will I have by December?']);
  check('1. user said it → spending.source USER_STATED', sSaid.assumptions.spending.source === 'USER_STATED', sSaid.assumptions.spending.source);
  check('2. model supplied it → MODEL_SUPPLIED, never USER_STATED', sModel.assumptions.spending.source === 'MODEL_SUPPLIED', sModel.assumptions.spending.source);
  check('…same arithmetic either way', end(sSaid).liquid.amount === end(sModel).liquid.amount && end(sSaid).netWorth.amount === end(sModel).netWorth.amount);
  const pModel = await run('project_cash', { to: DEC31, assumedMonthlySpending: 3_000 }, ['What will I have by December?']);
  const pSaid = await run('project_cash', { to: DEC31, assumedMonthlySpending: 3_000 }, SAID_SPEND);
  const srcOf = (p: Rec) => p.projection?.basis?.spending?.source;
  check('project_cash labels the same way', srcOf(pSaid) === 'USER_STATED' && srcOf(pModel) === 'MODEL_SUPPLIED', `${srcOf(pSaid)} / ${srcOf(pModel)}`);
  check('…and a projection on a supplied level is never checkpointed as evidence',
    projectionStatement('project_cash', pModel, ASOF) === null && projectionStatement('project_cash', pSaid, ASOF) === null);

  console.log('\n3–4. returns: said vs supplied');
  const rSaid = await run('scenario_projection', { to: DEC31, annualReturnPct: 7 }, ['Assume my investments return 7% a year.']);
  const rModel = await run('scenario_projection', { to: DEC31, annualReturnPct: 7 }, ['How will my investments look by December?']);
  check('3. a return the user said → USER_STATED, as a scenario assumption',
    rSaid.assumptions.returns[0].origin === 'USER_STATED' && rSaid.assumptions.returns[0].scenarioAssumption === true);
  check('4. a return the model supplied → MODEL_SUPPLIED', rModel.assumptions.returns[0].origin === 'MODEL_SUPPLIED');
  check('…and no return echo carries the old USER_ASSUMED label', !JSON.stringify(rModel.assumptions.returns).includes('USER_ASSUMED'));
  check('…same arithmetic', end(rSaid).investments.amount === end(rModel).investments.amount);

  console.log('\n5. solver-produced values');
  const gs = await run('scenario_goal_seek', { target: 40_000, by: DEC31, solveFor: 'annualReturnPct', measure: 'investments' },
    ['What return would get my investments to 40,000 by December?']);
  check('5. the solved return in the table is SOLVED, and so is the result',
    gs.outcome === 'SOLVED' && gs.scenario.assumptions.returns[0].origin === 'SOLVED' && gs.origin === 'SOLVED' && !('provenance' in gs),
    JSON.stringify({ o: gs.outcome, r: gs.scenario?.assumptions?.returns?.[0]?.origin, g: gs.origin }));
  const gc = await run('scenario_goal_seek', { target: 28_000, by: '2026-11-30', solveFor: 'monthlyContribution', measure: 'investments' },
    ['How much a month to reach 28,000 in investments by November?']);
  check('…a solved monthly contribution is marked as the solver\'s within the contributions echo',
    gc.scenario.assumptions.contributions.solvedIncluded?.origin === 'SOLVED');

  console.log('\n6. debt terms');
  const acct = await run('scenario_projection', { to: DEC31 }, ['What will I have by December?'], withCard);
  const terms = acct.assumptions.liabilities.lines[0].terms;
  check('6. terms stored on the account → USER_CONFIRMED (not stated here, not assumed)',
    terms.apr === 'USER_CONFIRMED' && terms.minimumPayment === 'USER_CONFIRMED', JSON.stringify(terms));
  const lines = end(acct);
  check('…and the cash and debt lines no longer call the account\'s own terms a user assumption',
    !lines.liquid.provenance.includes('USER_ASSUMED') && !lines.debt.provenance.includes('USER_ASSUMED')
      && lines.debt.provenance.includes('PROJECTED_FROM_EVIDENCE'), JSON.stringify({ l: lines.liquid.provenance, d: lines.debt.provenance }));
  const LA = { to: DEC31, liabilityAssumptions: [{ liabilityId: 'card1', apr: 18 }] };
  const aSaid = await run('scenario_projection', LA, ['What if my card was at 18% APR instead?'], withCard);
  const aModel = await run('scenario_projection', LA, ['What will I have by December?'], withCard);
  check('an assumed APR the user said → USER_STATED; one the model supplied → MODEL_SUPPLIED',
    aSaid.assumptions.liabilities.lines[0].terms.apr === 'USER_STATED' && aModel.assumptions.liabilities.lines[0].terms.apr === 'MODEL_SUPPLIED',
    JSON.stringify([aSaid.assumptions.liabilities.lines[0].terms, aModel.assumptions.liabilities.lines[0].terms]));
  check('…an ASSUMED term is still a scenario assumption on the debt line', end(aModel).debt.provenance.includes('USER_ASSUMED'));
  check('…same arithmetic for said and supplied', end(aSaid).debt.amount === end(aModel).debt.amount);

  console.log(failures === 0 ? '\nall provenance-origin checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
