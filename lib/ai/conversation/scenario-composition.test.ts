/**
 * lib/ai/conversation/scenario-composition.test.ts — FM-AUDIT-010 (+ 008/009/011 in composition)
 *
 * THE COMPOSITIONAL SCENARIO CONTRACT, IN CI.
 *
 * Every primitive below has its own unit suite. What had NO executable pin was
 * whether they COMPOSE through the canonical path — the audit found the
 * composition proven only by a manual clone-database script. This suite drives
 * the REAL production tools (`scenario_projection`, `scenario_goal_seek`,
 * `project_cash`) end to end — argument merging, the M1 months-of-expenses floor,
 * liability lines from the accounts payload, I1 income rules inside the spine
 * closure, the one cash projection (`assembleForecast`), the ledger, the
 * highest-APR → investments waterfall, a one-off outflow, the goal seek — on
 * FIXTURE DATA supplied at the data boundary (`ToolContext.cashSpineReads`):
 * raw income transactions resolved by the real stream resolver, and a monthly
 * breakdown produced by the real assembler fold. Nothing downstream is stubbed.
 *
 * It asserts contracts, never prose:
 *   A. execution roster — every clause ran, and says so (I1, M1 floor, L1 waterfall);
 *   B. the scenario spine IS the one cash projection — reconstructed from the
 *      ledger it equals a standalone project_cash to the cent;
 *   C. conservation — at 0% return, the net-worth effect of the raise equals the
 *      extra income the I1 rule reports, to the cent, after it flowed through the
 *      floor sweep, the debt waterfall and into investments;
 *   D. mutation / rerun — a restated spending level recomputes the result AND the
 *      derived floor (no stale dependency);
 *   E. obligations in composition — one minimum per month despite a mid-month
 *      outflow on the spine (FM-AUDIT-009);
 *   F. goal seek — a spending-cut solve holds the floor re-resolved at the SOLVED
 *      spending (FM-AUDIT-011), and the ledger at the answer reaches the target.
 *   G. S1 in the whole composition — a category spending change beside I1, L1, M1,
 *      a one-off outflow, the waterfall, investment allocation and a goal seek:
 *      roster, one forecast path, one minimum a month, the category delta, the
 *      floor stepping at the cut (and a dollar floor not), a 0% net-worth identity,
 *      a solved rule that reruns to the cent, a changed cut that recomputes, and
 *      the real composed envelope sealing whole beside a staged plan.
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
const HORIZON = '2028-12-31';

async function fixtureReads(): Promise<CashSpineReads> {
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  // Biweekly payroll of $3,000 into checking, settled through 2026-09-18.
  const pays: string[] = [];
  for (let d = Date.parse('2026-03-27T00:00:00Z'); d <= Date.parse('2026-09-18T00:00:00Z'); d += 14 * 86_400_000) {
    pays.push(new Date(d).toISOString().slice(0, 10));
  }
  const incomeRows = pays.map((date, i) => ({ id: `pay${i}`, date, amount: 3_000, merchant: 'ACME PAYROLL',
    merchantDisplayName: 'ACME PAYROLL', accountId: 'chk', flowType: 'INCOME' }));
  // Six complete months of spending ($4,000 gross), one $300 refund in August ⇒ the
  // last three months are 4,000 / 4,000 / 3,700 NET ⇒ a measured rate of 3,900.
  const rows: Rec[] = [];
  for (const m of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) {
    rows.push({ id: `${m}a`, date: new Date(`${m}-05T12:00:00Z`), amount: -1_500, currency: 'USD', category: 'Dining', flowType: 'SPENDING' });
    rows.push({ id: `${m}b`, date: new Date(`${m}-10T12:00:00Z`), amount: -800, currency: 'USD', category: 'Utilities', flowType: 'SPENDING' });
    rows.push({ id: `${m}c`, date: new Date(`${m}-15T12:00:00Z`), amount: -1_700, currency: 'USD', category: 'Shopping', flowType: 'SPENDING' });
  }
  rows.push({ id: 'refund', date: new Date('2026-08-20T12:00:00Z'), amount: 300, currency: 'USD', category: 'Shopping', flowType: 'REFUND' });
  for (const r of incomeRows) rows.push({ id: r.id, date: new Date(`${r.date}T12:00:00Z`), amount: r.amount, currency: 'USD', category: 'Income', flowType: 'INCOME' });
  const monthlyBreakdown = buildMonthlyBreakdown(rows as never, [], '2026-03-01', ASOF, null);
  return {
    incomeTransactions: (async () => ({ rows: incomeRows, nextCursor: null })) as never,
    incomeAccountTypes: async (ids) => ids.map((id) => ({ id, type: 'checking' })),
    accounts: async () => ({
      totalLiquid: 20_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 70_000,
      totalLiabilities: 9_000, netWorth: 61_000, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 2 },
      accounts: [
        { id: 'card1', name: 'Card A', type: 'debt', visibilityLevel: 'FULL', balance: -6_000, amountOwed: 6_000, apr: 24, minimumPayment: 150 },
        { id: 'card2', name: 'Card B', type: 'debt', visibilityLevel: 'FULL', balance: -3_000, amountOwed: 3_000, apr: 9, minimumPayment: 60 },
      ],
    }) as never,
    transactionsSummary: async () => ({ monthlyBreakdown, startDate: '2026-03-01', endDate: ASOF,
      windowDays: 205, transactionCount: rows.length, truncated: false }) as never,
  };
}

async function main(): Promise<void> {
  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const reads = await fixtureReads();
  const ctx = (): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, cashSpineReads: reads,
    plan: { pending: emptyPlan(), scenarioRan: false } });
  const run = async (tool: string, args: Rec): Promise<Rec> => (await findTool(tool)!.run(args, ctx())) as Rec;
  const at = (r: Rec, date: string) => (r.checkpoints as Rec[]).find((c) => c.date === date)!;
  const FLOOR_TO_DEBT_THEN_INVEST = { liquidFloorMonthsOfExpenses: 3, fractionOfExcess: 1, target: ['highest_apr', 'investments'] };
  const RAISE = { op: 'SCALE', from: '2027-01-01', multiplier: 1.1 };

  // ── A. roster ────────────────────────────────────────────────────────────
  console.log('A. every primitive ran, and the roster says so');
  const full = await run('scenario_projection', { to: HORIZON, incomeChanges: [RAISE],
    contributions: [FLOOR_TO_DEBT_THEN_INVEST], outflows: [{ onDate: '2027-06-15', amount: 5_000, label: 'car deposit' }],
    annualReturnPct: 0 });
  check('the scenario ran (no refusal)', !full.unavailable, JSON.stringify(full).slice(0, 200));
  const clauses = full.assumptions?.clauses ?? {};
  check('I1: the income rule RAN and changed pay dates', clauses.incomeChange?.ran === true && clauses.incomeChange.rules[0].payDatesChanged > 0);
  check('M1: the floor RAN as 3 months of the MEASURED net spending (3 × 3,900 = 11,700)',
    clauses.cashFloor?.ran === true && clauses.cashFloor.keep === 11_700 && clauses.cashFloor.statedAs?.monthsOfExpenses === 3
      && clauses.cashFloor.statedAs?.atMonthlySpending === 3_900 && clauses.cashFloor.statedAs?.spendingBasis === 'MEASURED',
    JSON.stringify(clauses.cashFloor));
  check('L1: the excess paid the highest APR first, then investments', clauses.debtPaydown?.ran === true
    && JSON.stringify(clauses.debtPaydown.order) === JSON.stringify(['highest_apr', 'investments']) && clauses.debtPaydown.paidToDebt > 0);
  const firstSweep = (full.assumptions.contributions.settled as Rec[])[0];
  check('…and in THAT order on the first sweep: card A (24%) before card B (9%) before investments',
    firstSweep.placed.liabilities[0].id === 'card1' && firstSweep.placed.liabilities[1].id === 'card2' && firstSweep.placed.investments > 0);
  check('the one-off outflow ran', at(full, HORIZON).movements.outflowsToDate.total === 5_000);
  check('the opening reconciles with the accounts payload', full.reconciliation?.difference === 0);

  // ── B. the scenario spine IS the one cash projection ─────────────────────
  console.log('B. the scenario spine is the one cash projection');
  const plain = await run('scenario_projection', { to: HORIZON, contributions: [FLOOR_TO_DEBT_THEN_INVEST], annualReturnPct: 0 });
  const pc = await run('project_cash', { to: HORIZON });
  const end = at(plain, HORIZON);
  const spineFromLedger = end.liquid.amount + end.movements.contributionsToDate.total
    + end.movements.outflowsToDate.total + end.movements.minimumPaymentsToDate;
  check('ledger liquid + Σcontributions + Σoutflows + Σminimums at the horizon === project_cash endingCash (same data, one runTo)',
    typeof pc.projection?.endingCash === 'number' && cents(spineFromLedger, pc.projection.endingCash),
    `${spineFromLedger} vs ${pc.projection?.endingCash}`);

  // ── C. conservation ──────────────────────────────────────────────────────
  console.log('C. conservation through the whole composition');
  const rule = clauses.incomeChange.rules[0];
  const extraIncome = rule.incomeAfter - rule.incomeBefore;
  const noRaise = await run('scenario_projection', { to: HORIZON, contributions: [FLOOR_TO_DEBT_THEN_INVEST],
    outflows: [{ onDate: '2027-06-15', amount: 5_000, label: 'car deposit' }], annualReturnPct: 0 });
  const dNW = at(full, HORIZON).netWorth.amount - at(noRaise, HORIZON).netWorth.amount;
  const dInterest = at(full, HORIZON).movements.interestToDate - at(noRaise, HORIZON).movements.interestToDate;
  check(`at 0%, the raise moves net worth by EXACTLY the extra income the rule reports (${extraIncome}), net of any interest change`,
    extraIncome > 0 && cents(dNW, extraIncome - dInterest), `ΔNW ${dNW} extra ${extraIncome} Δinterest ${dInterest}`);
  const e = at(full, HORIZON);
  check('net-worth identity at the horizon: liquid + investments + other − debt',
    cents(e.netWorth.amount, e.liquid.amount + e.investments.amount + e.otherAssets.amount - e.debt.amount));

  // ── D. mutation / rerun ──────────────────────────────────────────────────
  console.log('D. a changed assumption recomputes everything that depends on it');
  const restated = await run('scenario_projection', { to: HORIZON, incomeChanges: [RAISE],
    contributions: [FLOOR_TO_DEBT_THEN_INVEST], outflows: [{ onDate: '2027-06-15', amount: 5_000, label: 'car deposit' }],
    annualReturnPct: 0, assumedMonthlySpending: 3_000 });
  const rc = restated.assumptions.clauses.cashFloor;
  check('the derived floor follows the restated spending: 3 × 3,000 = 9,000, basis STATED',
    rc.keep === 9_000 && rc.statedAs.atMonthlySpending === 3_000 && rc.statedAs.spendingBasis === 'STATED', JSON.stringify(rc));
  // The spine difference comes from the ONE cash projection, not from arithmetic
  // here: two standalone project_cash runs at the two spending levels.
  const pcBase = await run('project_cash', { to: HORIZON });
  const pcLow = await run('project_cash', { to: HORIZON, assumedMonthlySpending: 3_000 });
  const dSpine = pcLow.projection.endingCash - pcBase.projection.endingCash;
  const dRerun = at(restated, HORIZON).netWorth.amount - at(full, HORIZON).netWorth.amount;
  const dInt = at(full, HORIZON).movements.interestToDate - at(restated, HORIZON).movements.interestToDate;
  check('the result recomputes by exactly the projection\'s own spending difference (net of interest saved by the lower floor)',
    dSpine > 0 && cents(dRerun, dSpine + dInt), `ΔNW ${dRerun} Δspine ${dSpine} Δinterest ${dInt}`);
  const again = await run('scenario_projection', { to: HORIZON, incomeChanges: [RAISE],
    contributions: [FLOOR_TO_DEBT_THEN_INVEST], outflows: [{ onDate: '2027-06-15', amount: 5_000, label: 'car deposit' }], annualReturnPct: 0 });
  check('re-running the original arguments reproduces the original to the cent (no state carried between runs)',
    cents(at(again, HORIZON).netWorth.amount, at(full, HORIZON).netWorth.amount));

  // ── E. obligations in composition ────────────────────────────────────────
  console.log('E. one minimum per month, even with a mid-month date on the spine');
  const hold = await run('scenario_projection', { to: '2027-12-31', contributions: [{ amount: 100, from: '2026-10-01', cadence: 'monthly' }],
    outflows: [{ onDate: '2027-06-15', amount: 5_000, label: 'car deposit' }], annualReturnPct: 0 });
  const dec = at(hold, '2027-12-31');
  check('16 obligation months (Sep 2026 … Dec 2027) × $210 = $3,360 — the 06-15 outflow adds no minimum',
    dec.movements.minimumPaymentsToDate === 3_360, `${dec.movements.minimumPaymentsToDate}`);

  // ── F. goal seek ─────────────────────────────────────────────────────────
  console.log('F. a spending-cut solve holds the floor at the SOLVED spending');
  const base = at(full, HORIZON).netWorth.amount;
  const target = Math.round(base + 20_000);
  const gs = await run('scenario_goal_seek', { target, by: HORIZON, solveFor: 'monthlySpendingCut', measure: 'netWorth',
    incomeChanges: [RAISE], contributions: [FLOOR_TO_DEBT_THEN_INVEST], annualReturnPct: 0 });
  check('the solve is feasible', gs.feasible === true, JSON.stringify(gs).slice(0, 240));
  const solvedFloor = gs.scenario?.assumptions?.clauses?.cashFloor;
  const spendingAtAnswer = Math.round((3_900 - (gs.required ?? 0)) * 100) / 100;
  check(`the echoed floor is re-resolved at the solved spending (3 × ${spendingAtAnswer})`,
    solvedFloor && Math.abs(solvedFloor.keep - 3 * spendingAtAnswer) < 0.05 && Math.abs(solvedFloor.statedAs.atMonthlySpending - spendingAtAnswer) < 0.02,
    JSON.stringify(solvedFloor));
  check('…not the uncut 11,700', solvedFloor && solvedFloor.keep < 11_700, `required ${gs.required} alreadyMet ${gs.alreadyMet} floor ${JSON.stringify(solvedFloor)}`);
  const gsEnd = (gs.scenario?.checkpoints as Rec[] | undefined)?.find((c) => c.date === HORIZON);
  check('the ledger AT the answer reaches the target', gsEnd !== undefined && gsEnd.netWorth.amount >= target - 0.5,
    `${gsEnd?.netWorth.amount} vs ${target}`);

  // ── G. S1 in the whole composition ───────────────────────────────────────
  console.log('G. a category spending change composes with everything else');
  const DINING_20 = { category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 0.8 };
  const CAR = { onDate: '2027-06-15', amount: 5_000, label: 'car deposit' };
  const composed = { to: HORIZON, incomeChanges: [RAISE], spendingChanges: [DINING_20],
    contributions: [FLOOR_TO_DEBT_THEN_INVEST], outflows: [CAR], annualReturnPct: 0 };
  const all = await run('scenario_projection', composed);
  const withoutS1 = await run('scenario_projection', { ...composed, spendingChanges: undefined });
  const neither = await run('scenario_projection', { ...composed, spendingChanges: undefined, incomeChanges: undefined });
  const gc = all.assumptions.clauses;
  check('roster: income, spending, floor and debt order all RAN', gc.incomeChange.ran && gc.spendingChange.ran
    && gc.cashFloor.ran && gc.debtPaydown.ran && JSON.stringify(gc.debtPaydown.order) === '["highest_apr","investments"]');
  check('the category delta: Dining 1,500 → 1,200 from 2027-01-01, a whole bucket',
    gc.spendingChange.rules[0].monthlyBefore === 1_500 && gc.spendingChange.rules[0].monthlyAfter === 1_200
      && gc.spendingChange.rules[0].class === 'WHOLE_BUCKET');
  // One forecast path: the spine is additive, so the ledger's reconstructed spine
  // moves by EXACTLY the spending the rule removed — nothing else touched cash.
  const spineOf = (r: Rec) => { const e = at(r, HORIZON);
    return e.liquid.amount + e.movements.contributionsToDate.total + e.movements.outflowsToDate.total + e.movements.minimumPaymentsToDate; };
  const removed = all.assumptions.spending.changes.spendingRemovedToHorizon;
  check(`one forecast path: the reconstructed spine moves by exactly the spending removed (${removed})`,
    cents(spineOf(all) - spineOf(withoutS1), removed) && cents(removed, 300 * 731 / (365 / 12)), `${spineOf(all) - spineOf(withoutS1)} vs ${removed}`);
  const mins = (r: Rec) => at(r, HORIZON).movements.minimumPaymentsToDate as number;
  check('at most one minimum a month per card (28 obligation months × 210 at most), and S1 never adds one',
    mins(withoutS1) <= 28 * 210 && mins(all) <= mins(withoutS1), `${mins(all)} / ${mins(withoutS1)}`);
  check('the derived floor steps at the cut: 3 × 3,900 = 11,700, then 3 × 3,600 = 10,800',
    JSON.stringify(gc.cashFloor.keep) === '[11700,10800]', JSON.stringify(gc.cashFloor.keep));
  const absAll = await run('scenario_projection', { ...composed, contributions: [{ liquidFloor: 11_700, fractionOfExcess: 1, target: ['highest_apr', 'investments'] }] });
  check('…while a DOLLAR floor stays 11,700 with the same cut', absAll.assumptions.clauses.cashFloor.keep === 11_700);
  // The 0% identity: net worth moves by income added + spending removed − extra interest.
  const extra = gc.incomeChange.rules[0].incomeAfter - gc.incomeChange.rules[0].incomeBefore;
  const dNW3 = at(all, HORIZON).netWorth.amount - at(neither, HORIZON).netWorth.amount;
  const dInt3 = at(all, HORIZON).movements.interestToDate - at(neither, HORIZON).movements.interestToDate;
  check(`0% identity: ΔNW = income added (${extra}) + spending removed (${removed}) − Δinterest (${dInt3.toFixed(2)})`,
    cents(dNW3, extra + removed - dInt3), `ΔNW ${dNW3}`);
  const dNW1 = at(all, HORIZON).netWorth.amount - at(withoutS1, HORIZON).netWorth.amount;
  const dInt1 = at(all, HORIZON).movements.interestToDate - at(withoutS1, HORIZON).movements.interestToDate;
  check('…and S1 alone: ΔNW = spending removed − Δinterest (the freed cash paid the cards sooner)',
    cents(dNW1, removed - dInt1) && dInt1 <= 0, `ΔNW ${dNW1} Δint ${dInt1}`);
  check('investment allocation: the freed cash reaches investments by the horizon',
    at(all, HORIZON).investments.amount > at(withoutS1, HORIZON).investments.amount);
  // Goal seek over the composition, and the solved rule re-run as a stated one.
  const tgt = Math.round(at(withoutS1, HORIZON).netWorth.amount + 4_000);
  const gsS1 = await run('scenario_goal_seek', { target: tgt, by: HORIZON, solveFor: 'spendingChange',
    spendingChangeToSolve: { category: 'Dining', unit: 'percent', from: '2027-01-01' },
    incomeChanges: [RAISE], contributions: [FLOOR_TO_DEBT_THEN_INVEST], outflows: [CAR], annualReturnPct: 0 });
  check('goal seek over the whole composition: feasible, within the line', gsS1.feasible === true && gsS1.required > 0 && gsS1.required < 100,
    JSON.stringify(gsS1).slice(0, 200));
  const rerun = await run('scenario_projection', { ...composed,
    spendingChanges: [{ category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 1 - gsS1.required / 100 }] });
  check('the solved rule, re-run as a stated rule, reproduces the ledger at the answer to the cent',
    cents(at(rerun, HORIZON).netWorth.amount, (gsS1.scenario.checkpoints as Rec[]).find((c) => c.date === HORIZON)!.netWorth.amount));
  // A changed assumption recomputes everything downstream of it.
  const ten = await run('scenario_projection', { ...composed, spendingChanges: [{ ...DINING_20, multiplier: 0.9 }] });
  check('"make it 10%": the floor re-derives (11,700 → 11,250) and the result recomputes by the smaller removal',
    JSON.stringify(ten.assumptions.clauses.cashFloor.keep) === '[11700,11250]'
      && cents(ten.assumptions.spending.changes.spendingRemovedToHorizon, removed / 2)
      && at(ten, HORIZON).netWorth.amount < at(all, HORIZON).netWorth.amount);
  // The REAL composed envelope, sealed beside a staged plan.
  const { captureActiveScenario } = await import('./active-scenario');
  const { sealRuntimeStateWithReport, openRuntimeState } = await import('./runtime-state');
  const { IDENTITY, MAX_PENDING_BYTES } = await import('./pending-plan');
  const env = captureActiveScenario('scenario_projection', composed, all);
  const B = { userId: 'cmrrm846r000j7znwsl67gt1a', spaceId: 'cmrrm846r000j7znwsl67gt1g', tail: 'a'.repeat(32) };
  const alone = env.action === 'REPLACE' ? sealRuntimeStateWithReport({ scenario: env.scenario }, B) : null;
  check(`the real I1+S1+L1+M1 envelope seals FULL (${alone?.sealed?.length} of 3,900 chars) and reopens with the S1 rule`,
    alone?.carried === 'FULL' && JSON.stringify((openRuntimeState(alone.sealed, B)?.scenario?.assumptions as Rec)?.spendingChanges) === JSON.stringify([DINING_20]));
  const clause = { id: 'p1', key: 'spendingChanges', value: { category: 'Shopping', op: 'DELTA', from: '2027-03-01', monthly: -500 },
    identity: IDENTITY.spendingChanges({ category: 'Shopping', op: 'DELTA', from: '2027-03-01', monthly: -500 })!, stagedAt: 0 };
  const beside = env.action === 'REPLACE' ? sealRuntimeStateWithReport({ scenario: env.scenario, pending: { v: 1, clauses: [clause], next: 2 } }, B) : null;
  check('…and still FULL beside a staged spending clause', beside?.carried === 'FULL', `${beside?.carried} ${beside?.sealed?.length}`);
  const big = { v: 1 as const, next: 9, clauses: Array.from({ length: 8 }, (_, i) => {
    const value = { category: 'Subscriptions', op: 'SCALE', from: `2027-0${i + 1}-15`, to: `2027-1${i % 3}-28`, multiplier: 0.85 };
    return { id: `p${i + 1}`, key: 'spendingChanges', value, identity: IDENTITY.spendingChanges(value)!, stagedAt: i };
  }) };
  const worst = env.action === 'REPLACE' ? sealRuntimeStateWithReport({ scenario: env.scenario, pending: big }, B) : null;
  check(`beside a FULL staged plan (8 clauses, ${JSON.stringify(big.clauses).length} ≤ ${MAX_PENDING_BYTES} bytes): carried whole or NAMED as lost — never silent`,
    worst?.carried === 'FULL' || (worst?.carried === 'LOST' && worst.loss?.droppedPendingClauses === 8 && worst.loss.droppedScenario === true),
    `${worst?.carried} ${worst?.sealed?.length}`);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall scenario composition checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
