/**
 * lib/ai/conversation/canonical-spending-surfaces.test.ts
 *
 * ONE FIXTURE, ONE CANONICAL SPENDING BASELINE, EVERY SURFACE.
 *
 * The owner's invariant (2026-10-04): "how much do I spend a month" is the trailing
 * 3 COMPLETE calendar months before the as-of month, net of refunds — and it is
 * the SAME figure on every surface that prints or spends it:
 *
 *   Net Worth / Assets (the expense-baseline route's composition)
 *   the assessment (cash flow + liquidity/runway)
 *   the Daily Brief package (behavior)
 *   get_baselines.expense
 *   project_cash's spending rate
 *   scenario_goal_seek's spending in force
 *
 * …while a MEASUREMENT (measure_flows over 2 or 6 months) stays its own, correct
 * figure and never moves the baseline, and a stated "$5,700 a month" overrides it
 * inside that one scenario only.
 *
 * Every tool runs for real, through the registry, on the PRODUCTION path (no spine
 * seam), and so does the REAL transactions assembler — including its canonical
 * attach. Only the database is faked: a client that returns one raw row set
 * filtered by the economic-date window the assembler asks for, and answers the
 * corpus-span aggregate. The accounts domain is a fixture. The clock is frozen at
 * the fixture's as-of noon so the assembler's rolling window is deterministic.
 *
 * Fixture (asOf 2026-10-04 ⇒ canonical Jul/Aug/Sep), hand arithmetic:
 *   Jun  9,000                         (outside the canonical window)
 *   Jul  3,000 − refund 500 = 2,500
 *   Aug  6,000
 *   Sep  7,500
 *   Oct  4,000 on Oct 2               (in progress — never averaged)
 *   canonical = (2,500 + 6,000 + 7,500) / 3 = 5,333.33
 *   2-month measurement (Aug, Sep)    = (6,000 + 7,500) / 2 = 6,750
 *   the OLD 90-day read (Jul clipped) = 6,750 too — which is the defect
 *
 * Run:  npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/canonical-spending-surfaces.test.ts
 */

process.env.ENCRYPTION_KEY = 'c'.repeat(64);
delete process.env.DATABASE_URL;

// ── Frozen clock: `new Date()` and `Date.now()` are the fixture's as-of noon ──
const FROZEN = Date.parse('2026-10-04T12:00:00Z');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FROZEN); else super(...(args as [string]));
  }
  static now(): number { return FROZEN; }
}
(globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

import { readFileSync } from 'node:fs';
import type { ToolContext } from './tools';
import type { TransactionsSummaryData } from '@/lib/ai/types';

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const cents = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 0.011;

const ASOF = '2026-10-04';
const CANONICAL = 5_333.33;
const TWO_MONTH = 6_750;

type Row = { id: string; date: Date; amount: number; currency: string; category: string; flowType: string };
let seq = 0;
const row = (day: string, amount: number, flowType: string, category = 'Shopping'): Row =>
  ({ id: `x${seq++}`, date: new Date(`${day}T12:00:00Z`), amount, currency: 'USD', category, flowType });
const ROWS: Row[] = [
  row('2026-06-10', -9_000, 'SPENDING'),
  row('2026-07-05', -3_000, 'SPENDING'), row('2026-07-20', 500, 'REFUND'),
  row('2026-08-05', -6_000, 'SPENDING'),
  row('2026-09-05', -7_500, 'SPENDING'),
  row('2026-10-02', -4_000, 'SPENDING'),
  ...['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'].map((d) => row(d, 8_000, 'INCOME', 'Income')),
];
const dayOf = (r: Row) => r.date.toISOString().slice(0, 10);

async function main(): Promise<void> {
  await import('@/lib/ai/assemblers/transactions'); // registers the REAL transactions assembler
  const { registerAssembler, getAssembler } = await import('@/lib/ai/assembler-registry');
  const { FinanceDomains } = await import('@/lib/ai/types');
  const { readCanonicalSpending } = await import('@/lib/transactions/canonical-spending');
  const { resolveExpenseBaseline } = await import('@/lib/liquidity/expense-baseline');

  const history = async (asOf: string) => {
    const days = ROWS.map(dayOf).filter((d) => d <= asOf).sort();
    return { from: days[0] ?? null, to: days[days.length - 1] ?? null };
  };
  const accountsData = {
    totalLiquid: 20_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 70_000,
    totalLiabilities: 0, netWorth: 70_000, redactedCount: 0, totalsUnconverted: false,
    counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 0 }, accounts: [],
  };
  registerAssembler(FinanceDomains.ACCOUNTS, (async () => ({
    domain: FinanceDomains.ACCOUNTS, assembledAt: `${ASOF}T12:00:00Z`, data: accountsData })) as never);

  /** The economic-date bounds anywhere in a Prisma where-tree. */
  const boundsOf = (where: unknown): { gte?: Date; lte?: Date } => {
    let found: { gte?: Date; lte?: Date } = {};
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (o.economicDate && typeof o.economicDate === 'object') {
        const e = o.economicDate as { gte?: Date; lte?: Date };
        if (e.gte || e.lte) found = { ...found, ...e };
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(where);
    return found;
  };
  const asDbRow = (r: Row) => ({
    id: r.id, financialAccountId: 'chk', date: r.date, economicDate: r.date, merchant: r.category, merchantId: null,
    resolvedMerchant: null, category: r.category, amount: r.amount, pending: false, currency: 'USD',
    flowType: r.flowType, flowDirection: r.amount < 0 ? 'OUTFLOW' : 'INFLOW', classificationReason: null,
    transferRail: null, counterpartyAccountId: null, settlementState: 'POSTED', pfcDetailed: null, pfcPrimary: null,
    flowAuthority: null, counterpartyType: null, description: r.category,
  });
  // The database, faked: transaction rows by economic-date window, the corpus span,
  // and an empty answer everywhere else.
  const model = (name: string) => new Proxy({}, { get: (_t, op) => async (args?: { where?: unknown }) => {
    if (name === 'transaction' && op === 'findMany') {
      const b = boundsOf(args?.where);
      return ROWS.filter((r) => (!b.gte || r.date >= b.gte) && (!b.lte || r.date <= new RealDate(b.lte.getTime() + 86_399_999)))
        .sort((x, y) => y.date.getTime() - x.date.getTime()).map(asDbRow);
    }
    if (name === 'transaction' && op === 'aggregate') {
      const h = await history(ASOF);
      return { _min: { economicDate: h.from ? new RealDate(`${h.from}T00:00:00Z`) : null },
        _max: { economicDate: h.to ? new RealDate(`${h.to}T00:00:00Z`) : null } };
    }
    if (op === 'findMany' || op === 'groupBy') return [];
    if (op === 'count') return 0;
    if (op === 'aggregate') return { _min: {}, _max: {}, _sum: {}, _count: 0 };
    return null;
  } });
  const readClient = new Proxy({}, { get: (_t, name) => (typeof name === 'string' && !name.startsWith('$') && name !== 'then')
    ? model(name) : undefined }) as never;
  const txnAssembler = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY)!;
  const spaceCtx = { spaceId: 'spc', userId: 'u1', role: 'OWNER',
    space: { id: 'spc', name: 'Fixture', type: 'PERSONAL', category: 'PERSONAL', reportingCurrency: 'USD' } };

  const { findTool } = await import('./tools');
  const { emptyPlan } = await import('./pending-plan');
  const ctx: ToolContext = { asOfISO: ASOF, spaceId: 'spc', spaceCtx: spaceCtx as never, memoryClient: {} as never,
    readClient, plan: { pending: emptyPlan(), scenarioRan: false } } as ToolContext;
  const run = async (tool: string, args: Rec): Promise<Rec> => (await findTool(tool)!.run(args, ctx)) as Rec;

  // ── 1. Net Worth / Assets: the expense-baseline route's composition ─────────
  console.log('1. Net Worth / Assets — the route composes the canonical read with the one resolver');
  const routeRead = await readCanonicalSpending({ asOf: ASOF,
    readWindow: async (w) => ((await txnAssembler(readClient, spaceCtx as never,
      { scopeHint: 'full', transactionWindow: w } as never))?.data as TransactionsSummaryData | undefined) ?? null,
    readHistory: history });
  const routeBaseline = resolveExpenseBaseline({ declared: null, measured: routeRead.baseline.monthly,
    measuredOver: { label: routeRead.baseline.label, count: routeRead.baseline.monthCount } });
  check(`Assets coverage divides by ${CANONICAL} MEASURED over Jul–Sep 2026 (3 complete months)`,
    cents(routeBaseline?.amount, CANONICAL) && routeBaseline?.basis === 'MEASURED'
      && routeBaseline?.measuredOver?.label === 'Jul–Sep 2026 (3 complete months)', JSON.stringify(routeBaseline));
  const route = readFileSync('app/api/spaces/[id]/expense-baseline/route.ts', 'utf8');
  check('…and the ROUTE is that composition: readCanonicalSpending as of today, corpus span, measuredOver',
    /readCanonicalSpending\(\{\s*asOf: todayUTCISO\(\)/.test(route) && route.includes('transactionCorpusSpan(tx')
      && route.includes('measuredOver:') && !route.includes('computeAverageMonthlySpending('));

  // ── 2 + 3. The assessment and the Daily Brief package ───────────────────────
  console.log('2. the assessment and 3. the Daily Brief package');
  const { loadBriefPackage } = await import('@/lib/ai/brief/load');
  const { computeAssessment } = await import('@/lib/ai/intelligence');
  const box: { assessed: Rec | null } = { assessed: null };
  const loaded = await loadBriefPackage({
    spaceCtx: spaceCtx as never, asOf: ASOF, now: new Date(`${ASOF}T12:00:00Z`),
    deps: {
      assemble: async (domain, sc, options) => {
        const a = getAssembler(domain);
        return a ? (await a(readClient, sc as never, options as never)) ?? null : null;
      },
      readSnapshots: async () => [], projectSnapshots: () => null as never, recall: async () => [],
      recentActivity: async () => null as never,
      assess: (c) => { box.assessed = computeAssessment(c) as unknown as Rec; return box.assessed as never; },
    },
  });
  const assessed = box.assessed;
  check(`assessment cash flow: estimatedMonthlyExpenses = ${CANONICAL}`,
    cents(assessed?.cashFlow?.estimatedMonthlyExpenses, CANONICAL), String(assessed?.cashFlow?.estimatedMonthlyExpenses));
  check(`assessment liquidity/runway: estimatedMonthlyExpense = ${CANONICAL} (MEASURED)`,
    cents(assessed?.liquidity?.estimatedMonthlyExpense, CANONICAL) && assessed?.liquidity?.estimatedMonthlyExpenseBasis === 'MEASURED',
    String(assessed?.liquidity?.estimatedMonthlyExpense));
  check('income beside it averages the SAME three months: (8,000 × 3) / 3 = 8,000',
    cents(assessed?.cashFlow?.impliedMonthlyIncome, 8_000), String(assessed?.cashFlow?.impliedMonthlyIncome));
  const behavior = loaded.package.behavior as Rec | undefined;
  check(`[test 7] Brief behavior.monthlyExpenses = ${CANONICAL}, averagedMonths Jul/Aug/Sep, NET_OF_REFUNDS`,
    cents(behavior?.monthlyExpenses, CANONICAL) && behavior?.averagedMonths?.months?.join() === '2026-07,2026-08,2026-09'
      && behavior?.averagedMonths?.count === 3 && behavior?.averagedMonths?.basis === 'NET_OF_REFUNDS', JSON.stringify(behavior));

  // ── 4. get_baselines.expense ────────────────────────────────────────────────
  console.log('4. get_baselines — the default expense IS the canonical baseline');
  const gb1 = await run('get_baselines', {});
  check(`get_baselines.expense = ${CANONICAL} MEASURED over Jul–Sep, and byWindow[3] agrees`,
    cents(gb1.expense?.amount, CANONICAL) && gb1.expense?.basis === 'MEASURED'
      && gb1.expense?.window?.from === '2026-07-01' && gb1.expense?.window?.to === '2026-09-30'
      && cents(gb1.measuredSpending?.byWindow?.find((w: Rec) => w.completeMonths === 3)?.perCompleteMonth, CANONICAL),
    JSON.stringify({ expense: gb1.expense, byWindow: gb1.measuredSpending?.byWindow }).slice(0, 600));

  // ── 5 + 6. project_cash and scenario_goal_seek ──────────────────────────────
  console.log('5. project_cash and 6. scenario_goal_seek — the spine spends at the canonical baseline');
  const pc = await run('project_cash', { to: '2026-12-31' });
  const pcSpend = pc.projection?.basis?.spending;
  check(`project_cash spends at ${CANONICAL}/month over Jul/Aug/Sep (daily × 365/12)`,
    pcSpend?.source === 'OBSERVED' && cents(pcSpend.dailyRate * 365 / 12, CANONICAL)
      && pcSpend.monthsAveraged?.join() === '2026-07,2026-08,2026-09', JSON.stringify(pcSpend));
  const gs = await run('scenario_goal_seek', { target: 200_000, by: '2026-12-31', solveFor: 'annualReturnPct' });
  const gsSpend = gs.assumptionsInForce?.spending;
  check(`scenario_goal_seek: spending in force ${CANONICAL} OBSERVED, averagedMonths named with count and basis`,
    gsSpend?.source === 'OBSERVED' && cents(gsSpend.monthly, CANONICAL)
      && gsSpend.averagedMonths?.months?.join() === '2026-07,2026-08,2026-09' && gsSpend.averagedMonths?.count === 3
      && gsSpend.averagedMonths?.basis === 'NET_OF_REFUNDS' && gsSpend.averagedMonths?.label === 'Jul–Sep 2026 (3 complete months)',
    JSON.stringify(gsSpend));

  // ── 7. A MEASUREMENT stays a measurement ────────────────────────────────────
  console.log('7. [tests 4, 5] measure_flows over 2 and 6 months — correct, and the baseline does not move');
  const two = await run('measure_flows', { measure: 'spending', period: { completeMonths: 2 } });
  const twoNet = two.netOfRefunds?.perCompleteMonth ?? two.perCompleteMonth;
  check(`2 complete months = Aug, Sep: (6,000 + 7,500) / 2 = ${TWO_MONTH}`,
    two.period?.from === '2026-08-01' && two.period?.to === '2026-09-30' && cents(twoNet, TWO_MONTH),
    JSON.stringify({ period: two.period, per: two.perCompleteMonth, net: two.netOfRefunds }).slice(0, 400));
  const six = await run('measure_flows', { measure: 'spending', period: { completeMonths: 6 } });
  const sixNet = six.netOfRefunds?.perCompleteMonth ?? six.perCompleteMonth;
  // Apr 0 + May 0 + Jun 9,000 + Jul 2,500 + Aug 6,000 + Sep 7,500 = 25,000 / 6
  check('6 complete months = Apr–Sep: 25,000 / 6 = 4,166.67', cents(sixNet, 4_166.67), String(sixNet));
  const gb2 = await run('get_baselines', {});
  const gs2 = await run('scenario_goal_seek', { target: 200_000, by: '2026-12-31', solveFor: 'annualReturnPct' });
  check('…and AFTER both measurements the canonical baseline is unchanged everywhere',
    cents(gb2.expense?.amount, CANONICAL) && cents(gs2.assumptionsInForce?.spending?.monthly, CANONICAL));

  // ── 8. A stated level overrides inside its own scenario only ────────────────
  console.log('8. [test 6] "$5,700 a month" overrides the baseline inside that scenario only');
  const stated = await run('scenario_goal_seek', { target: 200_000, by: '2026-12-31', solveFor: 'annualReturnPct',
    assumedMonthlySpending: 5_700 });
  check('the stated scenario spends 5,700 USER_STATED, and names no averaged months',
    stated.assumptionsInForce?.spending?.source === 'USER_STATED' && stated.assumptionsInForce?.spending?.monthly === 5_700
      && stated.assumptionsInForce?.spending?.averagedMonths === undefined, JSON.stringify(stated.assumptionsInForce?.spending));
  const after = await run('scenario_goal_seek', { target: 200_000, by: '2026-12-31', solveFor: 'annualReturnPct' });
  const gb3 = await run('get_baselines', {});
  check('the next scenario and get_baselines are back on the canonical baseline',
    after.assumptionsInForce?.spending?.source === 'OBSERVED' && cents(after.assumptionsInForce?.spending?.monthly, CANONICAL)
      && cents(gb3.expense?.amount, CANONICAL));

  // ── The defect, on this fixture ──
  console.log('REGRESSION WITNESS — the 90-day assessment read, on its own, averages Aug+Sep');
  const { computeAverageMonthlySpending, reliableMonths } = await import('@/lib/ai/intelligence');
  const rolling = (await txnAssembler(readClient, spaceCtx as never, { scopeHint: 'full' } as never))?.data as TransactionsSummaryData;
  check(`the default read (07-06..10-04) holds Aug, Sep complete and averages ${TWO_MONTH} — what every surface used`,
    reliableMonths(rolling).map((m) => m.month).join() === '2026-08,2026-09'
      && cents(computeAverageMonthlySpending(rolling), TWO_MONTH), reliableMonths(rolling).map((m) => m.month).join());

  // ── 9. One figure ───────────────────────────────────────────────────────────
  console.log('9. [tests 9, 10] ONE figure across every surface');
  const figures = {
    assets: routeBaseline?.amount, assessmentCashFlow: assessed?.cashFlow?.estimatedMonthlyExpenses,
    runway: assessed?.liquidity?.estimatedMonthlyExpense, brief: behavior?.monthlyExpenses,
    getBaselines: gb1.expense?.amount, projectCash: pcSpend ? Math.round(pcSpend.dailyRate * 365 / 12 * 100) / 100 : null,
    goalSeek: gsSpend?.monthly,
  };
  check('Assets = assessment = runway = Brief = get_baselines = project_cash = goal seek, to the cent',
    Object.values(figures).every((v) => cents(v, CANONICAL)), JSON.stringify(figures));

  // ── 10. Source scans — the production callers ask for the canonical read ────
  console.log('10. the Brief loader and the tools are wired the way this fixture ran');
  const load = readFileSync('lib/ai/brief/load.ts', 'utf8');
  check('the Brief asks for it on BOTH reads (current and retrospective), as of the Brief\'s day',
    (load.match(/canonicalSpendingAsOf: asOf/g) ?? []).length === 2);
  const tools = readFileSync('lib/ai/conversation/tools.ts', 'utf8');
  check('the spine and get_baselines read the canonical months; no 90-day default read remains on either',
    (tools.match(/readCanonicalSpending\(\{/g) ?? []).length === 2
      && !/startDate: daysAgoISO\(asOf, 179\)/.test(tools) && !/from: daysAgoISO\(ceiling, 89\)/.test(tools));

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
