/**
 * lib/ai/conversation/spending-change-tools.test.ts — S1-4
 *
 * `spendingChanges` through the REAL scenario tools, on fixture data at the data
 * boundary (`cashSpineReads`):
 *   1. one shared argument, 20 production tools, a schema generated from the vocabulary;
 *   2. the roster proves the rule ran — which line, what class, from what to what;
 *   3. refusals are whole and visible: a subset word, an unsupported line, Interest;
 *   4. the spine carries it: the ledger's cash moves by exactly the spending removed;
 *   5. the envelope keeps the arguments verbatim and the rule compactly;
 *   6. project_cash refuses the argument and names where it belongs.
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
      totalLiquid: 20_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 70_000,
      totalLiabilities: 0, netWorth: 70_000, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 0 }, accounts: [],
    }) as never,
    transactionsSummary: async () => ({ monthlyBreakdown, startDate: '2026-03-01', endDate: ASOF,
      windowDays: 205, transactionCount: rows.length, truncated: false }) as never,
  };
}

async function main(): Promise<void> {
  const { findTool, TOOLS } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const { SCENARIO_INPUTS } = await import('./scenario-inputs');
  const { transformableCategoryGuide } = await import('@/lib/transactions/category-vocabulary');
  const { captureActiveScenario } = await import('./active-scenario');
  const reads = await fixtureReads();
  const ctx = (): ToolContext => ({ asOfISO: ASOF, spaceId: 'spc', spaceCtx: {} as never, cashSpineReads: reads,
    plan: { pending: emptyPlan(), scenarioRan: false } });
  const run = async (tool: string, args: Rec): Promise<Rec> => (await findTool(tool)!.run(args, ctx())) as Rec;
  const at = (r: Rec, date: string) => (r.checkpoints as Rec[]).find((c) => c.date === date)!;
  const CUT = { category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 0.8 };

  // ── 1. one argument, twenty tools ────────────────────────────────────────
  console.log('1. one shared argument; the tool count is unchanged');
  check('20 production tools', TOOLS.length === 20, String(TOOLS.length));
  for (const t of ['scenario_projection', 'scenario_crossing', 'scenario_goal_seek']) {
    check(`${t} declares \`spendingChanges\``, 'spendingChanges' in (findTool(t)!.parameters as Rec).properties);
  }
  const desc = String((SCENARIO_INPUTS as Rec).spendingChanges.description);
  check('the schema lists EXACTLY the vocabulary\'s transformable lines (generated guide, verbatim)',
    desc.includes(`Lines a change can apply to: ${transformableCategoryGuide()}.`), transformableCategoryGuide());
  check('…and tells the model to pass the user\'s own word, never a broader line',
    /"restaurants" is NOT "Dining"/.test(String((SCENARIO_INPUTS as Rec).spendingChanges.items.properties.category.description)));
  check('incomeChanges no longer says spending cannot be modelled',
    !/cannot be modelled/.test(String((SCENARIO_INPUTS as Rec).incomeChanges.description)));

  // ── 2. the roster ────────────────────────────────────────────────────────
  console.log('2. the roster proves the rule ran');
  const base = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0 });
  const cut = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0, spendingChanges: [CUT] });
  const sc = cut.assumptions?.clauses?.spendingChange;
  check('spendingChange RAN: Dining, WHOLE_BUCKET, 1,500 → 1,200 from 2027-01-01 to the horizon',
    sc?.ran === true && sc.rules[0].of === 'Dining' && sc.rules[0].class === 'WHOLE_BUCKET'
      && sc.rules[0].monthlyBefore === 1_500 && sc.rules[0].monthlyAfter === 1_200
      && sc.rules[0].from === '2027-01-01' && sc.rules[0].to === HORIZON, JSON.stringify(sc));
  check('…with the months its baseline came from, and the whole-bucket notice',
    JSON.stringify(sc.rules[0].baselineMonths) === '["2026-06","2026-07","2026-08"]' && sc.wholeBucket?.rules?.[0] === 's1');
  check('a scenario with no spending rule says NONE in the roster slot', base.assumptions.clauses.spendingChange.ran === false);
  const ch = cut.assumptions.spending.changes;
  check('the spending echo gives the schedule and the total removed (300 × 12 = 3,600)',
    ch?.applied === true && cents(ch.spendingRemovedToHorizon, 3_600)
      && JSON.stringify(ch.monthlyFrom.map((x: Rec) => x.monthly)) === '[3900,3600]', JSON.stringify(ch));

  // ── 3. refusals ──────────────────────────────────────────────────────────
  console.log('3. refused whole, visibly — nothing of a refused rule runs');
  const restaurants = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0,
    spendingChanges: [{ category: 'restaurants', op: 'SCALE', from: '2027-01-01', multiplier: 0.8 }] });
  const na = JSON.stringify(restaurants.assumptions?.notApplied ?? {});
  check('"restaurants" is refused, Dining is OFFERED as a whole, and the rule is named',
    /spendingChanges. rule s1/.test(na) && /Offer the user Dining AS A WHOLE/.test(na) && /groceries/.test(na), na.slice(0, 300));
  check('…and NOTHING ran: the ledger equals the no-rule scenario to the cent, the roster says NONE',
    cents(at(restaurants, HORIZON).netWorth.amount, at(base, HORIZON).netWorth.amount)
      && restaurants.assumptions.clauses.spendingChange.ran === false);
  for (const [word, re] of [['groceries', /Dining AS A WHOLE/], ['Medical', /Other AS A WHOLE/], ['Interest', /model the debt/]] as const) {
    const r = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0,
      spendingChanges: [{ category: word, op: 'SCALE', from: '2027-01-01', multiplier: 0.5 }] });
    check(`${word}: refused with the reason, nothing applied`, re.test(JSON.stringify(r.assumptions?.notApplied ?? {}))
      && cents(at(r, HORIZON).netWorth.amount, at(base, HORIZON).netWorth.amount));
  }
  const mixed = await run('scenario_projection', { to: HORIZON, annualReturnPct: 0,
    spendingChanges: [CUT, { category: 'rent', op: 'SCALE', from: '2027-01-01', multiplier: 0.9 }] });
  check('one refused entry does not take the others with it: Dining ran, rent refused by name',
    mixed.assumptions.clauses.spendingChange.ran === true && /rule s2/.test(JSON.stringify(mixed.assumptions.notApplied))
      && cents(at(mixed, HORIZON).netWorth.amount, at(cut, HORIZON).netWorth.amount));

  // ── 4. the spine carries it ──────────────────────────────────────────────
  console.log('4. the ledger\'s cash moves by exactly the spending removed');
  check('ΔNW at 0% = 3,600 (no contributions, no liabilities)', cents(at(cut, HORIZON).netWorth.amount - at(base, HORIZON).netWorth.amount, 3_600));
  const mid = at(cut, '2027-06-30'); const midBase = at(base, '2027-06-30');
  check('mid-horizon (Jun 30): 181 days × 300/(365/12) = 1,785.21 — every spine point sees the rule',
    cents(mid.netWorth.amount - midBase.netWorth.amount, 181 * 300 / (365 / 12)));
  const pre = at(cut, '2026-12-31'); const preBase = at(base, '2026-12-31');
  check('before the rule starts: nothing moved', cents(pre.netWorth.amount, preBase.netWorth.amount));

  // ── 5. the envelope ──────────────────────────────────────────────────────
  console.log('5. the envelope keeps the arguments verbatim and the rule compactly');
  const cap = captureActiveScenario('scenario_projection', { to: HORIZON, annualReturnPct: 0, spendingChanges: [CUT] }, cut);
  check('REPLACE, with spendingChanges verbatim in `assumptions`', cap.action === 'REPLACE'
    && JSON.stringify((cap.scenario.assumptions as Rec).spendingChanges) === JSON.stringify([CUT]));
  check('…and the compact roster names the line, the dates, the rate after and the class',
    cap.action === 'REPLACE' && JSON.stringify((cap.scenario.ran as Rec).spendingChange)
      === JSON.stringify([{ op: 'SCALE', of: 'Dining', from: '2027-01-01', to: HORIZON, after: 1200, class: 'WHOLE_BUCKET' }]),
    cap.action === 'REPLACE' ? JSON.stringify((cap.scenario.ran as Rec).spendingChange) : '');
  const crossingResult = { asOf: ASOF, assumptionsInForce: cut.assumptions,
    crossing: { date: '2027-03-31', composition: { liquid: 30_000, investments: 50_000, debt: 0, netWorth: 80_000 } } };
  const baselineCrossing = captureActiveScenario('scenario_crossing',
    { metric: 'netWorth', direction: 'at_or_above', threshold: 80_000 }, { ...crossingResult, assumptionsInForce: {} });
  const hypothesis = captureActiveScenario('scenario_crossing',
    { metric: 'netWorth', direction: 'at_or_above', threshold: 80_000, spendingChanges: [CUT] },
    { ...crossingResult, assumptionsInForce: { ...cut.assumptions, argumentsRun: { spendingChanges: [CUT] } } });
  check('a crossing carrying ONLY spendingChanges is a hypothesis (captured), a bare one a trend reading (ignored)',
    baselineCrossing.action === 'IGNORE' && hypothesis.action !== 'IGNORE', `${baselineCrossing.action} / ${hypothesis.action}`);

  // ── 6. project_cash ──────────────────────────────────────────────────────
  console.log('6. project_cash refuses it and says where it belongs');
  const pc = await run('project_cash', { to: HORIZON, spendingChanges: [CUT] });
  check('refused, NOT run, and pointed at scenario_projection\'s `spendingChanges`',
    typeof pc.unavailable === 'string' && /spendingChanges/.test(String(pc.instead)) && pc.projection === undefined, JSON.stringify(pc).slice(0, 240));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall spending-change tool checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
