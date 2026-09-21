/**
 * lib/ai/conversation/spending-goal-seek.test.ts — S1-7
 *
 * Goal seek over spending, through the real tool on fixture data:
 *   1. `monthlySpendingCut` is an aggregate DELTA rule — a zero cut IS the baseline,
 *      and the solved rule is in the roster at the answer;
 *   2. stated category rules SURVIVE a total-spending solve;
 *   3. `solveFor: spendingChange` — one line, percent or monthly, bounded by the
 *      line, monotone, the ledger at the answer reaching the target;
 *   4. an impossible goal says how far the whole line got;
 *   5. refusals: a subset word, a missing spec, a collision with a stated rule;
 *   6. the derived floor at the answer follows the solved cut; a debt target works.
 *
 * Standalone tsx script. No DB, no network, no model.
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

import type { CashSpineReads, ToolContext } from './tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});
const cents = (a: number, b: number) => Math.abs(a - b) < 0.011;
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ASOF = '2026-09-21';
const HORIZON = '2027-12-31';

async function fixtureReads(withDebt: boolean): Promise<CashSpineReads> {
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  const pays: string[] = [];
  for (let d = Date.parse('2026-03-27T00:00:00Z'); d <= Date.parse('2026-09-18T00:00:00Z'); d += 14 * 86_400_000) {
    pays.push(new Date(d).toISOString().slice(0, 10));
  }
  const incomeRows = pays.map((date, i) => ({ id: `pay${i}`, date, amount: 3_000, merchant: 'ACME PAYROLL',
    merchantDisplayName: 'ACME PAYROLL', accountId: 'chk', flowType: 'INCOME' }));
  const rows: Rec[] = [];
  for (const m of ['2026-06', '2026-07', '2026-08']) {
    rows.push({ id: `${m}a`, date: new Date(`${m}-05T12:00:00Z`), amount: -1_500, currency: 'USD', category: 'Dining', flowType: 'SPENDING' });
    rows.push({ id: `${m}b`, date: new Date(`${m}-10T12:00:00Z`), amount: -800, currency: 'USD', category: 'Utilities', flowType: 'SPENDING' });
    rows.push({ id: `${m}c`, date: new Date(`${m}-15T12:00:00Z`), amount: -1_600, currency: 'USD', category: 'Shopping', flowType: 'SPENDING' });
  }
  for (const r of incomeRows) rows.push({ id: r.id, date: new Date(`${r.date}T12:00:00Z`), amount: r.amount, currency: 'USD', category: 'Income', flowType: 'INCOME' });
  const monthlyBreakdown = buildMonthlyBreakdown(rows as never, [], '2026-06-01', ASOF, null);
  return {
    incomeTransactions: (async () => ({ rows: incomeRows, nextCursor: null })) as never,
    incomeAccountTypes: async (ids) => ids.map((id) => ({ id, type: 'checking' })),
    accounts: async () => ({
      totalLiquid: 20_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 70_000,
      totalLiabilities: withDebt ? 30_000 : 0, netWorth: withDebt ? 40_000 : 70_000, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: withDebt ? 1 : 0 },
      accounts: withDebt
        ? [{ id: 'card1', name: 'Card A', type: 'debt', visibilityLevel: 'FULL', balance: -30_000, amountOwed: 30_000, apr: 24, minimumPayment: 600 }]
        : [],
    }) as never,
    transactionsSummary: async () => ({ monthlyBreakdown, startDate: '2026-06-01', endDate: ASOF,
      windowDays: 112, transactionCount: rows.length, truncated: false }) as never,
  };
}

async function main(): Promise<void> {
  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const readsPlain = await fixtureReads(false);
  const readsDebt = await fixtureReads(true);
  const ctx = (reads: CashSpineReads): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, cashSpineReads: reads,
    plan: { pending: emptyPlan(), scenarioRan: false } });
  const run = async (tool: string, args: Rec, reads = readsPlain): Promise<Rec> => (await findTool(tool)!.run(args, ctx(reads))) as Rec;
  const end = (r: Rec) => (r.checkpoints as Rec[]).find((c) => c.date === HORIZON)!;
  const base = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0 });
  const baseNW = end(base).netWorth.amount;

  // ── 1. monthlySpendingCut = an aggregate DELTA ───────────────────────────
  console.log('1. the total-spending cut is a rule on top of the scenario');
  const already = await run('scenario_goal_seek', { target: Math.floor(baseNW) - 1, by: HORIZON, solveFor: 'monthlySpendingCut', annualReturnPct: 0 });
  check('a zero cut IS the baseline: a target just under it is already met at 0', already.feasible === true && already.alreadyMet === true
    && already.required === 0 && cents(already.baseline.reached, baseNW), JSON.stringify(already).slice(0, 200));
  const gs = await run('scenario_goal_seek', { target: Math.round(baseNW + 6_000), by: HORIZON, solveFor: 'monthlySpendingCut', annualReturnPct: 0 });
  const solvedRule = (gs.scenario?.assumptions?.clauses?.spendingChange?.rules ?? []).find((x: Rec) => x.id === 'solved');
  check('feasible, and the ledger AT the answer carries the solved rule: DELTA on all spending, 3,900 → 3,900 − required',
    gs.feasible === true && solvedRule?.op === 'DELTA' && solvedRule.of === 'all spending'
      && cents(solvedRule.monthlyAfter, 3_900 - gs.required), JSON.stringify(solvedRule));
  check('…and reaches the target', end(gs.scenario).netWorth.amount >= Math.round(baseNW + 6_000) - 0.5);

  // ── 2. stated category rules survive a total solve ───────────────────────
  console.log('2. a total-spending solve keeps every stated spending change');
  const CUT = { category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 0.8 };
  const withCut = await run('scenario_goal_seek', { target: Math.round(baseNW + 9_000), by: HORIZON, solveFor: 'monthlySpendingCut',
    annualReturnPct: 0, spendingChanges: [CUT] });
  const rules = withCut.scenario?.assumptions?.clauses?.spendingChange?.rules ?? [];
  check('the roster at the answer lists BOTH the Dining cut (s1) and the solved cut',
    rules.some((x: Rec) => x.id === 's1' && x.of === 'Dining') && rules.some((x: Rec) => x.id === 'solved'), JSON.stringify(rules.map((x: Rec) => x.id)));
  check('…so less needs solving than without the Dining cut',
    withCut.feasible === true && gs.feasible === true && withCut.baseline.reached > gs.baseline.reached);

  // ── 3. one line, percent and monthly ─────────────────────────────────────
  console.log('3. how much to cut ONE line');
  const pct = await run('scenario_goal_seek', { target: Math.round(baseNW + 3_000), by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Dining', unit: 'percent', from: '2027-01-01' }, annualReturnPct: 0 });
  const pRule = (pct.scenario?.assumptions?.clauses?.spendingChange?.rules ?? [])[0];
  // 3,000 over 365 days at 365/12 ⇒ 250/month off a 1,500 line ⇒ 16.67%.
  check('Dining, percent: ~16.67% (250 of 1,500 a month for 2027), within the solver precision',
    pct.feasible === true && Math.abs(pct.required - 100 * 250 / 1_500) < 0.01, `${pct.required}`);
  check('the ledger at the answer runs the solved rule: Dining 1,500 → ~1,250, and reaches the target',
    pRule?.of === 'Dining' && pRule.op === 'SCALE' && Math.abs(pRule.monthlyAfter - 1_250) < 0.5
      && end(pct.scenario).netWorth.amount >= Math.round(baseNW + 3_000) - 0.5, JSON.stringify(pRule));
  check('the range is bounded by the line (0–100%) and names it', pct.searchRange.to === 100 && pct.solving?.lineMonthly === 1_500);
  const mon = await run('scenario_goal_seek', { target: Math.round(baseNW + 3_000), by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Dining', unit: 'monthly', from: '2027-01-01' }, annualReturnPct: 0 });
  // The target is rounded to a whole dollar, which moves the exact answer by < 0.05/month.
  check('Dining, monthly: ~250 a month, bounded by the 1,500 line', mon.feasible === true && Math.abs(mon.required - 250) < 0.05
    && mon.searchRange.to === 1_500, `${mon.required}`);
  // Monotonicity on the real tool: more cut ⇒ never less net worth.
  const grid = [0, 10, 25, 50, 75, 100];
  const nws: number[] = [];
  for (const p of grid) {
    const r = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0,
      ...(p > 0 ? { spendingChanges: [{ category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 1 - p / 100 }] } : {}) });
    nws.push(end(r).netWorth.amount);
  }
  check('monotone: net worth never falls as the cut deepens (0 → 100%)', nws.every((v, i) => i === 0 || v >= nws[i - 1] - 1e-9), nws.join(', '));

  // ── 4. impossible ────────────────────────────────────────────────────────
  console.log('4. an impossible goal says how far the whole line got');
  const imp = await run('scenario_goal_seek', { target: Math.round(baseNW + 100_000), by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Dining', unit: 'percent' }, annualReturnPct: 0 });
  check('feasible: false, best reached at cutting ALL of Dining (100%)', imp.feasible === false && imp.bestAt === 100
    && typeof imp.bestReached === 'number' && imp.bestReached < Math.round(baseNW + 100_000), JSON.stringify(imp).slice(0, 240));

  // ── 5. refusals ──────────────────────────────────────────────────────────
  console.log('5. refused, with the reason');
  const rest = await run('scenario_goal_seek', { target: baseNW + 1_000, by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'restaurants', unit: 'percent' } });
  check('"restaurants": refused, Dining offered as a whole', /Dining AS A WHOLE/.test(String(rest.unavailable)));
  const none = await run('scenario_goal_seek', { target: baseNW + 1_000, by: HORIZON, solveFor: 'spendingChange' });
  check('no `spendingChangeToSolve`: refused, and says what is needed', /spendingChangeToSolve/.test(String(none.unavailable)));
  const clash = await run('scenario_goal_seek', { target: baseNW + 1_000, by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Dining', unit: 'percent', from: '2027-01-01' }, spendingChanges: [CUT] });
  check('a solve on a line the scenario already changes from the SAME date: refused, not silently doubled',
    /already changes Dining from 2027-01-01/.test(String(clash.unavailable)));

  // ── 6. the floor follows the answer; a debt target ───────────────────────
  console.log('6. the derived floor at the answer, and a debt target');
  const floorGs = await run('scenario_goal_seek', { target: Math.round(baseNW + 3_000), by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Dining', unit: 'monthly', from: '2027-01-01' }, annualReturnPct: 0,
    contributions: [{ liquidFloorMonthsOfExpenses: 3, fractionOfExcess: 1 }] });
  const keep = floorGs.scenario?.assumptions?.clauses?.cashFloor?.keep;
  check('3 months at 3,900 until the cut, then 3 × (3,900 − solved) after it',
    Array.isArray(keep) && keep[0] === 11_700 && Math.abs(keep[1] - 3 * (3_900 - floorGs.required)) < 0.05, JSON.stringify(keep));
  const debt = await run('scenario_goal_seek', { target: 0, by: '2027-06-30', measure: 'debt', solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Shopping', unit: 'monthly' }, annualReturnPct: 0,
    contributions: [{ liquidFloor: 20_000, fractionOfExcess: 1, target: ['highest_apr'] }] }, readsDebt);
  const debtEnd = (debt.scenario?.checkpoints as Rec[] | undefined)?.find((c) => c.date === '2027-06-30');
  // 30,000 at 24% against a ~2,600/month surplus over nine months: not payable without a cut.
  check('debt-free by June 2027 needs a real Shopping cut, bounded by the line; the ledger at the answer shows debt ≤ 0.50',
    debt.feasible === true && !debt.alreadyMet && debt.required > 0 && debt.required <= 1_600 && (debtEnd?.debt.amount ?? 1) <= 0.5,
    `${debt.feasible} ${debt.required} ${debtEnd?.debt.amount} ${String(debt.reason ?? '')}`);
  check('…and the solved Shopping rule is in the roster at the answer',
    (debt.scenario?.assumptions?.clauses?.spendingChange?.rules ?? []).some((x: Rec) => x.id === 'solved' && x.of === 'Shopping'));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall spending goal-seek checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
