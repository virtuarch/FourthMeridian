/**
 * lib/ai/conversation/interest-once.test.ts — S1-N1
 *
 * INTEREST IS COUNTED ONCE. The spending rate averages every cost flow, and
 * interest charged on a card's carried balance is one; the scenario ledger (L1)
 * ALSO accrues interest on that card from its balance and rate. Without this, a
 * scenario charged the same interest twice — once as history repeated inside
 * ordinary spending, once as the balance's own accrual.
 *
 * The attribution path, pinned end to end on the real tools:
 *
 *   historical INTEREST row → `financialAccountId` → the monthly breakdown's
 *   `interestByAccount` → a liability line the ledger accrues at a KNOWN rate
 *   → left out of the scenario's spending rate, disclosed as `interestLeftOut`.
 *
 * And what must NOT happen:
 *   · interest on a liability the ledger does not accrue (no rate) stays;
 *   · interest with no account (unattributable) stays;
 *   · `project_cash` — no liability model — keeps every cost flow.
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

async function fixtureReads(): Promise<{ reads: CashSpineReads; monthlyBreakdown: Rec[] }> {
  const { buildMonthlyBreakdown } = await import('@/lib/ai/assemblers/transactions');
  const pays: string[] = [];
  for (let d = Date.parse('2026-03-27T00:00:00Z'); d <= Date.parse('2026-09-18T00:00:00Z'); d += 14 * 86_400_000) {
    pays.push(new Date(d).toISOString().slice(0, 10));
  }
  const incomeRows = pays.map((date, i) => ({ id: `pay${i}`, date, amount: 3_000, merchant: 'ACME PAYROLL',
    merchantDisplayName: 'ACME PAYROLL', accountId: 'chk', flowType: 'INCOME' }));
  // $4,000 gross spending a month, a $300 refund in August ⇒ 3,900 net over Jun–Aug.
  // PLUS interest every month: $120 on card1 (rate known ⇒ the ledger accrues it),
  // $30 on card2 (no rate ⇒ unmodelled), $10 on no account (unattributable).
  const rows: Rec[] = [];
  for (const m of ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) {
    rows.push({ id: `${m}a`, date: new Date(`${m}-05T12:00:00Z`), amount: -1_500, currency: 'USD', category: 'Dining', flowType: 'SPENDING' });
    rows.push({ id: `${m}b`, date: new Date(`${m}-10T12:00:00Z`), amount: -800, currency: 'USD', category: 'Utilities', flowType: 'SPENDING' });
    rows.push({ id: `${m}c`, date: new Date(`${m}-15T12:00:00Z`), amount: -1_700, currency: 'USD', category: 'Shopping', flowType: 'SPENDING' });
    rows.push({ id: `${m}i1`, date: new Date(`${m}-21T12:00:00Z`), amount: -120, currency: 'USD', category: 'Interest', flowType: 'INTEREST', financialAccountId: 'card1' });
    rows.push({ id: `${m}i2`, date: new Date(`${m}-21T12:00:00Z`), amount: -30, currency: 'USD', category: 'Interest', flowType: 'INTEREST', financialAccountId: 'card2' });
    rows.push({ id: `${m}i3`, date: new Date(`${m}-22T12:00:00Z`), amount: -10, currency: 'USD', category: 'Interest', flowType: 'INTEREST', financialAccountId: null });
  }
  // A reversal of $20 of card1 interest in August — the fold's own credit side.
  rows.push({ id: 'irev', date: new Date('2026-08-25T12:00:00Z'), amount: 20, currency: 'USD', category: 'Interest', flowType: 'INTEREST', financialAccountId: 'card1' });
  rows.push({ id: 'refund', date: new Date('2026-08-20T12:00:00Z'), amount: 300, currency: 'USD', category: 'Shopping', flowType: 'REFUND' });
  for (const r of incomeRows) rows.push({ id: r.id, date: new Date(`${r.date}T12:00:00Z`), amount: r.amount, currency: 'USD', category: 'Income', flowType: 'INCOME' });
  const monthlyBreakdown = buildMonthlyBreakdown(rows as never, [], '2026-03-01', ASOF, null) as unknown as Rec[];
  const reads: CashSpineReads = {
    incomeTransactions: (async () => ({ rows: incomeRows, nextCursor: null })) as never,
    incomeAccountTypes: async (ids) => ids.map((id) => ({ id, type: 'checking' })),
    accounts: async () => ({
      totalLiquid: 20_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 70_000,
      totalLiabilities: 9_000, netWorth: 61_000, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 2 },
      accounts: [
        { id: 'card1', name: 'Card A', type: 'debt', visibilityLevel: 'FULL', balance: -6_000, amountOwed: 6_000, apr: 24, minimumPayment: 150 },
        { id: 'card2', name: 'Card B', type: 'debt', visibilityLevel: 'FULL', balance: -3_000, amountOwed: 3_000, apr: null, minimumPayment: 60 },
      ],
    }) as never,
    transactionsSummary: async () => ({ monthlyBreakdown, startDate: '2026-03-01', endDate: ASOF,
      windowDays: 205, transactionCount: rows.length, truncated: false }) as never,
  };
  return { reads, monthlyBreakdown };
}

async function main(): Promise<void> {
  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const { withoutModelledInterest } = await import('@/lib/forecast/observed-spending');
  const { reads, monthlyBreakdown } = await fixtureReads();
  const ctx = (): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, cashSpineReads: reads,
    plan: { pending: emptyPlan(), scenarioRan: false } });
  const run = async (tool: string, args: Rec): Promise<Rec> => (await findTool(tool)!.run(args, ctx())) as Rec;
  const at = (r: Rec, date: string) => (r.checkpoints as Rec[]).find((c) => c.date === date)!;

  // ── 1. the attribution path exists in the data ───────────────────────────
  console.log('1. the monthly breakdown attributes interest to the account it posted to');
  const aug = monthlyBreakdown.find((m) => m.month === '2026-08')!;
  check('August: card1 120 charged / 20 reversed, card2 30 charged — and no key for the row with no account',
    JSON.stringify(aug.interestByAccount) === JSON.stringify({ card1: { charges: 120, credits: 20 }, card2: { charges: 30, credits: 0 } }),
    JSON.stringify(aug.interestByAccount));
  check('the attributed charges are INSIDE expenseTotal (4,000 + 160 interest) and the reversal inside refundTotal (300 + 20)',
    aug.expenseTotal === 4_160 && aug.refundTotal === 320, `${aug.expenseTotal} / ${aug.refundTotal}`);
  const plainMonth = (await import('@/lib/ai/assemblers/transactions')).buildMonthlyBreakdown(
    [{ id: 'x', date: new Date('2026-08-05T12:00:00Z'), amount: -10, currency: 'USD', category: 'Dining', flowType: 'SPENDING' }] as never,
    [], '2026-08-01', '2026-08-31', null)[0] as unknown as Rec;
  check('a month without attributable interest carries no new key (payloads byte-identical to before)', !('interestByAccount' in plainMonth));

  // ── 2. the pure exclusion ────────────────────────────────────────────────
  console.log('2. the exclusion takes out only what is attributed to a modelled liability');
  const ex = withoutModelledInterest(monthlyBreakdown as never, ['card1']);
  const exAug = ex.months.find((m) => m.month === '2026-08')!;
  check('card1 only: gross 4,160 → 4,040 and refunds 320 → 300 (the reversal leaves with its charge)',
    exAug.expenseTotal === 4_040 && exAug.refundTotal === 300, `${exAug.expenseTotal} / ${exAug.refundTotal}`);
  check('the record names card1 and nets its reversal: August excluded = 100',
    JSON.stringify(ex.excluded?.accounts) === '["card1"]' && ex.excluded?.months.find((m) => m.month === '2026-08')?.excluded === 100);
  check('no modelled accounts ⇒ the months are returned untouched and nothing is recorded',
    ((r) => r.excluded === null && JSON.stringify(r.months) === JSON.stringify(monthlyBreakdown))(withoutModelledInterest(monthlyBreakdown as never, [])));
  check('an account with no interest history ⇒ nothing recorded',
    withoutModelledInterest(monthlyBreakdown as never, ['card9']).excluded === null);

  // ── 3. project_cash keeps every cost flow ────────────────────────────────
  console.log('3. project_cash has no liability model, so it keeps the interest');
  const pc = await run('project_cash', { to: HORIZON });
  // Jun–Aug net: (4,160−0) (4,160−0) (4,160−320) = 4,160 / 4,160 / 3,840 ⇒ 4,053.33…
  const pcMonthly = (pc.projection?.basis?.spending?.dailyRate ?? NaN) * (365 / 12);
  check('project_cash spends at the full observed rate, every interest row included: (4,160 + 4,160 + 3,840) / 3 = 4,053.33',
    pc.projection?.basis?.spending?.source === 'OBSERVED' && cents(pcMonthly, (4_160 + 4_160 + 3_840) / 3), `${pcMonthly}`);

  // ── 4. the scenario leaves out exactly the modelled liability's interest ──
  console.log('4. the scenario leaves out card1 (rate known) and keeps card2 (no rate) and the unattributed row');
  const FLOOR = { liquidFloorMonthsOfExpenses: 3, fractionOfExcess: 1, target: ['highest_apr', 'investments'] };
  const sc = await run('scenario_projection', { to: HORIZON, contributions: [FLOOR], annualReturnPct: 0 });
  check('the scenario ran', !sc.unavailable, JSON.stringify(sc).slice(0, 200));
  const sp = sc.assumptions.spending;
  // Jun–Aug less card1: 4,040 / 4,040 / (4,040 − 300) = 3,740 ⇒ mean 3,940.
  check('spending = the observed rate less card1\'s interest: (4,040 + 4,040 + 3,740) / 3 = 3,940',
    sp.source === 'OBSERVED' && cents(sp.monthly, 3_940), JSON.stringify(sp));
  check('…and says so: interestLeftOut names card1 only, 120 / 120 / 100 by month',
    JSON.stringify(sp.interestLeftOut?.liabilities) === '["card1"]'
      && JSON.stringify(sp.interestLeftOut?.byMonth.map((m: Rec) => m.amount)) === '[120,120,100]', JSON.stringify(sp.interestLeftOut));
  check('the months-of-expenses floor is derived from the SAME rate (3 × 3,940 = 11,820)',
    sc.assumptions.clauses.cashFloor.keep === 11_820, JSON.stringify(sc.assumptions.clauses.cashFloor));
  check('the ledger accrues card1\'s interest itself — counted once, as the ledger\'s',
    at(sc, HORIZON).movements.interestToDate > 0 && sc.assumptions.liabilities.interestBasis === 'PARTIAL');

  // ── 5. conservation: the spine moves by exactly the interest left out ─────
  console.log('5. conservation');
  const bare = await run('scenario_projection', { to: HORIZON, contributions: [], annualReturnPct: 0, outflows: [] });
  const noFlows = at(bare, HORIZON);
  const pcEnd = pc.projection.endingCash as number;
  // No contributions and no allocations ⇒ ledger liquid = spine − minimums.
  const spineEnd = noFlows.liquid.amount + noFlows.movements.minimumPaymentsToDate;
  const days = Math.round((Date.parse(`${HORIZON}T00:00:00Z`) - Date.parse(`${ASOF}T00:00:00Z`)) / 86_400_000);
  const leftOutMonthly = (120 + 120 + 100) / 3;
  check(`the scenario spine ends higher than project_cash by exactly the interest left out, accrued: ${leftOutMonthly.toFixed(4)}/month × ${days} days`,
    cents(spineEnd - pcEnd, leftOutMonthly / (365 / 12) * days), `${spineEnd} − ${pcEnd} = ${spineEnd - pcEnd}`);

  // ── 6. a stated rate brings a liability into the model — and its interest out ─
  console.log('6. a liability the user gives a rate becomes modelled, and only then leaves the rate');
  const withB = await run('scenario_projection', { to: HORIZON, contributions: [FLOOR], annualReturnPct: 0,
    liabilityAssumptions: [{ liabilityId: 'card2', apr: 18 }] });
  const spB = withB.assumptions.spending;
  check('card2 at 18%: both cards\' interest leaves the rate (3,940 − 30 = 3,910) and the basis is COMPLETE',
    cents(spB.monthly, 3_910) && JSON.stringify(spB.interestLeftOut.liabilities) === '["card1","card2"]'
      && withB.assumptions.liabilities.interestBasis === 'COMPLETE', JSON.stringify(spB));
  check('the unattributable $10 a month is never left out — nothing else models it',
    spB.interestLeftOut.byMonth.every((m: Rec) => m.amount === 150 || m.amount === 130));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall interest-once checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
