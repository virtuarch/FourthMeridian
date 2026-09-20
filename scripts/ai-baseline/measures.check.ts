/**
 * scripts/ai-baseline/measures.check.ts   (M1 — measures & comparison)
 *
 * THE M1 HEADS AGAINST REAL DATA — an AUTHORITY check, not a golden fixture.
 *
 * `lib/ai/measures/measures.test.ts` pins the arithmetic purely and runs in CI.
 * This proves what a fixture cannot: that on a live Space the two heads agree
 * with every canonical authority that already answers the same question, that
 * completeness follows the population, and that the threshold composes with the
 * existing liquid floor and the existing L1 target with money conserved.
 *
 * ⚠️ NO PERSONAL MONEY CONSTANT APPEARS BELOW. Every assertion is a RELATION
 * between two readings taken in the same run — "the head's figure equals the
 * authority's figure", "the floor equals six times the spending in force" — so
 * the check keeps passing when the user's finances legitimately move, and fails
 * when an authority, a reconciliation or a composition breaks. Live values are
 * printed for the report; none is asserted.
 *
 *   npm run ai:measures-check
 */
import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { getAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains, type SpaceContext_AI } from '@/lib/ai/types';
import { computeAssessment } from '@/lib/ai/intelligence';
import { findTool, openAiToolSchemas, type ToolContext } from '@/lib/ai/conversation/tools';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
const EPS = 0.005;
let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); if (!cond) failures++; };
const near = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < EPS;
const r2 = (n: number) => Math.round(n * 100) / 100;
/* eslint-disable @typescript-eslint/no-explicit-any */

async function main() {
  const space = await db.space.findUniqueOrThrow({ where: { id: SPACE } });
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId: SPACE, role: 'OWNER', status: 'ACTIVE' } });
  const spaceCtx = { userId: owner.userId, spaceId: SPACE, role: 'OWNER', permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category, isPublic: space.isPublic, reportingCurrency: space.reportingCurrency } } as unknown as SpaceContext;
  const ctx: ToolContext = { spaceCtx, spaceId: SPACE, asOfISO: ASOF };
  const sizes: Record<string, number> = {}; const times: Record<string, number> = {};
  const run = async (name: string, args: Record<string, unknown>, tag?: string): Promise<any> => {
    const t0 = Date.now(); const r = await findTool(name)!.run(args, ctx);
    if (tag) { sizes[tag] = JSON.stringify(r).length; times[tag] = Date.now() - t0; }
    return r;
  };
  console.log(`Space ${SPACE} as of ${ASOF}\n`);

  console.log('1. a measure equals the evidence tool over the same window');
  const q = await run('measure_flows', { measure: 'spending', period: { preset: 'PAST_QUARTER' } }, 'measure');
  const gs = await run('get_spending', { from: q.period.from, to: q.period.to });
  check('measure_flows(spending).total === get_spending.totals.spending', near(q.total, gs.totals.spending), `${q.total} vs ${gs.totals.spending}`);
  const qi = await run('measure_flows', { measure: 'income', period: { preset: 'PAST_QUARTER' } });
  const qn = await run('measure_flows', { measure: 'economicNet', period: { preset: 'PAST_QUARTER' } });
  check('…income and economicNet too: one fold, three readings', near(qi.total, gs.totals.income) && near(qn.total, gs.totals.netCashFlow),
    `${qi.total}/${gs.totals.income} ${qn.total}/${gs.totals.netCashFlow}`);
  check('the monthly figure is the mean of the WHOLE months it lists, and is not total ÷ months-in-window',
    q.perCompleteMonth === null || near(q.perCompleteMonth, r2(q.months.filter((m: any) => !m.partial).reduce((n: number, m: any) => n + m.value, 0) / q.completeMonths)));
  check('partial months are named, not averaged', q.partialMonths.length === q.months.filter((m: any) => m.partial).length);

  console.log('\n2. the baseline agrees with every canonical authority for the same basis');
  const b = await run('get_baselines', { monthsOfExpenses: [3, 6, 12] }, 'baselines');
  const pc = await run('project_cash', { to: `${Number(ASOF.slice(0, 4)) + 1}-${ASOF.slice(5)}` });
  const spine = pc.projection?.basis?.spending;
  check('the default MEASURED window is the months the cash projection averaged',
    b.expense.basis !== 'MEASURED' || JSON.stringify(b.expense.months.map((m: any) => m.month)) === JSON.stringify(spine?.monthsAveraged),
    `${JSON.stringify(b.expense.months?.map((m: any) => m.month))} vs ${JSON.stringify(spine?.monthsAveraged)}`);
  check('…and the amount is the projection\'s own observed rate', b.expense.basis !== 'MEASURED' || near(b.expense.amount, r2(spine.dailyRate * 365 / 12)),
    `${b.expense.amount} vs ${r2((spine?.dailyRate ?? 0) * 365 / 12)}`);
  const assemble = async (domain: string) => (await getAssembler(domain)!(spaceCtx, { scopeHint: 'full' } as never)) ?? null;
  const [accounts, transactions] = await Promise.all([assemble(FinanceDomains.ACCOUNTS), assemble(FinanceDomains.TRANSACTIONS_SUMMARY)]);
  const assessment = computeAssessment({ space: { name: '', reportingCurrency: 'USD' },
    domains: { [FinanceDomains.ACCOUNTS]: accounts, [FinanceDomains.TRANSACTIONS_SUMMARY]: transactions } } as unknown as SpaceContext_AI);
  if (ASOF === new Date().toISOString().slice(0, 10)) {
    check('the assessment (and so the Brief) divides by the same baseline, on the same rung',
      near(assessment.liquidity.estimatedMonthlyExpense, b.expense.amount) && assessment.liquidity.estimatedMonthlyExpenseBasis === b.expense.basis,
      `${assessment.liquidity.estimatedMonthlyExpense} ${assessment.liquidity.estimatedMonthlyExpenseBasis} vs ${b.expense.amount} ${b.expense.basis}`);
    check('…and its runway is the head\'s runway', near(assessment.liquidity.coverageMonths, b.runway.months), `${assessment.liquidity.coverageMonths} vs ${b.runway.months}`);
    const mi = await run('measure_flows', { measure: 'income', period: { from: b.expense.window.from, to: b.expense.window.to } });
    check('the assessment\'s monthly income is the complete-month mean over those same months — not window ÷ days',
      near(assessment.cashFlow.impliedMonthlyIncome, mi.perCompleteMonth), `${assessment.cashFlow.impliedMonthlyIncome} vs ${mi.perCompleteMonth}`);
  }
  const snap = await run('get_financial_snapshot', {});
  check('runway divides the canonical liquid total', near(b.runway.liquid, snap.liquid) && near(b.liquid.amount, snap.liquid), `${b.runway.liquid} vs ${snap.liquid}`);

  console.log('\n3. multiple legitimate spending windows stay distinguishable, each equal to its own measure');
  for (const w of b.measuredSpending.byWindow) {
    const m = await run('measure_flows', { measure: 'spending', period: { completeMonths: w.completeMonths } });
    check(`${w.completeMonths} complete months: byWindow === measure_flows (${w.perCompleteMonth})`, near(w.perCompleteMonth, m.perCompleteMonth) && w.from === m.period.from);
  }
  const b6 = await run('get_baselines', { spendingWindow: { completeMonths: 6 }, monthsOfExpenses: [6] });
  check('choosing a window changes the baseline AND names it', b6.expense.basis === 'MEASURED' && b6.expense.completeMonths === 6
    && b6.expense.window.label === 'last 6 complete months' && near(b6.expense.amount, b.measuredSpending.byWindow.find((w: any) => w.completeMonths === 6).perCompleteMonth));
  console.log(`   live: default ${b.expense.amount} (${b.expense.completeMonths} mo) | ${b.measuredSpending.byWindow.map((w: any) => `${w.completeMonths}mo=${w.perCompleteMonth}`).join(' ')}`);

  console.log('\n4. derived figures reproduce from their own operands');
  check('surplus = income baseline − expense baseline', near(b.monthlySurplus.amount, r2(b.monthlySurplus.income.amount - b.monthlySurplus.expense.amount)));
  check('savings rate = numerator ÷ denominator', 'unavailable' in b.savingsRate || near(b.savingsRate.ratePct, r2(b.savingsRate.numerator / b.savingsRate.denominator * 100)));
  check('runway = liquid ÷ monthly expense', near(b.runway.months, r2(b.runway.liquid / b.runway.monthlyExpense)));
  check('each threshold = months × the baseline it names', b.thresholds.every((t: any) => near(t.amount, r2(t.monthsOfExpenses * t.baseline.amount)) && t.baseline.basis === b.expense.basis));
  const net = await run('measure_flows', { measure: 'economicNet', period: { from: b.expense.window?.from ?? q.period.from, to: b.expense.window?.to ?? q.period.to } });
  check('the steady-state SURPLUS and the measured ECONOMIC NET are two named figures, not one', typeof net.perCompleteMonth === 'number' && 'amount' in b.monthlySurplus && /steady-state/.test(b.monthlySurplus.basis));
  console.log(`   live: surplus ${b.monthlySurplus.amount} (${b.monthlySurplus.income.basis} − ${b.monthlySurplus.expense.basis}) | economicNet/mo over the same months ${net.perCompleteMonth} | savings rate ${b.savingsRate.ratePct ?? b.savingsRate.unavailable}% | runway ${b.runway.months} mo of ${b.runway.liquid} | 6 mo = ${b.thresholds.find((t: any) => t.monthsOfExpenses === 6).amount}`);

  console.log('\n5. declared and stated stay distinct');
  const st = await run('get_baselines', { statedMonthlySpending: 5000, monthsOfExpenses: [6, 9] });
  const th = (r: any, n: number) => r.thresholds.find((t: any) => t.monthsOfExpenses === n);
  check('"use $5k" → STATED 5,000; six months 30,000; nine 45,000', st.expense.basis === 'STATED' && st.expense.amount === 5000 && th(st, 6).amount === 30000 && th(st, 9).amount === 45000);
  check('3, 6 and 12 are always priced, and a stated baseline tells the model how to carry itself into a scenario',
    [3, 6, 12].every((n) => !!th(st, n) && !!th(b, n)) && /assumedMonthlySpending/.test(st.expense.note));
  check('each threshold carries its gap to current cash: difference = liquid − amount',
    b.thresholds.every((t: any) => near(t.vsLiquid.difference, r2(t.vsLiquid.liquid - t.amount)) && near(t.vsLiquid.liquid, snap.liquid)
      && t.vsLiquid.status === (t.vsLiquid.difference < 0 ? 'BELOW' : 'AT_OR_ABOVE')));
  check('…the measured evidence is still shown beside it, unchanged', JSON.stringify(st.measuredSpending.byWindow) === JSON.stringify(b.measuredSpending.byWindow));
  check('…and the runway re-divides by the stated figure', near(st.runway.months, r2(st.runway.liquid / 5000)) && st.runway.expenseBasis === 'STATED');

  console.log('\n6. comparisons');
  const c = await run('measure_flows', { measure: 'spending', period: { completeMonths: 3 }, compareTo: 'PREVIOUS' }, 'comparison');
  const cSaid = await run('measure_flows', { measure: 'spending', period: { completeMonths: 3 }, compareTo: { completeMonths: 3 } });
  check('`compareTo: {completeMonths: 3}` is the three BEFORE — the same answer as PREVIOUS, never a window against itself',
    JSON.stringify(cSaid.change) === JSON.stringify(c.change) && cSaid.right.period.from === c.right.period.from);
  check('a window compared with itself is refused by name',
    'unavailable' in (await run('measure_flows', { measure: 'spending', period: { month: c.left.period.from.slice(0, 7) }, compareTo: { month: c.left.period.from.slice(0, 7) } })));
  check('3 complete months vs the 3 before: adjacent, equal, compared on total', c.comparedOn === 'total' && c.right.period.to < c.left.period.from && c.left.completeMonths === 3 && c.right.completeMonths === 3);
  check('abs, pct and direction are the code\'s', near(c.change.abs, r2(c.left.total - c.right.total))
    && (c.change.pct === null || near(c.change.pct, r2(c.change.abs / Math.abs(c.right.total) * 100)))
    && c.change.direction === (Math.abs(c.change.abs) < EPS ? 'FLAT' : c.change.abs > 0 ? 'UP' : 'DOWN'));
  const mtd = await run('measure_flows', { measure: 'spending', period: { preset: 'MTD' }, compareTo: 'PREVIOUS' });
  check('MTD vs PREVIOUS = the same elapsed days of last month', mtd.right.period.kind === 'ELAPSED_EQUIVALENT' && mtd.right.period.days === mtd.left.period.days);
  const wholeMonth = await run('measure_flows', { measure: 'spending', period: { preset: 'MTD' }, compareTo: { completeMonths: 1 } });
  check('MTD vs a WHOLE month: both totals, no manufactured difference (unless today closes the month)',
    wholeMonth.left.period.calendarComplete || (wholeMonth.change === null && typeof wholeMonth.notComparable === 'string' && typeof wholeMonth.right.total === 'number'));
  const cat = await run('measure_flows', { measure: 'spending', period: { completeMonths: 3 }, compareTo: 'PREVIOUS', category: 'travel' });
  check('a category is the same measure with a filter, and never exceeds the whole', cat.category === 'Travel' && cat.left.total <= c.left.total + EPS);
  const whole = await run('measure_flows', { measure: 'spending', period: { completeMonths: 3 } });
  check('a category carries all spending over the same window and its share — the division is code\'s',
    near(cat.left.ofAllSpending.total, whole.total) && near(cat.left.ofAllSpending.sharePct, r2(cat.left.total / whole.total * 100)),
    JSON.stringify(cat.left.ofAllSpending));
  check('an unknown category is refused by name', 'unavailable' in (await run('measure_flows', { measure: 'spending', period: { completeMonths: 1 }, category: 'Yachts' })));
  console.log(`   live: last 3 vs prior 3 ${c.left.total} vs ${c.right.total} → ${c.change.direction} ${c.change.abs} (${c.change.pct}%) | MTD ${mtd.left.total} vs ${mtd.right.total} → ${mtd.change?.direction} | Travel ${cat.left.total} vs ${cat.right.total}`);

  console.log('\n7. completeness follows the population');
  const health = (accounts?.data as any)?.accounts ?? [];
  const behind = health.filter((a: any) => a.needsReauth);
  console.log(`   accounts needing reconnect: ${behind.map((a: any) => `${a.type}:${a.institution}`).join(', ') || 'none'}`);
  const comps = Object.keys(q.completeness.byComponent ?? {});
  const brokerageBehind = behind.filter((a: any) => a.type === 'investment' || a.type === 'crypto');
  check('a brokerage or wallet that needs reconnecting is NOT a component of spending',
    brokerageBehind.every((a: any) => !comps.includes(`${a.type}:${a.institution ?? a.name}`)), comps.join(','));
  const bankBehind = behind.filter((a: any) => a.type !== 'investment' && a.type !== 'crypto');
  check('with every banking source delivering, a window inside history is OBSERVED', bankBehind.length > 0 || q.completeness.tier === 'observed', q.completeness.reason);
  const early = await run('measure_flows', { measure: 'spending', period: { year: Number(q.completeness.coverageFrom.slice(0, 4)) - 1 } });
  check('a window before history is INCOMPLETE and says where history begins', early.completeness.tier === 'incomplete' && early.completeness.coverageFrom === q.completeness.coverageFrom);
  const far = await run('measure_flows', { measure: 'spending', period: { completeMonths: 60 } });
  check('a window past the read\'s lookback is INCOMPLETE, never a silently shorter total', far.completeness.tier === 'incomplete');

  console.log('\n8. the threshold feeds the EXISTING liquid floor (J)');
  const horizon = `${Number(ASOF.slice(0, 4)) + 4}-12-31`;
  const floor6 = { liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1 };
  const j = await run('scenario_projection', { to: horizon, granularity: 'quarterly', contributions: [floor6] }, 'scenario');
  const fr = j.assumptions.contributions.floorRule;
  const six = b.thresholds.find((t: any) => t.monthsOfExpenses === 6);
  check('nothing rejected', j.rejected.length === 0, JSON.stringify(j.rejected));
  check('the floor in force === get_baselines\' six-month threshold — one figure on both heads', near(fr.liquidFloor, six.amount), `${fr.liquidFloor} vs ${six.amount}`);
  check('…=== 6 × the spending this scenario itself runs at', near(fr.liquidFloor, r2(6 * j.assumptions.spending.monthly)));
  check('the floor keeps its identity: rule, multiplier and baseline echoed beside the dollars',
    fr.derivedFrom?.rule === '6 months of expenses' && fr.derivedFrom.monthsOfExpenses === 6 && near(fr.derivedFrom.baseline.amount, j.assumptions.spending.monthly) && fr.derivedFrom.baseline.basis === 'MEASURED');
  const literal = await run('scenario_projection', { to: horizon, granularity: 'quarterly', contributions: [{ liquidFloor: fr.liquidFloor, fractionOfExcess: 1 }] });
  check('and it IS the existing rule: identical checkpoints to the same floor passed as a dollar literal',
    JSON.stringify(literal.checkpoints.map((k: any) => [k.date, k.liquid?.amount, k.investments.amount, k.netWorth.amount]))
      === JSON.stringify(j.checkpoints.map((k: any) => [k.date, k.liquid?.amount, k.investments.amount, k.netWorth.amount])));
  const base = await run('scenario_projection', { to: horizon, granularity: 'quarterly' });
  const drift = Math.max(...j.checkpoints.map((k: any, i: number) => Math.abs(k.netWorth.amount - base.checkpoints[i].netWorth.amount)));
  check('money is conserved at 0%: net worth equals the no-rule baseline at every checkpoint', drift < EPS, String(drift));
  const after = j.checkpoints.filter((k: any) => fr.firstMonthEndAtOrAboveFloor && k.date >= fr.firstMonthEndAtOrAboveFloor);
  check('once reached, liquid is held AT the floor', fr.monthsBelowFloor > 0 || after.every((k: any) => near(k.liquid.amount, fr.liquidFloor)));
  const s5 = await run('scenario_projection', { to: horizon, granularity: 'yearly', assumedMonthlySpending: 5000, contributions: [floor6] });
  check('"use $5k; keep six months of that": floor 30,000, STATED, and the spine spends at the same 5,000',
    s5.assumptions.contributions.floorRule.liquidFloor === 30000 && s5.assumptions.contributions.floorRule.derivedFrom.baseline.basis === 'STATED' && s5.assumptions.spending.monthly === 5000);
  const s9 = await run('scenario_projection', { to: horizon, granularity: 'yearly', assumedMonthlySpending: 5000, contributions: [{ ...floor6, liquidFloorMonthsOfExpenses: 9 }] });
  check('"make it nine": 45,000 from the same sentence', s9.assumptions.contributions.floorRule.liquidFloor === 45000 && s9.assumptions.contributions.floorRule.derivedFrom.monthsOfExpenses === 9);
  const both = await run('scenario_projection', { to: horizon, contributions: [{ liquidFloor: 50000, liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1 }] });
  check('a floor stated twice is refused, not resolved to one of them', both.rejected.length === 1 && /ONCE/.test(both.rejected[0].reason));

  console.log('\n9. …and with the EXISTING L1 target — no debt-specific threshold code (K)');
  const cards = (snap.accounts as any[]).filter((a) => a.type === 'debt');
  const ids = ((accounts?.data as any)?.accounts ?? []).filter((a: any) => a.type === 'debt' && a.visibilityLevel === 'FULL' && (a.amountOwed ?? 0) > 0).map((a: any) => a.id);
  if (ids.length === 0) console.log(`   (no owed liability in scope — ${cards.length} debt accounts, none owing; composition not exercised)`);
  else {
    // APR 0 is a REAL stated rate, so nothing accrues and conservation is exact.
    const la = ids.map((id: string) => ({ liabilityId: id, apr: 0, minimumPayment: 0 }));
    const rule = { ...floor6, target: ['highest_apr', 'investments'] };
    const k = await run('scenario_projection', { to: horizon, granularity: 'quarterly', contributions: [rule], liabilityAssumptions: la });
    const k0 = await run('scenario_projection', { to: horizon, granularity: 'quarterly', liabilityAssumptions: la });
    check('nothing rejected', k.rejected.length === 0, JSON.stringify(k.rejected));
    const kd = Math.max(...k.checkpoints.map((c2: any, i: number) => Math.abs(c2.netWorth.amount - k0.checkpoints[i].netWorth.amount)));
    check('money is conserved: paying a card and investing the rest moves lines, never net worth', kd < EPS, String(kd));
    const last = k.checkpoints.at(-1); const last0 = k0.checkpoints.at(-1);
    check('debt is paid down by the rule before anything is invested', last.debt.amount < last0.debt.amount && last.investments.amount >= last0.investments.amount,
      `debt ${last0.debt.amount} → ${last.debt.amount}; investments ${last0.investments.amount} → ${last.investments.amount}`);
    check('the floor is the same derived figure, identity intact', near(k.assumptions.contributions.floorRule.liquidFloor, six.amount) && k.assumptions.contributions.floorRule.derivedFrom.monthsOfExpenses === 6);
    // With real interest the waterfall must still clear the highest rate first.
    const rated = await run('scenario_projection', { to: horizon, granularity: 'quarterly', annualReturnPct: 7, contributions: [rule],
      liabilityAssumptions: ids.map((id: string, i: number) => ({ liabilityId: id, apr: i === 0 ? 24.99 : 19.99 })) });
    check('at stated APRs the same call runs, with the L1 echo in force', rated.rejected.length === 0 && !!rated.assumptions.liabilities);
    console.log(`   live: floor ${k.assumptions.contributions.floorRule.liquidFloor}; by ${horizon} debt ${last0.debt.amount} → ${last.debt.amount}, investments ${last0.investments.amount} → ${last.investments.amount}`);
  }

  console.log('\n10. cost');
  const schemas = openAiToolSchemas() as { function: { name: string; parameters: unknown; description: string } }[];
  const bytes = (n: string) => JSON.stringify(schemas.find((s) => s.function.name === n)).length;
  const field = JSON.stringify((schemas.find((s) => s.function.name === 'scenario_projection')!.function.parameters as any).properties.contributions.items.properties.liquidFloorMonthsOfExpenses).length;
  console.log(`   schema: measure_flows ${bytes('measure_flows')} B, get_baselines ${bytes('get_baselines')} B, liquidFloorMonthsOfExpenses ${field} B × 3 scenario tools; all tools ${JSON.stringify(schemas).length} B`);
  console.log(`   payloads: ${Object.entries(sizes).map(([k2, v]) => `${k2} ${v} B / ${times[k2]} ms`).join(', ')}`);
  check('a measure is under 2 KB, a comparison under 4 KB, the baselines under 5 KB', sizes.measure < 2000 && sizes.comparison < 4000 && sizes.baselines < 5000, JSON.stringify(sizes));

  console.log(failures === 0 ? '\nACCEPTANCE PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
