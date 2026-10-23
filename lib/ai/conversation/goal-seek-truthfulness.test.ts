/**
 * lib/ai/conversation/goal-seek-truthfulness.test.ts — goal-seek and crossing truthfulness
 *
 * Four contract defects, each reproduced on 2026-10-04 and proven fixed here below the model:
 *   R2  evaluation failure became impossibility — a Space with no complete month of spending got
 *       INFEASIBLE "no amount of it reaches the target", and the crossing said "not met at any
 *       month-end" after examining zero of them;
 *   R5  a mid-month deadline bought a whole extra monthly contribution — "by 1 Nov" needed 1,000.01
 *       where "by 31 Oct" needed 2,000;
 *   R6  a stated return beside a return solve — ALREADY_MET with a POSITIVE baseline gap, the baseline
 *       run at the stated −20% while the solve started at 0%;
 *   R7  a lever that moves the measure AWAY from the target was OUT_OF_RANGE, "a larger value might
 *       reach it" (a contribution, against a CASH target).
 *
 * Standalone tsx script. No DB, no network, no model.
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

import type { CashSpineReads, ToolContext } from './tools';
import { goalSeekFixtureReads, GOAL_SEEK_FIXTURE } from './fixtures/goal-seek-dogfood';
import { monthEndOccurrences, monthEndsBetween, solveForTarget } from './scenario-ledger';

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
const { ASOF, DEC31, OPENING_INV } = GOAL_SEEK_FIXTURE;
const IMPOSSIBLE = /does not respond|no amount of it|cannot reach|impossible|not met at any month-end/i;

async function main(): Promise<void> {
  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  const reads = await goalSeekFixtureReads();
  // A Space whose history starts this month: no complete month, so no spending baseline, so no projection.
  const thin: CashSpineReads = { ...reads, transactionsSummary: async () => ({
    monthlyBreakdown: buildMonthlyBreakdown([] as never, [], '2026-10-01', ASOF, null),
    startDate: '2026-10-01', endDate: ASOF, windowDays: 3, transactionCount: 0, truncated: false }) as never };
  const ctx = (r: CashSpineReads): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, memoryClient: {} as never,
    readClient: {} as never, cashSpineReads: r, plan: { pending: emptyPlan(), scenarioRan: false } });
  const run = async (tool: string, a: Rec, r: CashSpineReads = reads): Promise<Rec> => (await findTool(tool)!.run(a, ctx(r))) as Rec;
  const seek = (a: Rec, r?: CashSpineReads) => run('scenario_goal_seek', a, r);

  // ── R2 — evaluation failure is not impossibility ────────────────────────────
  console.log('R2. a projection that cannot run is UNKNOWN, never impossible');
  const lin = (x: number) => 1000 + 100 * x;
  const nul = () => null;
  check('solver: no value at the bottom ⇒ EVALUATION_FAILED',
    solveForTarget({ solveFor: 'x', evaluate: nul, target: 10, lo: 0, hi: 100, precision: 0.01 }).outcome === 'EVALUATION_FAILED');
  check('solver: no value at the top ⇒ EVALUATION_FAILED, never INFEASIBLE or OUT_OF_RANGE',
    solveForTarget({ solveFor: 'x', evaluate: (x) => (x === 0 ? 5 : null), target: 10, lo: 0, hi: 100, precision: 0.01 }).outcome === 'EVALUATION_FAILED');
  check('solver: a hole mid-search ⇒ EVALUATION_FAILED (a refusal is not "did not reach")',
    solveForTarget({ solveFor: 'x', evaluate: (x) => (x > 0 && x < 100 ? null : lin(x)), target: 2000, lo: 0, hi: 100, precision: 0.01 }).outcome === 'EVALUATION_FAILED');
  check('solver: a FLAT but evaluated function is still INFEASIBLE',
    solveForTarget({ solveFor: 'x', evaluate: () => 5, target: 10, lo: 0, hi: 100, precision: 0.01 }).outcome === 'INFEASIBLE');
  const failedSolve = solveForTarget({ solveFor: 'x', evaluate: nul, target: 10, lo: 0, hi: 100, precision: 0.01 });
  check('…and the failure reason says so', !failedSolve.feasible && /unknown/i.test(failedSolve.reason) && !IMPOSSIBLE.test(failedSolve.reason),
    !failedSolve.feasible ? failedSolve.reason : '');

  // Net worth needs the cash projection; that is what a thin Space cannot produce.
  for (const solveFor of ['annualReturnPct', 'monthlyContribution']) {
    const r = await seek({ target: 1_000_000, by: '2030-12-31', solveFor, measure: 'netWorth', annualReturnPct: 5 }, thin);
    check(`thin Space, ${solveFor}: EVALUATION_FAILED, not INFEASIBLE`, r.outcome === 'EVALUATION_FAILED' && r.feasible === false,
      JSON.stringify({ o: r.outcome, u: r.unavailable }));
    check(`…with the projection's own reason, and nothing that reads as "impossible"`,
      typeof r.projectionRefusal === 'string' && /UNKNOWN/.test(r.meaning) && !IMPOSSIBLE.test(`${r.reason} ${r.meaning.replace(/Do not call it impossible or unreachable/, '')}`),
      JSON.stringify({ pr: r.projectionRefusal, reason: r.reason }));
  }
  // The investments line does not read the cash projection (opening + contributions + growth), so a
  // contribution solved against INVESTMENTS is evaluable even here — and it says cash is unknown.
  const invOnly = await seek({ target: OPENING_INV + 3_000, by: DEC31, solveFor: 'monthlyContribution', measure: 'investments' }, thin);
  check('thin Space, contribution × investments: evaluable, so it solves — with cash reported unknown, not zero',
    invOnly.outcome === 'SOLVED' && invOnly.scenario.checkpoints.at(-1).liquid === null, JSON.stringify({ o: invOnly.outcome }));
  const cut = await seek({ target: 1_000_000, by: '2030-12-31', solveFor: 'monthlySpendingCut' }, thin);
  check('thin Space, spending cut: still refused up front (no spending level), as before', typeof cut.unavailable === 'string');
  const cr = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7 }, thin);
  check('thin Space, crossing: EVALUATION_FAILED with zero month-ends examined — never "not met at any month-end"',
    cr.outcome === 'EVALUATION_FAILED' && cr.searchedThrough.monthsExamined === 0 && cr.neverCrossesBy === null
      && !/not met at any month-end/.test(cr.meaning) && typeof cr.projectionRefusal === 'string', JSON.stringify(cr).slice(0, 400));
  const ok = await run('scenario_crossing', { metric: 'investments', direction: 'at_or_above', threshold: OPENING_INV * 1.1, annualReturnPct: 50, searchThrough: '2027-12-31' });
  check('a healthy crossing is CROSSES, with no unevaluated months', ok.outcome === 'CROSSES' && ok.searchedThrough.monthsUnevaluated === undefined);
  const never = await run('scenario_crossing', { metric: 'investments', direction: 'at_or_above', threshold: 1e9, annualReturnPct: 5, searchThrough: '2027-12-31' });
  check('…and an evaluated miss is still NOT_WITHIN_WINDOW, scoped to the window', never.outcome === 'NOT_WITHIN_WINDOW'
    && never.searchedThrough.monthsExamined > 0 && /search window/.test(never.meaning));

  // ── R5 — recurring flows land on month-ends, never on a mid-month deadline ──
  console.log('R5. a one-day deadline change does not buy a whole month');
  check('monthEndOccurrences: month-ends only — a mid-month end owes nothing',
    JSON.stringify(monthEndOccurrences('2026-10-03', '2026-11-01')) === '["2026-10-31"]'
      && JSON.stringify(monthEndOccurrences('2026-10-03', '2026-11-30')) === '["2026-10-31","2026-11-30"]'
      && JSON.stringify(monthEndOccurrences('2026-10-31', '2026-12-15')) === '["2026-11-30"]'
      && monthEndOccurrences('2026-10-03', '2026-10-20').length === 0, JSON.stringify(monthEndOccurrences('2026-10-03', '2026-11-01')));
  check('…leap February is a month-end; the checkpoint grid still ends on the horizon',
    JSON.stringify(monthEndOccurrences('2028-02-01', '2028-03-10')) === '["2028-02-29"]'
      && monthEndsBetween('2026-10-03', '2026-11-01').at(-1) === '2026-11-01');
  const contribTo = (by: string) => seek({ target: OPENING_INV + 2_000, by, solveFor: 'monthlyContribution', measure: 'investments' });
  const by: Record<string, Rec> = {};
  for (const d of ['2026-10-31', '2026-11-01', '2026-11-15', '2026-11-29', '2026-11-30']) by[d] = await contribTo(d);
  const req = (d: string) => by[d].required as number;
  check('by Oct 31, Nov 1, Nov 15 and Nov 29 all need ~2,000 (one month-end, one contribution)',
    ['2026-10-31', '2026-11-01', '2026-11-15', '2026-11-29'].every((d) => Math.abs(req(d) - 2_000) < 0.02),
    JSON.stringify(Object.fromEntries(Object.keys(by).map((d) => [d, req(d)]))));
  check('…and by Nov 30, with a second month-end, ~1,000', Math.abs(req('2026-11-30') - 1_000) < 0.02, String(req('2026-11-30')));
  const dates = (r: Rec) => ((r.scenario?.assumptions?.contributions?.settled ?? []) as Rec[]).map((x) => x.date);
  check('the solved schedule is dated on month-ends only — never on the deadline',
    JSON.stringify(dates(by['2026-11-15'])) === '["2026-10-31"]' && JSON.stringify(dates(by['2026-11-30'])) === '["2026-10-31","2026-11-30"]',
    JSON.stringify(dates(by['2026-11-15'])));
  const sur = await run('scenario_projection', { to: '2026-12-15', contributions: [{ surplusFraction: 0.5 }] });
  const flo = await run('scenario_projection', { to: '2026-12-15', contributions: [{ liquidFloor: 15_000, fractionOfExcess: 1 }] });
  const movedOn = (r: Rec) => ((r.assumptions?.contributions?.settled ?? []) as Rec[]).map((x) => x.date);
  check('a surplus share and a floor sweep at a mid-month horizon sweep on month-ends only',
    !movedOn(sur).includes('2026-12-15') && !movedOn(flo).includes('2026-12-15') && movedOn(sur).length === 2,
    JSON.stringify({ sur: movedOn(sur), flo: movedOn(flo) }));

  // ── R6 — status, gap and answer describe one scenario ────────────────────────
  console.log('R6. a solved return replaces a stated one — everywhere in the result');
  const at = async (pct: number) => (await run('scenario_projection', { to: DEC31, annualReturnPct: pct })).checkpoints.at(-1).netWorth.amount as number;
  const nwNeg = await at(-20), nw0 = await at(0);
  const between = await seek({ target: Math.round((nwNeg + nw0) / 2), by: DEC31, solveFor: 'annualReturnPct', annualReturnPct: -20 });
  check('stated −20%, target between the −20% and 0% outcomes: ALREADY_MET, and the gap agrees (≤ 0)',
    between.outcome === 'ALREADY_MET' && between.baseline.gap <= 0, JSON.stringify({ o: between.outcome, gap: between.baseline.gap }));
  check('…the baseline is the 0% scenario, and says so', Math.abs(between.baseline.reached - nw0) < 0.01 && /bottom of the solved range/.test(between.baseline.meaning));
  check('…the stated −20% is echoed as REPLACED, never as in force',
    between.replacedByThisSolve?.returns?.[0]?.annualPct === -20 && between.assumptionsInForce.returns.statedRate === null,
    JSON.stringify({ rep: between.replacedByThisSolve, inForce: between.assumptionsInForce.returns }));
  const above = await seek({ target: Math.round(nw0 + 5_000), by: DEC31, solveFor: 'annualReturnPct', annualReturnPct: -20 });
  check('…and a target above the 0% outcome is SOLVED with a positive gap', above.outcome === 'SOLVED' && above.baseline.gap > 0);
  // The invariant, across levers: ALREADY_MET ⇔ the baseline gap is not positive.
  const grid: [string, Rec][] = [
    ['return', { solveFor: 'annualReturnPct', annualReturnPct: -20 }],
    ['contribution→investments', { solveFor: 'monthlyContribution', measure: 'investments' }],
    ['cut→netWorth', { solveFor: 'monthlySpendingCut' }],
  ];
  let consistent = 0, total = 0;
  for (const [, a] of grid) for (const delta of [-5_000, -1, 1, 5_000]) {
    const base = await seek({ ...a, target: 1, by: DEC31 });
    const r = await seek({ ...a, target: Math.round(base.baseline.reached + delta), by: DEC31 });
    total++;
    if ((r.outcome === 'ALREADY_MET') === (r.baseline.gap <= 0)) consistent++;
  }
  check('across levers and targets: ALREADY_MET exactly when the baseline gap is not positive', consistent === total, `${consistent}/${total}`);

  // ── R7 — the lever's direction is established, and respected ─────────────────
  console.log('R7. a lever that moves the measure away is never "a larger value might reach it"');
  const cases: { name: string; a: Rec; dir: string }[] = [
    { name: 'contribution × investments', a: { solveFor: 'monthlyContribution', measure: 'investments' }, dir: 'TOWARD' },
    { name: 'contribution × CASH', a: { solveFor: 'monthlyContribution', measure: 'liquid' }, dir: 'AWAY' },
    { name: 'contribution × net worth at 0%', a: { solveFor: 'monthlyContribution' }, dir: 'NONE' },
    { name: 'contribution × net worth at 50%', a: { solveFor: 'monthlyContribution', annualReturnPct: 50 }, dir: 'TOWARD' },
    { name: 'return × investments', a: { solveFor: 'annualReturnPct', measure: 'investments' }, dir: 'TOWARD' },
    { name: 'return × CASH', a: { solveFor: 'annualReturnPct', measure: 'liquid' }, dir: 'NONE' },
    { name: 'spending cut (invested) × investments', a: { solveFor: 'monthlySpendingCut', measure: 'investments' }, dir: 'TOWARD' },
    { name: 'one-line cut × CASH', a: { solveFor: 'spendingChange', measure: 'liquid', spendingChangeToSolve: { category: 'Dining', unit: 'percent' } }, dir: 'TOWARD' },
  ];
  for (const c of cases) {
    const base = await seek({ ...c.a, target: 1, by: DEC31 });
    const far = await seek({ ...c.a, target: Math.round(base.baseline.reached + 10_000_000), by: DEC31 });
    const okDir = far.leverDirection === c.dir;
    // TOWARD may still solve (a contribution's search bound scales with the target); it must never be called
    // INFEASIBLE by a SEARCH bound. AWAY and NONE are INFEASIBLE, with every evaluation having succeeded.
    const okOutcome = c.dir === 'TOWARD' ? ['OUT_OF_RANGE', 'SOLVED', 'INFEASIBLE'].includes(far.outcome)
      && (far.outcome !== 'INFEASIBLE' || far.searchRange?.note !== 'a value outside this range is reported as out of range, never clamped')
      : far.outcome === 'INFEASIBLE';
    const okWords = c.dir === 'TOWARD' || !/larger value might reach it/.test(far.reason ?? '');
    check(`${c.name}: direction ${c.dir}, ${c.dir === 'TOWARD' ? 'solved or a search miss' : 'INFEASIBLE'}${c.dir === 'AWAY' ? ', closest at 0' : ''}`,
      okDir && okOutcome && okWords && (c.dir !== 'AWAY' || far.bestAt === 0),
      JSON.stringify({ dir: far.leverDirection, o: far.outcome, bestAt: far.bestAt, reason: far.reason }).slice(0, 300));
  }
  const cash = await seek({ solveFor: 'monthlyContribution', measure: 'liquid', target: 40_000, by: DEC31 });
  check('the reproduced case: a cash target via a contribution is INFEASIBLE, AWAY, and says why',
    cash.outcome === 'INFEASIBLE' && cash.leverDirection === 'AWAY' && /AWAY/.test(cash.meaning) && !/larger value might/.test(cash.reason),
    JSON.stringify({ o: cash.outcome, r: cash.reason }).slice(0, 300));

  console.log(failures === 0 ? '\nall goal-seek truthfulness checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
