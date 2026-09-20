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
 * ⚠️ NOTHING HERE ASSUMES WHAT THE SPACE'S DEBT LOOKS LIKE TODAY. The first
 * version was written while the dogfood Space carried a few dollars on one card
 * and NO stated terms, and one assertion quietly depended on that: "a
 * payments-only payoff over an unknown rate is PARTIAL/NONE". On 2026-09-20 the
 * owner entered both APRs, COMPLETE became the correct answer, and the harness
 * reported a regression. A second assertion failed the other way — with terms
 * present, "owed: a crossing or an honest never" reduced to `true` and guarded
 * nothing.
 *
 * So the position is READ FIRST and every expectation is derived from it:
 * which owed lines have a rate decides the basis that must be reported (NONE /
 * PARTIAL / COMPLETE / NOT_APPLICABLE), which have a stated minimum decides
 * whether anything pays the debt down, and the script prints the branch that
 * ran. What an unknown rate MEANS — nothing accrues, payments still clear it,
 * the date is a lower bound, the basis is never COMPLETE — is pinned purely in
 * `liability-dynamics.test.ts` (sections I and I2), where it cannot depend on
 * anybody's cards. Nothing here fabricates debt; the cases that need terms use
 * `liabilityAssumptions` on whatever is owed today. The as-of is today (or
 * `CHECK_AS_OF`) and every horizon is derived from it. Read-only.
 *
 *   npm run ai:liability-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { cpus, loadavg } from 'node:os';
import { findTool, monthEndsBetween, type ToolContext } from '@/lib/ai/conversation/tools';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
/** Month-ends after the as-of: [14] is fifteen months out, [26] a little over two years. */
const MONTH_ENDS = monthEndsBetween(ASOF, new Date(Date.parse(`${ASOF}T00:00:00Z`) + 900 * 86_400_000).toISOString().slice(0, 10));
const HORIZON = MONTH_ENDS[14];
const GOAL_BY = MONTH_ENDS[26];
/**
 * ⚠️ A WALL-CLOCK BUDGET IS A FACT ABOUT THE MACHINE AS WELL AS THE CODE. The
 * 30-year search ran inside its 5 s alone, and took 11–38 s beside five other
 * agents at a load average of 12–24 — with CPU time inflated too, so that is no
 * refuge. A budget means something only on a machine that is not saturated, so
 * that is the precondition, read from the OS and said out loud; on a saturated
 * machine the figure is printed and NOT asserted, and the run says so.
 */
const TIME_BUDGET_MS = Number(process.env.CHECK_TIME_BUDGET_MS ?? 5_000);
const LOAD = loadavg()[0], CORES = cpus().length;
const SATURATED = LOAD > CORES;
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
    const t0 = Date.now(); const c0 = process.cpuUsage(); const raw = await findTool(name)!.run(args, toolCtx);
    const cpu = process.cpuUsage(c0);
    return { raw, ms: Date.now() - t0, cpuMs: Math.round((cpu.user + cpu.system) / 1000), bytes: JSON.stringify(raw).length };
  };

  console.log(`Space ${SPACE} as of ${ASOF} → horizon ${HORIZON}\n`);
  console.log('1. the position\'s liabilities become the scenario\'s lines');
  const snap = await run('get_financial_snapshot', {});
  const debtRows = list(snap.raw && (snap.raw as Rec).accounts).filter((r) => r.type === 'debt');
  const gaps = list(at(snap.raw, 'missingDebtFields'));
  const proj = await run('scenario_projection', { to: HORIZON });
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
  // ⚠️ THE PRECONDITION, READ FROM THE POSITION AND SAID OUT LOUD. Everything
  // below that depends on whether a rate is known asks THIS, never the calendar.
  const unrated = owed.filter((l) => l.apr === null);
  const expectedBasis = owed.length === 0 ? 'NOT_APPLICABLE' : unrated.length === 0 ? 'COMPLETE'
    : unrated.length === owed.length ? 'NONE' : 'PARTIAL';
  console.log(`   branch: ${owed.length} owed line(s), ${unrated.length} with no known rate ⇒ the basis must be ${expectedBasis}`);
  check('interest basis matches the evidence', basis === expectedBasis, `${basis} vs ${expectedBasis}`);
  check('…the unmodelled list is exactly the owed lines with no rate — no more, no fewer',
    JSON.stringify(list(at(proj.raw, 'assumptions.liabilities.unmodelled')).map((u) => u.id).sort()) === JSON.stringify(unrated.map((l) => l.id).sort()));
  check('…a line with a rate accrues by the horizon; a line without one accrues nothing, ever',
    owed.every((l) => { const accrued = list(at(proj.raw, 'checkpoints')).reduce((t, c) => t + num(list(c.liabilities).find((x) => x.id === l.id)?.interest), 0);
      return l.apr === null ? accrued === 0 : num(l.apr) === 0 ? accrued === 0 : accrued > 0; }));
  check('debt at every checkpoint equals the sum of its lines plus the withheld remainder',
    list(at(proj.raw, 'checkpoints')).every((c) => Math.abs(num(at(c, 'debt.amount')) - (list(c.liabilities).reduce((t, l) => t + num(l.closing), 0) + num(at(proj.raw, 'assumptions.liabilities.withheldAggregate')))) < 0.01));
  check('net worth = liquid + investments + otherAssets − debt at every checkpoint',
    list(at(proj.raw, 'checkpoints')).every((c) => Math.abs(num(at(c, 'netWorth.amount')) - (num(at(c, 'liquid.amount')) + num(at(c, 'investments.amount')) + num(at(c, 'otherAssets.amount')) - num(at(c, 'debt.amount')))) < 0.01));
  console.log(`   projection to ${HORIZON}: ${proj.ms} ms, ${proj.bytes} B`);

  console.log('2. when am I debt free — on the real position');
  const x = await run('scenario_crossing', { metric: 'debt', direction: 'at_or_below', threshold: 0 });
  const owedNow = owed.reduce((t, l) => t + num(l.openingBalance), 0);
  if (owedNow === 0) {
    check('nothing owed: already satisfied today, no future crossing', at(x.raw, 'alreadySatisfied') !== null && at(x.raw, 'crossing') === null);
  } else {
    // ⚠️ WHAT PAYS IT DOWN IS A STATED MINIMUM OR A RULE — AND THIS CALL HAS NO RULE.
    // A rate alone only makes it grow. The old form of this check asserted `true`
    // the moment any term was present.
    const unpaid = owed.filter((l) => l.minimumPayment === null);
    const crossing = at(x.raw, 'crossing'), never = at(x.raw, 'neverCrossesBy');
    console.log(`   branch: ${unpaid.length} of ${owed.length} owed line(s) have no stated minimum`);
    check('exactly one answer: a crossing, or an honest never', (crossing === null) !== (never === null || never === undefined));
    if (unpaid.length > 0) {
      check('an owed line nothing pays never reaches zero — and the end of the search says what is still owed',
        crossing === null && num(at(never, 'value')) >= unpaid.reduce((t, l) => t + num(l.openingBalance), 0) - 0.005,
        `still ${at(never, 'value')} on ${at(never, 'date')}`);
    } else if (crossing !== null) {
      check('stated minimums on every owed line clear it: zero at the crossing, more than zero the month before',
        num(at(crossing, 'value')) === 0 && num(at(crossing, 'previousCheckpoint.value')) > 0, String(at(crossing, 'date')));
    }
    check('…under the basis the projection reported for the same position',
      at(x.raw, 'assumptionsInForce.liabilities.interestBasis') === expectedBasis
        && (crossing === null || at(crossing, 'interestEvidence.basis') === expectedBasis),
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
    // The minimum covers the OPENING balance; the first accrual is what is left for the second month-end.
    check('…and with a minimum covering the balance it is paid off by the second month-end',
      [MONTH_ENDS[0], MONTH_ENDS[1]].includes(String(at(o.raw, 'crossing.date'))) && num(at(o.raw, 'crossing.value')) === 0,
      JSON.stringify(at(o.raw, 'crossing.date')));
    check('…the crossing carries its interest evidence beside the date', at(o.raw, 'crossing.interestEvidence.basis') === 'COMPLETE');
    const after = await db.financialAccount.findUnique({ where: { id: String(target.id) }, select: { interestRate: true, minimumPayment: true, balance: true } });
    check('the account was not mutated', JSON.stringify(before) === JSON.stringify(after));
    const bad = await run('scenario_projection', { to: HORIZON, liabilityAssumptions: [{ liabilityId: 'not-a-liability', apr: 5 }] });
    check('an assumption for an unknown liability is refused by name', list(at(bad.raw, 'rejected')).some((r) => /no liability with that id/.test(String(r.reason))));
    const partial = await run('scenario_crossing', { metric: 'debt', direction: 'at_or_below', threshold: 0,
      contributions: [{ amount: 50, from: ASOF, cadence: 'monthly', target: 'highest_apr' }] });
    // ⚠️ THE STALE ASSUMPTION, MADE A PRECONDITION. A rule that only PAYS states no
    // rate, so the basis beside the payoff date is whatever the position's own
    // rates make it — and which that is, is read above, not presumed.
    const evidence = at(partial.raw, 'crossing.interestEvidence');
    check('a payments-only rule does not change what is known about the rates',
      at(partial.raw, 'assumptionsInForce.liabilities.interestBasis') === expectedBasis, String(at(partial.raw, 'assumptionsInForce.liabilities.interestBasis')));
    check('…and $50 a month does reach zero inside the search', at(partial.raw, 'crossing') !== null, JSON.stringify(at(partial.raw, 'neverCrossesBy.value')));
    if (unrated.length > 0) {
      console.log(`   branch: UNKNOWN RATE on ${unrated.map((l) => l.label).join(', ')} — the payoff must be marked ${expectedBasis}`);
      check('a payments-only payoff over an unknown rate is marked PARTIAL/NONE beside the date, never exact',
        at(evidence, 'basis') === expectedBasis && expectedBasis !== 'COMPLETE' && /LOWER BOUND/.test(String(at(evidence, 'reading')))
          && JSON.stringify(list(at(evidence, 'aprMissingFor')).sort()) === JSON.stringify(unrated.map((l) => l.label).sort()),
        JSON.stringify(evidence));
    } else {
      console.log('   branch: EVERY owed line has a known rate — the payoff must be COMPLETE, with nothing named as missing');
      check('a payments-only payoff over fully known rates is COMPLETE beside the date, and names no missing rate',
        at(evidence, 'basis') === 'COMPLETE' && list(at(evidence, 'aprMissingFor')).length === 0 && !/LOWER BOUND/.test(String(at(evidence, 'reading'))),
        JSON.stringify(evidence));
      console.log('   (the unknown-rate semantics are not reachable on this position; they are pinned in liability-dynamics.test.ts §I, §I2)');
    }
    // Interest is real: paying $50 a month takes at least as long as the balance alone implies.
    const months = monthEndsBetween(ASOF, String(at(partial.raw, 'crossing.date') ?? ASOF)).length;
    check('…and the date is no sooner than the balance divided by the payment allows',
      at(partial.raw, 'crossing') === null || months >= Math.ceil(owed.reduce((t, l) => t + num(l.openingBalance), 0) / 50) - 1,
      `${months} month-ends for ${owed.reduce((t, l) => t + num(l.openingBalance), 0)} owed`);
  } else {
    console.log('   (nothing owed today — the override path is proven in the pure suite)');
  }

  console.log('4. the floor basis with a liability target reaches the ledger through the tool');
  const floor = await run('scenario_projection', { to: HORIZON, granularity: 'monthly',
    contributions: [{ liquidFloor: 10000, fractionOfExcess: 1, target: ['highest_apr', 'investments'] }] });
  const first = list(at(floor.raw, 'movements.first'))[0];
  check('the rule settled with a placement record (investments or liabilities), not a silent default',
    !!first && at(first, 'placed') !== undefined, JSON.stringify(at(first, 'placed')));
  check('no rejection', list(at(floor.raw, 'rejected')).length === 0, JSON.stringify(at(floor.raw, 'rejected')).slice(0, 160));

  console.log('5. goal seek over debt through the shared inputs');
  const gs = await run('scenario_goal_seek', { target: 0, by: GOAL_BY, solveFor: 'monthlyContribution', measure: 'debt', contributionTarget: 'highest_apr' });
  check('debt is a solvable measure and the result echoes the target', at(gs.raw, 'measure') === 'debt' && at(gs.raw, 'unavailable') === undefined
    && JSON.stringify(at(gs.raw, 'contributionTarget')) === JSON.stringify(['highest_apr']), JSON.stringify({ feasible: at(gs.raw, 'feasible'), required: at(gs.raw, 'required'), already: at(gs.raw, 'alreadyMet') }));

  console.log('6. payload and runtime');
  // ⚠️ THE $1M DATE ITSELF BELONGS TO `ai:liquid-floor-check` and moves with the
  // Space's data; this only measures that a liability-bearing 30-year search
  // still runs and that its result carries the liability echo.
  const thirty = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7,
    contributions: [{ liquidFloor: 50000, fractionOfExcess: 1 }] });
  check('a 30-year search over a position with liabilities runs and echoes them', at(thirty.raw, 'unavailable') === undefined
    && at(thirty.raw, 'assumptionsInForce.liabilities.interestBasis') === expectedBasis
    && list(at(thirty.raw, 'assumptionsInForce.liabilities.lines')).length === lines.length);
  if (SATURATED) console.log(`   branch: MACHINE SATURATED (load ${LOAD.toFixed(1)} on ${CORES} cores) — the ${TIME_BUDGET_MS} ms budget is NOT asserted in this run; re-run on a quiet machine`);
  else check(`…inside its ${TIME_BUDGET_MS} ms budget (load ${LOAD.toFixed(1)} on ${CORES} cores)`, thirty.ms < TIME_BUDGET_MS, `${thirty.ms} ms`);
  console.log(`   30-year crossing: ${thirty.ms} ms wall, ${thirty.cpuMs} ms CPU, ${thirty.bytes} B`);

  console.log(failures === 0 ? '\nLIABILITY DYNAMICS CHECK PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
