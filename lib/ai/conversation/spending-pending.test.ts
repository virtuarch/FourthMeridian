/**
 * lib/ai/conversation/spending-pending.test.ts — S1-6
 *
 * Spending changes in the EXISTING staged-plan carrier:
 *   1. the canonical four-turn conversation stages, fits, seals and opens;
 *   2. a line the data cannot change is refused BEFORE it is held;
 *   3. correction vs addition: same identity replaces; same subject + another date
 *      needs `replace` or `inAddition`; a word and its line are one rule;
 *   4. provenance: a stated cut licenses its multiplier; STOP passes as an operation;
 *      a figure nobody said does not;
 *   5. a staged spending clause reaches the next scenario run, and says so.
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
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fixtureReads(asOf: string): Promise<CashSpineReads> {
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
    rows.push({ id: `${m}c`, date: new Date(`${m}-15T12:00:00Z`), amount: -2_400, currency: 'USD', category: 'Shopping', flowType: 'SPENDING' });
  }
  for (const r of incomeRows) rows.push({ id: r.id, date: new Date(`${r.date}T12:00:00Z`), amount: r.amount, currency: 'USD', category: 'Income', flowType: 'INCOME' });
  const monthlyBreakdown = buildMonthlyBreakdown(rows as never, [], '2026-06-01', asOf, null);
  return {
    incomeTransactions: (async () => ({ rows: incomeRows, nextCursor: null })) as never,
    incomeAccountTypes: async (ids) => ids.map((id) => ({ id, type: 'checking' })),
    accounts: async () => ({ totalLiquid: 20_000, totalInvestments: 50_000, totalDigitalAssets: 0, totalAssets: 70_000,
      totalLiabilities: 0, netWorth: 70_000, redactedCount: 0, totalsUnconverted: false,
      counts: { liquid: 1, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 0 }, accounts: [] }) as never,
    transactionsSummary: async () => ({ monthlyBreakdown, startDate: '2026-06-01', endDate: asOf,
      windowDays: 112, transactionCount: rows.length, truncated: false }) as never,
  };
}

async function main(): Promise<void> {
  const { stagePlan, emptyPlan, mergeIntoArgs, isPendingPlan, MAX_PENDING_BYTES } = await import('./pending-plan');
  const { turnEvidence } = await import('./memory-model');
  const { sealRuntimeStateWithReport, openRuntimeState } = await import('./runtime-state');
  const say = (...texts: string[]) => turnEvidence(texts, []);
  const DINING_20 = { category: 'Dining', op: 'SCALE', from: '2027-01-01', multiplier: 0.8 };

  // ── 1. the canonical conversation ────────────────────────────────────────
  console.log('1. the canonical four turns stage, fit, seal and open');
  const said: string[] = [];
  let plan = emptyPlan();
  const turn = (text: string, stage: Rec, flags: Rec = {}) => {
    said.push(text);
    const r = stagePlan(plan, { stage, ...flags }, { turn: said.length - 1, evidence: say(...said) });
    plan = r.plan;
    return r;
  };
  const t1 = turn('Starting in January, cut Dining by 20%.', { spendingChanges: [DINING_20] });
  const t2 = turn('My raise is 15%.', { incomeChanges: [{ op: 'SCALE', from: '2027-01-01', multiplier: 1.15 }] });
  const t3 = turn('Keep nine months of expenses in cash.', { contributions: [{ liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1 }] });
  const t4 = turn('Pay the highest APR debt and invest the rest.', { contributions: [{ target: ['highest_apr', 'investments'] }] });
  check('every turn staged, nothing refused', [t1, t2, t3, t4].every((r) => r.refused.length === 0 && r.staged.length === 1),
    JSON.stringify([t1, t2, t3, t4].map((r) => r.refused)));
  check('three clauses: the Dining cut, the raise, and ONE floor rule carrying the waterfall',
    plan.clauses.length === 3 && plan.clauses[0].identity === 'RATE|Dining|2027-01-01'
      && JSON.stringify((plan.clauses[2].value as Rec).target) === '["highest_apr","investments"]');
  const bytes = JSON.stringify(plan.clauses).length;
  check(`it fits the measured budget (${bytes} of ${MAX_PENDING_BYTES} bytes)`, bytes <= MAX_PENDING_BYTES / 2);
  const B = { userId: 'cmrrm846r000j7znwsl67gt1a', spaceId: 'cmrrm846r000j7znwsl67gt1g', tail: 'a'.repeat(32) };
  const sealed = sealRuntimeStateWithReport({ scenario: null, pending: plan }, B);
  check('it seals FULL and opens to the same plan', sealed.carried === 'FULL' && isPendingPlan(openRuntimeState(sealed.sealed, B)?.pending)
    && JSON.stringify(openRuntimeState(sealed.sealed, B)?.pending) === JSON.stringify(plan));

  // ── 2. refused before it is held ─────────────────────────────────────────
  console.log('2. a line the data cannot change is never staged');
  for (const [word, re] of [['Medical', /Other AS A WHOLE/], ['restaurants', /Dining AS A WHOLE/], ['groceries', /Dining AS A WHOLE/],
    ['Interest', /model the debt/], ['Payment', /not spending/]] as const) {
    const r = stagePlan(emptyPlan(), { stage: { spendingChanges: [{ category: word, op: 'SCALE', from: '2027-01-01', multiplier: 0.7 }] } },
      { turn: 0, evidence: say(`cut ${word} 30%`) });
    check(`"cut ${word} 30%": refused with the vocabulary's reason, and NOT held`,
      r.plan.clauses.length === 0 && r.refused.length === 1 && re.test(r.refused[0].reason) && /NOT staged/.test(r.refused[0].reason),
      JSON.stringify(r.refused));
  }

  // ── 3. correction vs addition ────────────────────────────────────────────
  console.log('3. correction replaces; another date needs an explicit choice');
  const base = stagePlan(emptyPlan(), { stage: { spendingChanges: [DINING_20] } }, { turn: 0, evidence: say('cut Dining 20% from January') }).plan;
  const corrected = stagePlan(base, { stage: { spendingChanges: [{ ...DINING_20, multiplier: 0.85 }] } },
    { turn: 1, evidence: say('cut Dining 20% from January', 'actually make it 15%') });
  check('"actually make it 15%": same identity ⇒ REPLACED in place (same id, one clause, 0.85)',
    corrected.plan.clauses.length === 1 && corrected.plan.clauses[0].id === base.clauses[0].id
      && (corrected.plan.clauses[0].value as Rec).multiplier === 0.85 && corrected.replacedFields.length === 1);
  const JULY = { category: 'Dining', op: 'SCALE', from: '2027-07-01', multiplier: 0.9 };
  const ev2 = say('cut Dining 20% from January', 'then cut it another 10% starting July');
  const ambiguous = stagePlan(base, { stage: { spendingChanges: [JULY] } }, { turn: 1, evidence: ev2 });
  check('"another 10% from July" without a choice: refused — code cannot tell a correction from a second rule',
    ambiguous.plan.clauses.length === 1 && /inAddition/.test(ambiguous.refused[0]?.reason ?? ''));
  const added = stagePlan(base, { stage: { spendingChanges: [JULY] }, inAddition: true }, { turn: 1, evidence: ev2 });
  check('…with `inAddition`: both held, in order', added.plan.clauses.length === 2
    && added.plan.clauses.map((c) => c.identity).join(' ') === 'RATE|Dining|2027-01-01 RATE|Dining|2027-07-01');
  const replaced = stagePlan(base, { stage: { spendingChanges: [JULY] }, replace: true }, { turn: 1, evidence: ev2 });
  check('…with `replace`: the July rule takes the January rule\'s place and id', replaced.plan.clauses.length === 1
    && replaced.plan.clauses[0].id === base.clauses[0].id && (replaced.plan.clauses[0].value as Rec).from === '2027-07-01');
  const food = stagePlan(base, { stage: { spendingChanges: [{ ...DINING_20, category: 'food', multiplier: 0.75 }] } },
    { turn: 1, evidence: say('cut Dining 20% from January', 'make the food cut 25%') });
  check('"food" and "Dining" are ONE rule (the identity is the resolved line)', food.plan.clauses.length === 1
    && food.plan.clauses[0].identity === 'RATE|Dining|2027-01-01');
  const total = stagePlan(base, { stage: { spendingChanges: [{ op: 'SCALE', from: '2027-01-01', multiplier: 0.9 }] } },
    { turn: 1, evidence: say('cut Dining 20% from January', 'and cut everything 10%') });
  check('a TOTAL rule beside a Dining rule is the same money: an explicit choice is required',
    total.plan.clauses.length === 1 && /inAddition/.test(total.refused[0]?.reason ?? ''));
  const retracted = stagePlan(base, { retract: [base.clauses[0].id] }, { turn: 1, evidence: say('never mind the Dining cut') });
  check('"never mind the Dining cut": retracted', retracted.plan.clauses.length === 0 && retracted.retracted.length === 1);

  // ── 4. provenance ────────────────────────────────────────────────────────
  console.log('4. only figures the user said are carried; STOP is an operation');
  const stage1 = (value: Rec, text: string) => stagePlan(emptyPlan(), { stage: { spendingChanges: [value] } }, { turn: 0, evidence: say(text) });
  check('a multiplier the user did not say (0.7 for "cut Dining 20%") is refused',
    stage1({ ...DINING_20, multiplier: 0.7 }, 'cut Dining 20% from January').refused.length === 1);
  check('"spend $500 less on Shopping" licenses a DELTA of −500',
    stage1({ category: 'Shopping', op: 'DELTA', from: '2027-03-01', monthly: -500 }, 'spend $500 less on Shopping from March').staged.length === 1);
  check('…a DELTA of −800 it did not say is refused',
    stage1({ category: 'Shopping', op: 'DELTA', from: '2027-03-01', monthly: -800 }, 'spend $500 less on Shopping from March').refused.length === 1);
  check('"stop spending on Travel from June": SET_RATE 0 is held with no "$0" in sight',
    stage1({ category: 'Travel', op: 'SET_RATE', from: '2027-06-01', monthly: 0 }, 'stop spending on Travel from June').staged.length === 1);
  check('…and SCALE 0 likewise; but SET_RATE 300 nobody said is refused',
    stage1({ category: 'Travel', op: 'SCALE', from: '2027-06-01', multiplier: 0 }, 'stop spending on Travel').staged.length === 1
      && stage1({ category: 'Travel', op: 'SET_RATE', from: '2027-06-01', monthly: 300 }, 'less travel from June').refused.length === 1);

  // ── 5. the next run applies it ───────────────────────────────────────────
  console.log('5. a staged spending clause reaches the next scenario run, and is attributed');
  const merged = mergeIntoArgs(base, { to: '2027-12-31' });
  check('merged into the call\'s arguments exactly as staged', JSON.stringify(merged.args.spendingChanges) === JSON.stringify([DINING_20]));
  const superseded = mergeIntoArgs(base, { to: '2027-12-31', spendingChanges: [{ ...DINING_20, multiplier: 0.85 }] });
  check('a call restating the same line\'s rule supersedes the staged one, said', superseded.supersededByCall.length === 1
    && JSON.stringify(superseded.args.spendingChanges) === JSON.stringify([{ ...DINING_20, multiplier: 0.85 }]));
  const { findTool } = await import('./tools');
  const reads = await fixtureReads('2026-09-21');
  const ctx: ToolContext = { asOfISO: '2026-09-21', spaceId: 'spc', spaceCtx: {} as never, cashSpineReads: reads,
    plan: { pending: base, scenarioRan: false } };
  const r = await findTool('scenario_projection')!.run({ to: '2027-12-31', annualReturnPct: 0 }, ctx) as Rec;
  check('the run applied it: roster RAN (Dining 1,500 → 1,200) and it is credited to the earlier turn',
    r.assumptions.clauses.spendingChange.ran === true && r.assumptions.clauses.spendingChange.rules[0].monthlyAfter === 1_200
      && r.assumptions.fromEarlierInConversation?.clauses?.[0]?.argument === 'spendingChanges',
    JSON.stringify(r.assumptions.fromEarlierInConversation));

  // ── 6. the staging TOOL exposes the choice its own refusal names ─────────
  console.log('6. stage_assumptions accepts `inAddition`, as its refusal instructs');
  const st = findTool('stage_assumptions')!;
  check('`inAddition` is declared beside `replace`', 'inAddition' in (st.parameters as Rec).properties && 'replace' in (st.parameters as Rec).properties);
  const tctx = (pending: ReturnType<typeof emptyPlan>, texts: string[]): ToolContext => ({ asOfISO: '2026-09-21', spaceId: 'spc',
    spaceCtx: {} as never, plan: { pending, scenarioRan: false }, turn: say(...texts) } as ToolContext);
  const c1 = tctx(emptyPlan(), ['cut Dining 20% from January']);
  await st.run({ spendingChanges: [DINING_20] }, c1);
  const texts = ['cut Dining 20% from January', 'then cut it another 10% starting July'];
  const c2 = tctx(c1.plan!.pending, texts);
  const refusedFirst = await st.run({ spendingChanges: [JULY] }, c2) as Rec;
  const retried = await st.run({ spendingChanges: [JULY], inAddition: true }, c2) as Rec;
  check('without it: refused, naming `inAddition`; with it: staged — two rules held',
    /inAddition/.test(JSON.stringify(refusedFirst.notStaged)) && retried.staged?.length === 1 && c2.plan!.pending.clauses.length === 2,
    JSON.stringify(retried).slice(0, 240));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall spending-pending checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
