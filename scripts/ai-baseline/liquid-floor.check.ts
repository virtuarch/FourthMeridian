/**
 * scripts/ai-baseline/liquid-floor.check.ts
 *
 * KEEP THIS MUCH LIQUID; INVEST A SHARE OF WHAT IS ABOVE IT — against real data.
 *
 * `lib/ai/conversation/liquid-floor-contribution.test.ts` pins the arithmetic
 * purely and runs in CI. This proves what a fixture cannot: that the production
 * tools, over the live Space's own cash spine, reproduce the figures the
 * investigation's prototype produced (docs/plans/AI-SCENARIO-LIQUID-FLOOR-
 * INVESTIGATION.md §23) — the $50k crossing, the $1M crossing with cash held at
 * exactly the floor, and each one-field revision. Read-only; nothing is written.
 *
 * ⚠️ THE EXPECTED NUMBERS ARE THE SPACE'S ON 2026-09-13. They move when the
 * Space's data moves; a drift here is a change in the data or in the spine, and
 * the right response is to investigate which, not to update the figure.
 *
 *   npm run ai:liquid-floor-check
 */
import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { findTool, type ToolContext } from '@/lib/ai/conversation/tools';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? '2026-09-13';
let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); if (!cond) failures++; };

async function main() {
  const space = await db.space.findUniqueOrThrow({ where: { id: SPACE } });
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId: SPACE, role: 'OWNER', status: 'ACTIVE' } });
  const spaceCtx = { userId: owner.userId, spaceId: SPACE, role: 'OWNER', permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category, isPublic: space.isPublic, reportingCurrency: space.reportingCurrency } } as unknown as SpaceContext;
  const toolCtx: ToolContext = { spaceCtx, spaceId: SPACE, asOfISO: ASOF };
  /** One tool result, read by dotted path. Everything here is a JSON payload a model would read. */
  type Payload = { at: (path: string) => unknown; raw: unknown };
  const read = (raw: unknown): Payload => ({ raw,
    at: (path) => path.split('.').reduce<unknown>((v, k) =>
      (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), raw) });
  const run = async (name: string, args: Record<string, unknown>) => {
    const t0 = Date.now(); const raw = await findTool(name)!.run(args, toolCtx);
    return { r: read(raw), ms: Date.now() - t0, bytes: JSON.stringify(raw).length };
  };
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v as Record<string, unknown>[] : []);
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
  const floor = (liquidFloor: number, fractionOfExcess: number) => [{ liquidFloor, fractionOfExcess }];

  console.log('1. current-trend $50k liquid');
  const q1 = await run('scenario_crossing', { metric: 'liquid', direction: 'at_or_above', threshold: 50000 });
  check('2027-02-28, 54,044.40, previous 47,472.04', q1.r.at('crossing.date') === '2027-02-28' && q1.r.at('crossing.value') === 54044.4
    && q1.r.at('crossing.previousCheckpoint.value') === 47472.04, JSON.stringify(q1.r.at('crossing')).slice(0, 120));

  console.log('2. floor 50k / 100% / 7% → $1M');
  const q2 = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7, contributions: floor(50000, 1) });
  const fr = read(q2.r.at('assumptionsInForce.contributions.floorRule'));
  check('crossing 2035-02-28', q2.r.at('crossing.date') === '2035-02-28', String(q2.r.at('crossing.date')));
  check('net worth 1,001,443.24', q2.r.at('crossing.value') === 1001443.24, String(q2.r.at('crossing.value')));
  check('liquid 50,000.00', q2.r.at('crossing.composition.liquid') === 50000, String(q2.r.at('crossing.composition.liquid')));
  check('investments 951,443.24', q2.r.at('crossing.composition.investments') === 951443.24, String(q2.r.at('crossing.composition.investments')));
  check('previous net worth 989,979.48', q2.r.at('crossing.previousCheckpoint.value') === 989979.48, String(q2.r.at('crossing.previousCheckpoint.value')));
  check('floorRule echoed: first month-end at/above floor 2027-02-28', fr.at('firstMonthEndAtOrAboveFloor') === '2027-02-28', JSON.stringify(fr.raw));
  check('…not already above the floor at start; 5 run-up months; 0 months below after it was reached',
    fr.at('alreadyAboveFloorAtStart') === false && fr.at('monthsBeforeFloorReached') === 5 && fr.at('monthsBelowFloor') === 0,
    `${fr.at('monthsBeforeFloorReached')} / ${fr.at('monthsBelowFloor')}`);
  check('…horizon echoed in assumptionsInForce', typeof q2.r.at('assumptionsInForce.horizon.to') === 'string', String(q2.r.at('assumptionsInForce.horizon.to')));
  console.log(`   ${q2.ms} ms, ${q2.bytes} B, months examined ${q2.r.at('searchedThrough.monthsExamined')}`);
  const proj = await run('scenario_projection', { to: '2027-03-31', granularity: 'monthly', annualReturnPct: 7, contributions: floor(50000, 1) });
  const first = list(proj.r.at('movements')).find((m) => m.kind === 'CONTRIBUTION' && num(m.amount) > 0);
  check('first floor contribution 2027-02-28 of 4,044.40', first?.date === '2027-02-28' && first?.amount === 4044.4, JSON.stringify(first));
  check('projection at 2027-02-28 shows liquid 50,000', read(list(proj.r.at('checkpoints')).find((c) => c.date === '2027-02-28')).at('liquid.amount') === 50000);
  console.log(`   projection to 2027-03-31: ${proj.ms} ms, ${proj.bytes} B`);

  console.log('3. revisions');
  const q75 = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7, contributions: floor(75000, 1) });
  check('$75k floor → 2035-03-31', q75.r.at('crossing.date') === '2035-03-31', `${q75.r.at('crossing.date')} liquid ${q75.r.at('crossing.composition.liquid')}`);
  const q5 = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 5, contributions: floor(50000, 1) });
  check('5% → 2035-09-30', q5.r.at('crossing.date') === '2035-09-30', String(q5.r.at('crossing.date')));
  const qh = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7, contributions: floor(50000, 0.5) });
  check('50% of excess → 2035-03-31', qh.r.at('crossing.date') === '2035-03-31', String(qh.r.at('crossing.date')));
  check('…with liquid NOT pinned at 50k (58,941.90)', qh.r.at('crossing.composition.liquid') === 58941.9, String(qh.r.at('crossing.composition.liquid')));
  const q2m = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 2_000_000, annualReturnPct: 7, contributions: floor(50000, 1) });
  check('$2M → 2040-08-31', q2m.r.at('crossing.date') === '2040-08-31', String(q2m.r.at('crossing.date')));

  console.log('4. conservation on the real spine at 0%');
  const base = await run('scenario_projection', { to: '2056-09-13', granularity: 'monthly' });
  const zero = await run('scenario_projection', { to: '2056-09-13', granularity: 'monthly', contributions: floor(50000, 1) });
  const zeroCps = list(zero.r.at('checkpoints')); const baseCps = list(base.r.at('checkpoints'));
  const maxDiff = Math.max(...zeroCps.map((c, i) => Math.abs(num(read(c).at('netWorth.amount')) - num(read(baseCps[i]).at('netWorth.amount')))));
  check('max net-worth difference vs baseline = 0.00 across the (clamped) monthly checkpoints', maxDiff === 0, `${maxDiff} over ${zeroCps.length} checkpoints`);
  console.log(`   30-year monthly projection: ${zero.ms} ms, ${zero.bytes} B (baseline ${base.bytes} B)`);

  console.log('5. goal seek receives the rule');
  const gs = await run('scenario_goal_seek', { target: 1_000_000, by: '2035-02-28', solveFor: 'annualReturnPct', contributions: floor(50000, 1) });
  check('solves to ≈7% for the date the 7% crossing found', gs.r.at('feasible') === true && Math.abs(num(gs.r.at('required')) - 7) < 0.05, `required ${gs.r.at('required')}, reached ${gs.r.at('reachedAtSolution')}`);
  check('assumptionsInForce echoes the floor rule and the horizon', gs.r.at('assumptionsInForce.contributions.floorRule.liquidFloor') === 50000
    && gs.r.at('assumptionsInForce.horizon.to') === '2035-02-28', JSON.stringify(gs.r.at('assumptionsInForce.horizon')));
  const gsProj = gs.r.at('scenario.assumptions.horizon.to');
  check('…the same field the projection presents', gsProj === '2035-02-28', String(gsProj));

  console.log('6. malformed rule reaches the ledger\'s refusal, not a silent default');
  const bad = await run('scenario_projection', { to: '2027-12-31', contributions: [{ liquidFloor: 50000, fractionOfExcess: 1, surplusFraction: 0.5 }] });
  check('two bases rejected', list(bad.r.at('rejected')).length === 1 && /EXACTLY ONE/.test(String(list(bad.r.at('rejected'))[0].reason)) && list(bad.r.at('movements')).length === 0, String(list(bad.r.at('rejected'))[0]?.reason).slice(0, 80));
  const half = await run('scenario_projection', { to: '2027-12-31', contributions: [{ liquidFloor: 50000 }] });
  check('a floor without a share rejected', list(half.r.at('rejected')).length === 1 && /go together/.test(String(list(half.r.at('rejected'))[0].reason)));

  console.log(failures === 0 ? '\nACCEPTANCE PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
