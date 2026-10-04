/**
 * lib/ai/conversation/goal-seek-continuity.test.ts — A7, goal-seek capture
 *
 * The dogfood asked "make investments 100k by Dec 31", then corrected "no — total
 * net worth 100k", and the second answer had to rebuild the scenario from prose
 * because a goal seek left no state. Through the REAL tool on fixture reads:
 *   1. a solved goal seek REPLACEs the active scenario, carrying the goal's outcome,
 *      the solved value and both return representations, and the ledger AT the answer;
 *   2. replaying the captured assumptions reproduces the captured figures exactly;
 *   3. a correction of ONE goal dimension (measure) is one changed field: every
 *      clause that ran before runs again, and nothing is dropped;
 *   4. a goal that was not reached is still captured — with the baseline position
 *      and its outcome, never a solved value;
 *   5. a refused goal seek CLEARs; an unrelated tool IGNOREs; the envelope stays small.
 *
 * Standalone tsx script. No DB, no network, no model.
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

import type { ToolContext } from './tools';
import { goalSeekFixtureReads, GOAL_SEEK_FIXTURE } from './fixtures/goal-seek-dogfood';
import {
  captureActiveScenario, applyCapture, newScenarioSlot, scenarioMessage, GOAL_SEEK_TOOL,
} from './active-scenario';

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
  const reads = await goalSeekFixtureReads();
  const ctx = (): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, memoryClient: {} as never,
    readClient: {} as never, cashSpineReads: reads, plan: { pending: emptyPlan(), scenarioRan: false } });
  const seek = async (args: Rec): Promise<Rec> => (await findTool(GOAL_SEEK_TOOL)!.run(args, ctx())) as Rec;

  // A scenario with more than one clause, so "nothing dropped" means something.
  const ASK: Rec = { target: 100_000, by: DEC31, solveFor: 'annualReturnPct', measure: 'investments',
    contributions: [{ from: '2026-10-31', cadence: 'monthly', amount: 1_000 }],
    outflows: [{ onDate: '2026-11-15', amount: 2_000, label: 'trip' }] };

  // ── 1. solved ⇒ REPLACE with the goal ───────────────────────────────────────
  console.log('1. a solved goal seek becomes the active scenario');
  const r1 = await seek(ASK);
  const c1 = captureActiveScenario(GOAL_SEEK_TOOL, ASK, r1);
  const slot = newScenarioSlot();
  applyCapture(slot, c1);
  const a = slot.active!;
  check('SOLVED, and captured as REPLACE', r1.outcome === 'SOLVED' && c1.action === 'REPLACE', JSON.stringify({ o: r1.outcome, c: c1.action }));
  check('the goal says the measure, the outcome, the solved value and both representations',
    a.goal?.measure === 'investments' && a.goal.outcome === 'SOLVED' && a.goal.solved?.value === r1.required
      && a.goal.solved.periodPct === r1.returnAtSolution.periodPct && a.goal.solved.annualizedPct === r1.returnAtSolution.annualizedPct,
    JSON.stringify(a.goal));
  check('…and that the figures are AT the solved value, which the assumptions do not contain', /AT the solved/.test(a.goal?.resultIs ?? ''));
  const atAnswer = r1.scenario.checkpoints.at(-1);
  check('the result is the ledger AT the answer, at the deadline', a.result.to === DEC31 && a.result.asOf === ASOF
    && a.result.investments === atAnswer.investments.amount && a.result.netWorth === atAnswer.netWorth.amount
    && a.result.investments >= 100_000 - 0.005);
  check('the goal dimensions live in the assumptions, verbatim — not a second copy',
    a.assumptions.target === 100_000 && a.assumptions.by === DEC31 && a.assumptions.measure === 'investments'
      && a.assumptions.solveFor === 'annualReturnPct' && !('target' in (a.goal as Rec)));

  // ── 2. replay ───────────────────────────────────────────────────────────────
  console.log('2. the captured assumptions replay to the captured figures');
  const replay = captureActiveScenario(GOAL_SEEK_TOOL, a.assumptions, await seek(a.assumptions));
  check('byte-identical result and goal', replay.action === 'REPLACE'
    && JSON.stringify(replay.scenario.result) === JSON.stringify(a.result) && JSON.stringify(replay.scenario.goal) === JSON.stringify(a.goal));

  // ── 3. a correction is one field ────────────────────────────────────────────
  console.log('3. "no — total net worth 100k" changes one field');
  const corrected = { ...a.assumptions, measure: 'netWorth' };
  const r3 = await seek(corrected);
  applyCapture(slot, captureActiveScenario(GOAL_SEEK_TOOL, corrected, r3));
  const strip = (x: Rec) => { const { measure: _m, ...rest } = x; void _m; return rest; };
  check('the same clauses ran — argumentsRun differs ONLY in measure',
    JSON.stringify(strip(r3.assumptionsInForce.argumentsRun)) === JSON.stringify(strip(r1.assumptionsInForce.argumentsRun)),
    JSON.stringify(r3.assumptionsInForce.argumentsRun));
  check('…the clause roster is identical (nothing dropped)',
    JSON.stringify(r3.assumptionsInForce.clauses) === JSON.stringify(r1.assumptionsInForce.clauses));
  check('…and the envelope now holds the net-worth goal, solved, with a smaller required return',
    slot.active?.goal?.measure === 'netWorth' && r3.outcome === 'SOLVED' && r3.required < r1.required,
    JSON.stringify(slot.active?.goal));

  // ── 4. not reached is still the goal ────────────────────────────────────────
  console.log('4. a goal that was not reached is captured with its outcome');
  const far = { ...ASK, target: 10_000_000 };
  const r4 = await seek(far);
  const c4 = captureActiveScenario(GOAL_SEEK_TOOL, far, r4);
  check('OUT_OF_RANGE ⇒ REPLACE, outcome carried, no solved value', r4.outcome === 'OUT_OF_RANGE' && c4.action === 'REPLACE'
    && c4.scenario.goal?.outcome === 'OUT_OF_RANGE' && c4.scenario.goal.solved === undefined, JSON.stringify(c4).slice(0, 300));
  check('…the position is the stated assumptions WITHOUT the lever, at the deadline',
    c4.action === 'REPLACE' && c4.scenario.result.to === DEC31 && c4.scenario.result.netWorth === r4.baseline.at.netWorth
      && /WITHOUT/.test(c4.scenario.goal?.resultIs ?? ''));

  // ── 5. refusal / other tools / size ─────────────────────────────────────────
  console.log('5. refusal, other tools, size');
  const refused = await seek({ ...ASK, by: '2026-01-01' });
  check('a refused goal seek CLEARs', 'unavailable' in refused && captureActiveScenario(GOAL_SEEK_TOOL, { ...ASK, by: '2026-01-01' }, refused).action === 'CLEAR');
  check('an unrelated tool still IGNOREs', captureActiveScenario('get_spending', {}, { ok: true }).action === 'IGNORE');
  const size = scenarioMessage(a).content.length;
  check('the envelope with a goal stays under 1,500 B', size < 1_500, `${size} B`);
  console.log(`    envelope with goal: ${size} B / ~${Math.ceil(size / 4)} tok`);

  console.log(failures === 0 ? '\nall goal-seek continuity checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
