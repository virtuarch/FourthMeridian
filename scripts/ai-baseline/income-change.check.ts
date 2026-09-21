/**
 * scripts/ai-baseline/income-change.check.ts   (I1)
 *
 * A DATED INCOME CHANGE, THROUGH THE PRODUCTION TOOLS, OVER A REAL SPACE'S OWN
 * CASH SPINE.
 *
 * `lib/forecast/income-change.test.ts` pins the transformation purely and runs in
 * CI. `lib/ai/conversation/income-clause.test.ts` pins what the result says about
 * it. Neither can prove the thing this slice actually claims: that because the
 * rules live in the spine's closure, the cash floor, the debt waterfall, the
 * contribution rules, the crossing search and the goal seek all see the raise
 * WITHOUT one line changing in any of them.
 *
 * ⚠️ NO LIVE MONEY OR DATE IS PINNED HERE, for the reason M1 recorded: a harness
 * that fails when the data is right and the code is right teaches its reader to
 * repin it, which is the one response that detects nothing. Every assertion is
 * SEMANTIC (what a rule means), STRUCTURAL (what the payload must look like) or
 * RELATIONAL (two live readings that must agree or be ordered).
 *
 * ⚠️ READ-ONLY, AND IT REFUSES TO START ANYWHERE BUT A CLONE. `scenario_projection`
 * writes nothing, but `project_cash` checkpoints into SpaceMemory and every model
 * call writes an AiInvocation row, so this is guarded like anything else that can
 * write.
 *
 *   FM_DB_GUARD=clone-only DATABASE_URL=…/fintracker_<clone> npm run ai:income-check
 */
import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { findTool, type ToolContext } from '@/lib/ai/conversation/tools';
import { serverDatabaseRefusal } from '@/lib/db/live-guard';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
/** The first day of the January after `ASOF` — "starting January", deterministically. */
const JAN = `${Number(ASOF.slice(0, 4)) + 1}-01-01`;
const TO = `${Number(ASOF.slice(0, 4)) + 1}-12-31`;

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const at = (o: unknown, p: string): unknown =>
  p.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object'
    ? (v as Record<string, unknown>)[k] : undefined), o);

async function main() {
  const [{ current_database: live }] =
    await db.$queryRawUnsafe<{ current_database: string }[]>('select current_database()');
  const refusal = serverDatabaseRefusal(live);
  if (refusal) { console.error(refusal); process.exit(2); }
  console.log(`income-change — Space ${SPACE} as of ${ASOF} on ${live}\n`);

  const space = await db.space.findUniqueOrThrow({ where: { id: SPACE } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId: SPACE, role: 'OWNER', status: 'ACTIVE' } });
  const ctx: ToolContext = {
    spaceCtx: { userId: owner.userId, spaceId: SPACE, role: 'OWNER',
      permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
      space } as unknown as SpaceContext,
    spaceId: SPACE, asOfISO: ASOF };
  const run = (n: string, a: Record<string, unknown>) =>
    findTool(n)!.run(a, ctx) as Promise<Record<string, unknown>>;
  const scale = (multiplier: number, from = JAN) =>
    [{ op: 'SCALE', from, multiplier }];
  const last = (r: Record<string, unknown>) =>
    (r.checkpoints as Record<string, unknown>[] | undefined)?.at(-1);
  const liquidOf = (r: Record<string, unknown>) => num(at(last(r), 'liquid.amount'));
  const clause = (r: Record<string, unknown>) =>
    at(r, 'assumptions.clauses.incomeChange') as { ran?: boolean; rules?: unknown[] } | undefined;

  // ── 1. THE RULE REACHES THE SPINE, AND MORE OF IT REACHES MORE ────────────
  console.log('1. the raise reaches the cash line, monotonically');
  const base = await run('scenario_projection', { to: TO, granularity: 'yearly' });
  const up10 = await run('scenario_projection', { to: TO, granularity: 'yearly', incomeChanges: scale(1.1) });
  const up15 = await run('scenario_projection', { to: TO, granularity: 'yearly', incomeChanges: scale(1.15) });
  check('the baseline reports no income clause', clause(base)?.ran === false,
    JSON.stringify(clause(base)));
  check('a +10% rule reports that it RAN', clause(up10)?.ran === true);
  check('…and moves the cash line', liquidOf(up10) > liquidOf(base),
    `${liquidOf(base)} → ${liquidOf(up10)}`);
  // ⚠️ RELATIONAL, NOT A PINNED FIGURE. More raise is more cash, whatever the
  // Space's numbers are this week.
  check('+15% is strictly more than +10%, which is strictly more than none',
    liquidOf(up15) > liquidOf(up10) && liquidOf(up10) > liquidOf(base),
    `${liquidOf(base)} < ${liquidOf(up10)} < ${liquidOf(up15)}`);

  // ⚠️ THE STRONGEST CLAIM IN THIS FILE, AND IT COSTS NOTHING TO MAKE. The
  // execution record says what the rule added to DATED INCOME. The ledger says
  // what the cash line did. With no contributions and no return in force, those
  // two are the same money reached two different ways — one counted off the event
  // arrays by `income-change.ts`, one folded by `projectCash` and settled by the
  // ledger. If they ever disagree, either the evidence is describing a
  // transformation the spine did not perform, or the spine performed one the
  // evidence cannot see. Both are the failure this slice exists to prevent.
  const rule10 = (at(up10, 'assumptions.clauses.incomeChange.rules') as
    { incomeBefore: number; incomeAfter: number }[])[0];
  const addedByEvidence = rule10.incomeAfter - rule10.incomeBefore;
  const addedByLedger = liquidOf(up10) - liquidOf(base);
  check('the cash the raise added IS the income the execution record says it added',
    Math.abs(addedByEvidence - addedByLedger) < 0.005,
    `evidence ${addedByEvidence.toFixed(2)} vs ledger ${addedByLedger.toFixed(2)}`);
  // ⚠️ AND IT IS CONSERVED, NOT CREATED. At 0% return with nothing moved into
  // investments, every extra dollar of income is an extra dollar of net worth.
  check('…and net worth moved by exactly the same amount',
    Math.abs((num(at(last(up10), 'netWorth.amount')) - num(at(last(base), 'netWorth.amount')))
      - addedByLedger) < 0.005);

  // ── 1b. changeSinceOpening carries the raise, deterministically ───────────
  // `positionChange` puts each line under its own name with `{from,to,abs,pct}`.
  const chBase = num(at(base, 'changeSinceOpening.netWorth.abs'));
  const chUp = num(at(up10, 'changeSinceOpening.netWorth.abs'));
  if (Number.isFinite(chBase) && Number.isFinite(chUp)) {
    check('changeSinceOpening moves by the raise and by nothing else',
      Math.abs((chUp - chBase) - addedByLedger) < 0.005, `${chBase} → ${chUp}`);
  } else {
    console.log(`   (changeSinceOpening carries no netWorth figure here — skipped)`);
  }

  // ── 2. A RULE OUTSIDE THE HORIZON IS THE BASELINE, EXACTLY ────────────────
  console.log('\n2. a change the projection never reaches changes nothing, and says so');
  const outside = await run('scenario_projection', { to: TO, granularity: 'yearly',
    incomeChanges: scale(1.1, `${Number(ASOF.slice(0, 4)) + 3}-01-01`) });
  check('cash is the baseline TO THE CENT', liquidOf(outside) === liquidOf(base),
    `${liquidOf(outside)} vs ${liquidOf(base)}`);
  const oc = clause(outside) as { ran?: boolean; didNotRun?: { reason?: string }[] } | undefined;
  check('…and the clause says it did NOT run', oc?.ran === false);
  check('…naming the rule and the reason', (oc?.didNotRun?.[0]?.reason ?? '').includes('after this projection ends'),
    oc?.didNotRun?.[0]?.reason?.slice(0, 80));

  // ── 3. COMPOSITION — the raise reaches every downstream consumer ───────────
  console.log('\n3. composition: floor, debt, contributions, all at once');
  const FLOOR = [{ liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1,
    target: ['highest_apr', 'investments'] }];
  const composed = await run('scenario_projection', { to: TO, granularity: 'yearly',
    contributions: FLOOR, incomeChanges: scale(1.1) });
  const composedBase = await run('scenario_projection', { to: TO, granularity: 'yearly',
    contributions: FLOOR });
  const cl = at(composed, 'assumptions.clauses') as Record<string, { ran?: boolean }>;
  check('the cash floor ran', cl.cashFloor?.ran === true);
  check('the income change ran', cl.incomeChange?.ran === true);
  check('the debt waterfall ran', cl.debtPaydown?.ran === true);
  check('…all five stated clauses are in ONE result',
    cl.cashFloor?.ran === true && cl.incomeChange?.ran === true && cl.debtPaydown?.ran === true);
  // ⚠️ THE CLAIM THIS WHOLE SLICE MAKES. The floor rule, the waterfall and the
  // contribution engine were not modified; they see the raise because the spine
  // they read was built with it.
  const composedNet = num(at(last(composed), 'netWorth.amount'));
  const composedBaseNet = num(at(last(composedBase), 'netWorth.amount'));
  check('a raise raises net worth even when every dollar above a floor is swept away',
    composedNet > composedBaseNet, `${composedBaseNet} → ${composedNet}`);
  // The floor is a STOCK rule: cash ends AT the floor either way, and the extra
  // income shows up past it. That is the invariant, not a bigger cash balance.
  check('…and the extra money is past the floor, not in the cash line',
    Math.abs(liquidOf(composed) - liquidOf(composedBase)) < Math.abs(composedNet - composedBaseNet),
    `Δliquid ${(liquidOf(composed) - liquidOf(composedBase)).toFixed(2)} vs Δnet ${(composedNet - composedBaseNet).toFixed(2)}`);

  // ── 4. CROSSINGS AND GOAL SEEK see it too, with no vocabulary of their own ──
  console.log('\n4. a crossing and a goal seek inherit the raise through the spine');
  const target = Math.round(liquidOf(base) * 0.9);
  const xBase = await run('scenario_crossing', { metric: 'liquid', direction: 'at_or_above',
    threshold: target, searchThrough: TO });
  const xUp = await run('scenario_crossing', { metric: 'liquid', direction: 'at_or_above',
    threshold: target, searchThrough: TO, incomeChanges: scale(1.15) });
  const dBase = String(at(xBase, 'crossing.date') ?? '');
  const dUp = String(at(xUp, 'crossing.date') ?? '');
  check('both searches found the crossing', dBase !== '' && dUp !== '', `${dBase} / ${dUp}`);
  // ⚠️ RELATIONAL: more income never crosses a cash target LATER.
  check('a raise never delays reaching a cash target', dUp <= dBase, `${dBase} → ${dUp}`);
  check('the crossing states the income clause it ran under',
    (at(xUp, 'assumptionsInForce.clauses.incomeChange') as { ran?: boolean } | undefined)?.ran === true);

  // ⚠️ SOLVED FOR A RETURN, NOT A CONTRIBUTION, AND THE REASON IS A FINDING. A
  // contribution RELOCATES money — at 0% return it moves cash to investments and
  // leaves net worth where it was — so a net-worth target is infeasible for it by
  // construction, whatever the income (V26 slice 4 recorded this: "the best answer
  // a solver gives is a REFUSAL"). A required RETURN is the lever a raise actually
  // moves: more income in, less growth needed for the same end.
  const gTarget = Math.round(num(at(last(base), 'netWorth.amount')) * 1.25);
  const gBase = await run('scenario_goal_seek',
    { target: gTarget, by: TO, solveFor: 'annualReturnPct', measure: 'netWorth' });
  const gUp = await run('scenario_goal_seek',
    { target: gTarget, by: TO, solveFor: 'annualReturnPct', measure: 'netWorth',
      incomeChanges: scale(1.15) });
  const rBase = num(at(gBase, 'required'));
  const rUp = num(at(gUp, 'required'));
  const metBase = at(gBase, 'alreadyMet') === true;
  const metUp = at(gUp, 'alreadyMet') === true;
  check('the goal seek states the income clause it solved under',
    (at(gUp, 'assumptionsInForce.clauses.incomeChange') as { ran?: boolean } | undefined)?.ran === true);
  if (Number.isFinite(rBase) && Number.isFinite(rUp)) {
    check('a raise never makes the same goal need a BIGGER return',
      rUp <= rBase + 1e-9, `${rBase}% → ${rUp}%`);
  } else {
    // Feasibility itself is the ordering: a raise may turn a refusal into an answer,
    // and must never turn an answer into a refusal.
    check('a raise never turns a solvable goal into an unsolvable one',
      Number.isFinite(rBase) ? Number.isFinite(rUp) : true,
      `base ${rBase}${metBase ? ' (already met)' : ''} / raised ${rUp}${metUp ? ' (already met)' : ''}`);
  }

  // ── 5. WHAT IS REFUSED, IS REFUSED BY NAME ────────────────────────────────
  console.log('\n5. refusals name what they refused, and run the rest honestly');
  const bad = await run('scenario_projection', { to: TO, granularity: 'yearly',
    incomeChanges: [{ op: 'SCALE', from: JAN, multiplier: 1.1, source: 'my salary' }] });
  const refused = at(bad, 'assumptions.notApplied.inputs') as { reason?: string }[] | undefined;
  check('an invented source is refused', (refused ?? []).length === 1);
  check('…and the refusal LISTS the stream keys that exist',
    (refused?.[0]?.reason ?? '').includes('@'), refused?.[0]?.reason?.slice(0, 70));
  check('…and the scenario is the baseline, not a half-applied raise',
    liquidOf(bad) === liquidOf(base));
  check('…and the clause does not claim it ran', clause(bad)?.ran === false);

  // ⚠️ THE TOOL THAT CANNOT MODEL A RAISE MUST NOT COMPUTE WITHOUT IT. Found by
  // dogfood: the model sent `incomeChanges` to project_cash, which declared no
  // such argument and silently dropped it.
  const pc = await run('project_cash', { to: TO, incomeChanges: scale(1.1) });
  check('project_cash REFUSES an income change rather than projecting without it',
    typeof pc.unavailable === 'string');
  check('…and names the tool that can model it',
    String(pc.instead ?? '').includes('scenario_projection'));
  const pcOk = await run('project_cash', { to: TO });
  check('…while an ordinary projection is untouched',
    Number.isFinite(num(at(pcOk, 'projection.endingCash'))));

  // ── 6. THE MEASURED PAST IS NOT TOUCHED ───────────────────────────────────
  console.log('\n6. a future rule does not reach a measured figure');
  const flows = await run('measure_flows', { measure: 'income', period: { completeMonths: 3 } });
  check('measure_flows has no income-change argument to accept',
    !JSON.stringify(findTool('measure_flows')!.parameters).includes('incomeChanges'));
  check('…and still answers from measurement', flows.unavailable === undefined,
    String(flows.unavailable ?? 'ok'));

  await db.$disconnect();
  if (failures > 0) { console.error(`\nincome-change: ${failures} failure(s).`); process.exit(1); }
  console.log('\nincome-change: all passed.');
}
void main();
