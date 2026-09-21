/**
 * scripts/ai-baseline/planning-continuity.check.ts
 *
 * STAGED CONDITIONS, THROUGH THE PRODUCTION TOOLS, OVER A REAL SPACE — no model.
 *
 * `pending-plan.test.ts` pins the primitive purely. This proves what only the
 * real tools can: that a staged plan reaches the scenario that runs, that the
 * echo claims only what ran, that `project_cash` will not answer the plan's
 * question without it, and that staging stops once a scenario has run.
 *
 * ⚠️ RELATIONAL, NO LIVE MONEY PINNED, and it refuses to start anywhere but a clone.
 *
 *   FM_DB_GUARD=clone-only DATABASE_URL=…/fintracker_<clone> npm run ai:planning-check
 */
import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { findTool, type ToolContext } from '@/lib/ai/conversation/tools';
import { serverDatabaseRefusal } from '@/lib/db/live-guard';
import { emptyPlan } from '@/lib/ai/conversation/pending-plan';
import { turnEvidence } from '@/lib/ai/conversation/memory-model';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
const JAN = `${Number(ASOF.slice(0, 4)) + 1}-01-01`;
const TO = `${Number(ASOF.slice(0, 4)) + 1}-12-31`;

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); if (!cond) failures++; };
const at = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((v, k) =>
  (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

async function main() {
  const [{ current_database: live }] = await db.$queryRawUnsafe<{ current_database: string }[]>('select current_database()');
  const refusal = serverDatabaseRefusal(live);
  if (refusal) { console.error(refusal); process.exit(2); }
  console.log(`planning-continuity — Space ${SPACE} as of ${ASOF} on ${live}\n`);

  const space = await db.space.findUniqueOrThrow({ where: { id: SPACE } });
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId: SPACE, role: 'OWNER', status: 'ACTIVE' } });
  const said: string[] = [];
  const ctx: ToolContext = {
    spaceCtx: { userId: owner.userId, spaceId: SPACE, role: 'OWNER',
      permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true }, space } as unknown as SpaceContext,
    spaceId: SPACE, asOfISO: ASOF, plan: { pending: emptyPlan() } };
  const userSays = (t: string) => { said.push(t); ctx.turn = turnEvidence([...said], []); };
  const run = (n: string, a: Record<string, unknown>) => findTool(n)!.run(a, ctx) as Promise<Record<string, unknown>>;

  console.log('1. four bare turns, then one question');
  userSays('Starting January my income increases 10%.');
  await run('stage_assumptions', { incomeChanges: [{ op: 'SCALE', from: JAN, multiplier: 1.1 }] });
  userSays('Keep nine months of expenses in cash.');
  await run('stage_assumptions', { contributions: [{ liquidFloorMonthsOfExpenses: 9 }] });
  userSays('Pay highest APR debt first.');
  await run('stage_assumptions', { contributions: [{ fractionOfExcess: 1, target: ['highest_apr'] }] });
  userSays('Invest everything above the floor.');
  await run('stage_assumptions', { contributions: [{ target: ['highest_apr', 'investments'] }] });
  check('four statements held as TWO clauses (one raise, one floor rule)', ctx.plan!.pending.clauses.length === 2);

  userSays('What do I have next December?');
  const pc = await run('project_cash', { to: TO });
  check('project_cash will not answer the plan\'s question without the plan', typeof pc.unavailable === 'string'
    && String(pc.instead).includes('scenario_projection'));
  const pcRetro = await run('project_cash', { to: TO, asOf: new Date(Date.parse(`${ASOF}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) });
  check('…nor slip past it with asOf = yesterday', typeof pcRetro.unavailable === 'string');
  const pcOn = await run('project_cash', { to: TO, ignoreStaged: true });
  check('…and the current trend on purpose says what it left out', !!pcOn.leftOutOnPurpose);

  const r = await run('scenario_projection', { to: TO });
  const cl = at(r, 'assumptions.clauses') as Record<string, { ran?: boolean }>;
  check('a bare scenario call RAN the raise', cl.incomeChange?.ran === true);
  check('…the floor', cl.cashFloor?.ran === true);
  check('…and the highest-APR waterfall', cl.debtPaydown?.ran === true);
  const ids = ((at(r, 'assumptions.fromEarlierInConversation.clauses') as { id: string }[]) ?? []).map((c) => c.id);
  check('…and names both staged clauses as the user\'s, from earlier', ids.join(',') === 'p1,p2', ids.join(','));
  const ran = at(r, 'assumptions.argumentsRun') as Record<string, unknown[]>;
  check('`argumentsRun` holds what ran, for the envelope', Array.isArray(ran.incomeChanges) && Array.isArray(ran.contributions));

  console.log('\n2. REVIEW BLOCKER 1 — this turn\'s correction beats a staged figure');
  const ctx2: ToolContext = { ...ctx, plan: { pending: emptyPlan() } };
  said.length = 0; said.push('up 10% from January'); ctx2.turn = turnEvidence([...said], []);
  await findTool('stage_assumptions')!.run({ incomeChanges: [{ op: 'SCALE', from: JAN, multiplier: 1.1 }] }, ctx2);
  said.push('Actually make it 15% — what do I have at the end of next year?'); ctx2.turn = turnEvidence([...said], []);
  const c15 = await findTool('scenario_projection')!.run({ to: TO,
    incomeChanges: [{ op: 'SCALE', from: JAN, multiplier: 1.15 }] }, ctx2) as Record<string, unknown>;
  const m15 = ((at(c15, 'assumptions.argumentsRun.incomeChanges') as { multiplier: number }[]) ?? []).map((x) => x.multiplier);
  check('it RAN at 1.15, not the staged 1.1', m15.join(',') === '1.15', m15.join(','));
  check('…and reports the staged 1.1 as superseded, not applied',
    JSON.stringify(at(c15, 'assumptions.fromEarlierInConversation.supersededByThisCall.clauses')).includes('p1')
    && ((at(c15, 'assumptions.fromEarlierInConversation.clauses') as unknown[]) ?? []).length === 0);

  console.log('\n3. REVIEW BLOCKER 2 — a staged clause the engine refuses is not claimed, nor lost');
  const ctx3: ToolContext = { ...ctx, plan: { pending: emptyPlan() } };
  said.length = 0; said.push('my contract income stops after June; and a $5,000 bill in March'); ctx3.turn = turnEvidence([...said], []);
  await findTool('stage_assumptions')!.run({ incomeChanges: [{ op: 'STOP', from: `${JAN.slice(0, 4)}-07-01`, source: 'NOPE@bogus' }],
    outflows: [{ onDate: `${JAN.slice(0, 4)}-03-01`, amount: 5000 }] }, ctx3);
  const r3 = await findTool('scenario_projection')!.run({ to: TO }, ctx3) as Record<string, unknown>;
  const claimed = ((at(r3, 'assumptions.fromEarlierInConversation.clauses') as { id: string; argument: string }[]) ?? []);
  const notApplied = JSON.stringify(at(r3, 'assumptions.notApplied'));
  check('the engine refused the bogus source', /NOPE@bogus|rule i1/.test(notApplied));
  check('…and the echo does NOT claim that clause applied', !claimed.some((c) => c.argument === 'incomeChanges'),
    JSON.stringify(claimed));
  check('…it is reported not confirmed',
    JSON.stringify(at(r3, 'assumptions.fromEarlierInConversation.notConfirmed')).includes('incomeChanges'));

  console.log('\n4. after a run, staging stops; a change is a re-run');
  const ctx4: ToolContext = { ...ctx, plan: { pending: emptyPlan(), scenarioRan: true } };
  const s4 = await findTool('stage_assumptions')!.run({ incomeChanges: [{ op: 'SCALE', from: JAN, multiplier: 1.15 }] }, ctx4) as Record<string, unknown>;
  check('staging is refused once a scenario has run', typeof s4.unavailable === 'string');
  const s4r = await findTool('stage_assumptions')!.run({ retract: ['p9'] }, ctx4) as Record<string, unknown>;
  check('…but a withdrawal is still accepted', s4r.unavailable === undefined);

  console.log('\n5. nothing durable was written by staging or by a scenario');
  const rows = await db.spaceMemory.count({ where: { spaceId: SPACE, kind: { not: 'CHECKPOINT' } } });
  check('no stated memory row exists after all of the above', rows === 0, `${rows} rows`);

  await db.$disconnect();
  if (failures > 0) { console.error(`\nplanning-continuity: ${failures} failure(s).`); process.exit(1); }
  console.log('\nplanning-continuity: all passed.');
}
void main();
