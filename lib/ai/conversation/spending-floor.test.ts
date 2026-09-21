/**
 * lib/ai/conversation/spending-floor.test.ts — S1-5
 *
 * A DERIVED floor follows the spending in force on each movement's date; an
 * ABSOLUTE floor does not move. Through the real scenario tools on fixture data:
 *
 *   "keep nine months of expenses" = 9 × monthlyRateAt(movement date)
 *
 * before a January Dining cut, after it, and — for a temporary cut — after it ends.
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

async function fixtureReads(): Promise<CashSpineReads> {
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  const pays: string[] = [];
  for (let d = Date.parse('2026-03-27T00:00:00Z'); d <= Date.parse('2026-09-18T00:00:00Z'); d += 14 * 86_400_000) {
    pays.push(new Date(d).toISOString().slice(0, 10));
  }
  const incomeRows = pays.map((date, i) => ({ id: `pay${i}`, date, amount: 3_000, merchant: 'ACME PAYROLL',
    merchantDisplayName: 'ACME PAYROLL', accountId: 'chk', flowType: 'INCOME' }));
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
      totalLiquid: 60_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 110_000,
      totalLiabilities: 0, netWorth: 110_000, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 0 }, accounts: [],
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
  const floorAt = (r: Rec, date: string) => (r.assumptions.contributions.settled as Rec[]).find((m) => m.date === date)?.liquidFloor;
  const NINE = { liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1 };
  const CUT = { category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 0.8 };

  // ── 1. no spending change: the floor is what it always was ───────────────
  console.log('1. without a spending change the derived floor is unchanged');
  const plain = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0, contributions: [NINE] });
  const pf = plain.assumptions.clauses.cashFloor;
  check('one level, 9 × 3,900 = 35,100, MEASURED, and no date qualifier', pf.keep === 35_100
    && !Array.isArray(pf.statedAs) && pf.statedAs.atMonthlySpending === 3_900 && pf.statedAs.from === undefined, JSON.stringify(pf));

  // ── 2. before and after the cut ──────────────────────────────────────────
  console.log('2. 9 × the rate in force on each floor movement\'s date');
  const cut = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0, contributions: [NINE], spendingChanges: [CUT] });
  check('December 2026 (before the cut): 9 × 3,900 = 35,100', floorAt(cut, '2026-12-31') === 35_100, String(floorAt(cut, '2026-12-31')));
  check('January 2027 (after the cut): 9 × 3,600 = 32,400', floorAt(cut, '2027-01-31') === 32_400, String(floorAt(cut, '2027-01-31')));
  const cf = cut.assumptions.clauses.cashFloor;
  check('the roster keeps BOTH levels, each with the date it takes over and the spending it multiplied',
    JSON.stringify(cf.keep) === '[35100,32400]' && Array.isArray(cf.statedAs)
      && cf.statedAs[1].atMonthlySpending === 3_600 && cf.statedAs[1].from === '2027-01-31', JSON.stringify(cf));
  // At 0% a floor only moves cash into investments, so ΔNW is the spending removed, exactly.
  check('conservation: at 0%, ΔNW = the spending removed (3,600), the floor moving only between lines',
    cents(at(cut, HORIZON).netWorth.amount - at(plain, HORIZON).netWorth.amount, 3_600));

  // ── 3. a temporary cut: the floor comes back ─────────────────────────────
  console.log('3. a temporary cut raises the floor again when it ends');
  const temp = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0, contributions: [NINE],
    spendingChanges: [{ ...CUT, to: '2027-03-31' }] });
  check('March 32,400, April back to 35,100', floorAt(temp, '2027-03-31') === 32_400 && floorAt(temp, '2027-04-30') === 35_100,
    `${floorAt(temp, '2027-03-31')} / ${floorAt(temp, '2027-04-30')}`);

  // ── 4. an absolute floor does not move ───────────────────────────────────
  console.log('4. an ABSOLUTE floor is not a function of spending');
  const ABS = { liquidFloor: 50_000, fractionOfExcess: 1 };
  const absPlain = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0, contributions: [ABS] });
  const absCut = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0, contributions: [ABS], spendingChanges: [CUT] });
  check('keep 50,000 before and after the cut, identical rosters',
    absCut.assumptions.clauses.cashFloor.keep === 50_000 && floorAt(absCut, '2027-01-31') === 50_000
      && JSON.stringify(absCut.assumptions.clauses.cashFloor.statedAs) === JSON.stringify(absPlain.assumptions.clauses.cashFloor.statedAs));
  check('…and the cash the cut frees goes above the floor into investments (ΔNW 3,600)',
    cents(at(absCut, HORIZON).netWorth.amount - at(absPlain, HORIZON).netWorth.amount, 3_600));

  // ── 5. the floor logic is not duplicated ─────────────────────────────────
  console.log('5. one floor resolver');
  const src = (await import('node:fs')).readFileSync('lib/ai/conversation/tools.ts', 'utf8');
  check('both rebinds resolve through ONE helper that calls the canonical resolver',
    (src.match(/resolveMonthsOfExpensesFloor\(/g) ?? []).length === 2
      && /function resolveFloorAt\(/.test(src) && (src.match(/resolveFloorAt\(n, /g) ?? []).length === 2);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall spending-floor checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
