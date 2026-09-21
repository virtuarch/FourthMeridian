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

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall scenario composition checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
