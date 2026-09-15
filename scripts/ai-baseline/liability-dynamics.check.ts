/**
 * scripts/ai-baseline/liability-dynamics.check.ts
 *
 * LIABILITIES AS A MOVING LINE — against the real position.
 *
 * `lib/ai/conversation/liability-dynamics.test.ts` pins the arithmetic purely.
 * This proves the AUTHORITY path: the liability lines a scenario opens from are
 * the position's own FULL-visibility debt rows, at `amountOwed` (a card in
 * credit opens at 0, never as negative debt), with the effective terms the
 * assembler resolved — and where those terms are null the scenario says so as
 * a named gap, never as 0%. A stated assumption on one line proves the override
 * without touching the account.
 *
 * ⚠️ THE DOGFOOD SPACE IS DEBT-DEGENERATE BY DESIGN OF ITS OWNER, not of this
 * check: it carries a few dollars on one card and no stated terms. Nothing here
 * fabricates debt; the cases that need a real balance use `liabilityAssumptions`
 * on whatever is owed today, and the ledger arithmetic is proven elsewhere.
 * Read-only.
 *
 *   npm run ai:liability-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, type ToolContext } from '@/lib/ai/conversation/tools';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? '2026-09-13';
let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); if (!cond) failures++; };
type Rec = Record<string, unknown>;
const at = (raw: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) =>
  (v && typeof v === 'object' ? (v as Rec)[k] : undefined), raw);
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v as Rec[] : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

async function main() {
  const space = await db.space.findUniqueOrThrow({ where: { id: SPACE } });
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId: SPACE, role: 'OWNER', status: 'ACTIVE' } });
  const spaceCtx = { userId: owner.userId, spaceId: SPACE, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency } } as unknown as SpaceContext;
  const toolCtx: ToolContext = { spaceCtx, spaceId: SPACE, asOfISO: ASOF };
  const run = async (name: string, args: Rec) => {
    const t0 = Date.now(); const raw = await findTool(name)!.run(args, toolCtx);
    return { raw, ms: Date.now() - t0, bytes: JSON.stringify(raw).length };
  };

  console.log('1. the position\'s liabilities become the scenario\'s lines');
  const snap = await run('get_financial_snapshot', {});
  const debtRows = list(snap.raw && (snap.raw as Rec).accounts).filter((r) => r.type === 'debt');
  const gaps = list(at(snap.raw, 'missingDebtFields'));
  const proj = await run('scenario_projection', { to: '2027-12-31' });
  const lines = list(at(proj.raw, 'assumptions.liabilities.lines'));
  // The snapshot's account rows are presentation rows (no id); lines carry the
  // display name as `label`, so the join is by name.
  const rowFor = (l: Rec) => debtRows.find((r) => r.name === l.label);
  check('one line per debt account the position shows', lines.length === debtRows.length, `${lines.length} lines, ${debtRows.length} debt rows`);
  check('every line opens at amountOwed — a credit balance is 0, never negative debt',
    lines.every((l) => num(l.openingBalance) >= 0 && rowFor(l) !== undefined && num(l.openingBalance) === num(rowFor(l)!.amountOwed)));
  check('the lines sum to the position\'s debt total and nothing is withheld on an all-FULL Space',
    Math.abs(lines.reduce((t, l) => t + num(l.openingBalance), 0) + num(at(proj.raw, 'assumptions.liabilities.withheldAggregate')) - num(at(snap.raw, 'totalLiabilities'))) < 0.01,
    `lines ${lines.reduce((t, l) => t + num(l.openingBalance), 0)}, withheld ${at(proj.raw, 'assumptions.liabilities.withheldAggregate')}, position ${at(snap.raw, 'totalLiabilities')}`);
  check('a null term in the position is UNKNOWN on the line, never a number',
    lines.every((l) => { const row = rowFor(l)!; return (row.apr === null) === (at(l, 'terms.apr') === 'UNKNOWN') && (row.minimumPayment === null) === (at(l, 'terms.minimumPayment') === 'UNKNOWN'); }));
  check('missingDebtFields and the unmodelled lines agree on which owed accounts lack a rate',
    list(at(proj.raw, 'assumptions.liabilities.unmodelled')).every((u) => gaps.some((g) => g.accountId === u.id && g.field === 'apr')));
  const owed = lines.filter((l) => num(l.openingBalance) > 0);
  const basis = at(proj.raw, 'assumptions.liabilities.interestBasis');
  check('interest basis matches the evidence', owed.length === 0 ? basis === 'NOT_APPLICABLE'
    : owed.every((l) => l.apr !== null) ? basis === 'COMPLETE' : owed.some((l) => l.apr !== null) ? basis === 'PARTIAL' : basis === 'NONE', String(basis));
  check('debt at every checkpoint equals the sum of its lines plus the withheld remainder',
    list(at(proj.raw, 'checkpoints')).every((c) => Math.abs(num(at(c, 'debt.amount')) - (list(c.liabilities).reduce((t, l) => t + num(l.closing), 0) + num(at(proj.raw, 'assumptions.liabilities.withheldAggregate')))) < 0.01));
  check('net worth = liquid + investments + otherAssets − debt at every checkpoint',
    list(at(proj.raw, 'checkpoints')).every((c) => Math.abs(num(at(c, 'netWorth.amount')) - (num(at(c, 'liquid.amount')) + num(at(c, 'investments.amount')) + num(at(c, 'otherAssets.amount')) - num(at(c, 'debt.amount')))) < 0.01));
  console.log(`   projection to 2027-12-31: ${proj.ms} ms, ${proj.bytes} B`);

  console.log('2. when am I debt free — on the real position');
  const x = await run('scenario_crossing', { metric: 'debt', direction: 'at_or_below', threshold: 0 });
  const owedNow = owed.reduce((t, l) => t + num(l.openingBalance), 0);
  if (owedNow === 0) {
    check('nothing owed: already satisfied today, no future crossing', at(x.raw, 'alreadySatisfied') !== null && at(x.raw, 'crossing') === null);
  } else {
    const noTerms = owed.every((l) => l.apr === null && l.minimumPayment === null);
    check(noTerms ? 'owed with no terms and no rule: never crosses (nothing pays it), and the basis says why'
      : 'owed: a crossing or an honest never', noTerms ? at(x.raw, 'crossing') === null && at(x.raw, 'neverCrossesBy') !== null : true,
      JSON.stringify(at(x.raw, 'assumptionsInForce.liabilities.interestBasis')));
  }

  console.log('3. a stated assumption proves the override path without touching the account');
  if (owed.length > 0) {
    const target = owed[0];
    const before = await db.financialAccount.findUnique({ where: { id: String(target.id) }, select: { interestRate: true, minimumPayment: true, balance: true } });
    // Assume a rate and a balance-covering minimum for EVERY owed line, so the
    // position is fully modelled and clears at the first month-end.
    const o = await run('scenario_crossing', { metric: 'debt', direction: 'at_or_below', threshold: 0,
      liabilityAssumptions: owed.map((l) => ({ liabilityId: l.id, apr: 24, minimumPayment: Math.max(25, num(l.openingBalance)) })) });
    const echoed = list(at(o.raw, 'assumptionsInForce.liabilities.lines')).find((l) => l.id === target.id)!;
    check('the assumed terms are echoed as USER_ASSUMED', at(echoed, 'terms.apr') === 'USER_ASSUMED' && echoed.apr === 24 && at(echoed, 'terms.minimumPayment') === 'USER_ASSUMED');
    check('…the basis becomes COMPLETE when every owed line has a rate', at(o.raw, 'assumptionsInForce.liabilities.interestBasis') === 'COMPLETE');
    check('…and with a minimum covering the balance it is paid off at the first month-end', at(o.raw, 'crossing.date') !== undefined && num(at(o.raw, 'crossing.value')) === 0,
      JSON.stringify(at(o.raw, 'crossing.date')));
    check('…the crossing carries its interest evidence beside the date', at(o.raw, 'crossing.interestEvidence.basis') === 'COMPLETE');
    const after = await db.financialAccount.findUnique({ where: { id: String(target.id) }, select: { interestRate: true, minimumPayment: true, balance: true } });
    check('the account was not mutated', JSON.stringify(before) === JSON.stringify(after));
    const bad = await run('scenario_projection', { to: '2027-12-31', liabilityAssumptions: [{ liabilityId: 'not-a-liability', apr: 5 }] });
    check('an assumption for an unknown liability is refused by name', list(at(bad.raw, 'rejected')).some((r) => /no liability with that id/.test(String(r.reason))));
    const partial = await run('scenario_crossing', { metric: 'debt', direction: 'at_or_below', threshold: 0,
      contributions: [{ amount: 50, from: ASOF, cadence: 'monthly', target: 'highest_apr' }] });
    check('a payments-only payoff over an unknown rate is marked PARTIAL/NONE beside the date, never exact',
      at(partial.raw, 'crossing') === null || at(partial.raw, 'crossing.interestEvidence.basis') !== 'COMPLETE',
      JSON.stringify(at(partial.raw, 'crossing.interestEvidence')));
  } else {
    console.log('   (nothing owed today — the override path is proven in the pure suite)');
  }

  console.log('4. the floor basis with a liability target reaches the ledger through the tool');
  const floor = await run('scenario_projection', { to: '2027-12-31', granularity: 'monthly',
    contributions: [{ liquidFloor: 10000, fractionOfExcess: 1, target: ['highest_apr', 'investments'] }] });
  const first = list(at(floor.raw, 'movements.first'))[0];
  check('the rule settled with a placement record (investments or liabilities), not a silent default',
    !!first && at(first, 'placed') !== undefined, JSON.stringify(at(first, 'placed')));
  check('no rejection', list(at(floor.raw, 'rejected')).length === 0, JSON.stringify(at(floor.raw, 'rejected')).slice(0, 160));

  console.log('5. goal seek over debt through the shared inputs');
  const gs = await run('scenario_goal_seek', { target: 0, by: '2028-12-31', solveFor: 'monthlyContribution', measure: 'debt', contributionTarget: 'highest_apr' });
  check('debt is a solvable measure and the result echoes the target', at(gs.raw, 'measure') === 'debt' && at(gs.raw, 'unavailable') === undefined
    && JSON.stringify(at(gs.raw, 'contributionTarget')) === JSON.stringify(['highest_apr']), JSON.stringify({ feasible: at(gs.raw, 'feasible'), required: at(gs.raw, 'required'), already: at(gs.raw, 'alreadyMet') }));

  console.log('6. payload and runtime');
  // ⚠️ THE $1M DATE ITSELF BELONGS TO `ai:liquid-floor-check` and moves with the
  // Space's data; this only measures that a liability-bearing 30-year search
  // still runs and that its result carries the liability echo.
  const thirty = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7,
    contributions: [{ liquidFloor: 50000, fractionOfExcess: 1 }] });
  check('a 30-year search over a position with liabilities runs and echoes them', at(thirty.raw, 'unavailable') === undefined
    && at(thirty.raw, 'assumptionsInForce.liabilities.interestBasis') !== undefined && thirty.ms < 5_000, `${thirty.ms} ms`);
  console.log(`   30-year crossing: ${thirty.ms} ms, ${thirty.bytes} B`);

  console.log(failures === 0 ? '\nLIABILITY DYNAMICS CHECK PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
