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

  const el = read(q1.r.at('crossing.elapsed'));
  check('…5 months, 15 days from asOf — about 5.5 months, about 0.46 years (Slice C)',
    el.at('months') === 5 && el.at('days') === 15 && el.at('monthsFractional') === 5.5 && el.at('years') === 0.46
      && el.at('label') === '5 months, 15 days', JSON.stringify(el.raw));
  check('…the month before carries its own distance', read(q1.r.at('crossing.previousCheckpoint.elapsed')).at('months') === 4);

  console.log('2. floor 50k / 100% / 7% → $1M');
  const q2 = await run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold: 1_000_000, annualReturnPct: 7, contributions: floor(50000, 1) });
  const fr = read(q2.r.at('assumptionsInForce.contributions.floorRule'));
  check('crossing 2035-02-28', q2.r.at('crossing.date') === '2035-02-28', String(q2.r.at('crossing.date')));
  check('net worth 1,001,443.24', q2.r.at('crossing.value') === 1001443.24, String(q2.r.at('crossing.value')));
  check('liquid 50,000.00', q2.r.at('crossing.composition.liquid') === 50000, String(q2.r.at('crossing.composition.liquid')));
  check('investments 951,443.24', q2.r.at('crossing.composition.investments') === 951443.24, String(q2.r.at('crossing.composition.investments')));
  check('previous net worth 989,979.48', q2.r.at('crossing.previousCheckpoint.value') === 989979.48, String(q2.r.at('crossing.previousCheckpoint.value')));
  check('…101 months, 15 days away, about 8.46 years', read(q2.r.at('crossing.elapsed')).at('months') === 101
    && read(q2.r.at('crossing.elapsed')).at('days') === 15 && read(q2.r.at('crossing.elapsed')).at('years') === 8.46, JSON.stringify(q2.r.at('crossing.elapsed')));
  check('floorRule echoed: first month-end at/above floor 2027-02-28', fr.at('firstMonthEndAtOrAboveFloor') === '2027-02-28', JSON.stringify(fr.raw));
  check('…not already above the floor at start; 5 run-up months; 0 months below after it was reached',
    fr.at('alreadyAboveFloorAtStart') === false && fr.at('monthsBeforeFloorReached') === 5 && fr.at('monthsBelowFloor') === 0,
    `${fr.at('monthsBeforeFloorReached')} / ${fr.at('monthsBelowFloor')}`);
  check('…horizon echoed in assumptionsInForce', typeof q2.r.at('assumptionsInForce.horizon.to') === 'string', String(q2.r.at('assumptionsInForce.horizon.to')));
  console.log(`   ${q2.ms} ms, ${q2.bytes} B, months examined ${q2.r.at('searchedThrough.monthsExamined')}`);
  const proj = await run('scenario_projection', { to: '2027-03-31', granularity: 'monthly', annualReturnPct: 7, contributions: floor(50000, 1) });
  const first = list(proj.r.at('movements.first')).find((m) => m.kind === 'CONTRIBUTION' && num(m.amount) > 0);
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
  // Thirty years of monthly detail exceeds the row ceiling, so both runs come back
  // thinned to the same coarser cadence — the comparison is still row for row.
  const base = await run('scenario_projection', { to: '2056-09-13', granularity: 'monthly' });
  const zero = await run('scenario_projection', { to: '2056-09-13', granularity: 'monthly', contributions: floor(50000, 1) });
  check('both runs returned the same dates', JSON.stringify(list(base.r.at('checkpoints')).map((c) => c.date))
    === JSON.stringify(list(zero.r.at('checkpoints')).map((c) => c.date)), String(zero.r.at('horizon.granularity')));
  const zeroCps = list(zero.r.at('checkpoints')); const baseCps = list(base.r.at('checkpoints'));
  const maxDiff = Math.max(...zeroCps.map((c, i) => Math.abs(num(read(c).at('netWorth.amount')) - num(read(baseCps[i]).at('netWorth.amount')))));
  check('max net-worth difference vs baseline = 0.00 across every returned checkpoint', maxDiff === 0, `${maxDiff} over ${zeroCps.length} checkpoints`);
  console.log(`   30-year projection (${zero.r.at('horizon.granularity')}): ${zero.ms} ms, ${zero.bytes} B (baseline ${base.bytes} B)`);

  console.log('5. goal seek receives the rule');
  const gs = await run('scenario_goal_seek', { target: 1_000_000, by: '2035-02-28', solveFor: 'annualReturnPct', contributions: floor(50000, 1) });
  check('solves to ≈7% for the date the 7% crossing found', gs.r.at('feasible') === true && Math.abs(num(gs.r.at('required')) - 7) < 0.05, `required ${gs.r.at('required')}, reached ${gs.r.at('reachedAtSolution')}`);
  check('the deadline carries its distance', read(gs.r.at('timeToTarget')).at('months') === 101 && read(gs.r.at('timeToTarget')).at('days') === 15);
  check('assumptionsInForce echoes the floor rule and the horizon', gs.r.at('assumptionsInForce.contributions.floorRule.liquidFloor') === 50000
    && gs.r.at('assumptionsInForce.horizon.to') === '2035-02-28', JSON.stringify(gs.r.at('assumptionsInForce.horizon')));
  const gsProj = gs.r.at('scenario.assumptions.horizon.to');
  check('…the same field the projection presents', gsProj === '2035-02-28', String(gsProj));

  console.log('6. malformed rule reaches the ledger\'s refusal, not a silent default');
  const bad = await run('scenario_projection', { to: '2027-12-31', contributions: [{ liquidFloor: 50000, fractionOfExcess: 1, surplusFraction: 0.5 }] });
  check('two bases rejected', list(bad.r.at('rejected')).length === 1 && /EXACTLY ONE/.test(String(list(bad.r.at('rejected'))[0].reason)) && list(bad.r.at('movements')).length === 0, String(list(bad.r.at('rejected'))[0]?.reason).slice(0, 80));
  const half = await run('scenario_projection', { to: '2027-12-31', contributions: [{ liquidFloor: 50000 }] });
  check('a floor without a share rejected', list(half.r.at('rejected')).length === 1 && /go together/.test(String(list(half.r.at('rejected'))[0].reason)));

  console.log('7. a quarterly table of the same scenario, from the same ledger (Slice B)');
  const qt = await run('scenario_projection', { to: '2035-02-28', granularity: 'quarterly', annualReturnPct: 7, contributions: floor(50000, 1) });
  const rows = list(qt.r.at('checkpoints'));
  const row = (d: string) => read(rows.find((c) => c.date === d));
  check('quarterly was returned as requested, nothing omitted',
    qt.r.at('horizon.granularity') === 'quarterly' && qt.r.at('horizon.cadenceSource') === 'REQUESTED' && qt.r.at('horizon.omitted') === undefined,
    JSON.stringify(qt.r.at('horizon')));
  check('35 rows, ending at the horizon', rows.length === 35 && rows[rows.length - 1].date === '2035-02-28', String(rows.length));
  check('2027-03-31: liquid 50,000.00 / investments 34,675.38 / net worth 84,675.38',
    row('2027-03-31').at('liquid.amount') === 50000 && row('2027-03-31').at('investments.amount') === 34675.38 && row('2027-03-31').at('netWorth.amount') === 84675.38,
    JSON.stringify([row('2027-03-31').at('liquid.amount'), row('2027-03-31').at('investments.amount'), row('2027-03-31').at('netWorth.amount')]));
  check('2029-12-31: liquid 50,000.00 / investments 301,271.97 / net worth 351,271.97',
    row('2029-12-31').at('liquid.amount') === 50000 && row('2029-12-31').at('investments.amount') === 301271.97 && row('2029-12-31').at('netWorth.amount') === 351271.97,
    JSON.stringify([row('2029-12-31').at('liquid.amount'), row('2029-12-31').at('investments.amount'), row('2029-12-31').at('netWorth.amount')]));
  check('the last quarterly row IS the crossing the search found', row('2035-02-28').at('netWorth.amount') === 1001443.24);
  const monthly = await run('scenario_projection', { to: '2029-12-31', granularity: 'monthly', annualReturnPct: 7, contributions: floor(50000, 1) });
  const mrows = list(monthly.r.at('checkpoints'));
  check('every quarterly row through 2029 equals the same date\'s row in the monthly run — one ledger, no second path',
    rows.filter((c) => String(c.date) <= '2029-12-31').every((c) => {
      const m = mrows.find((x) => x.date === c.date); return !!m && read(m).at('netWorth.amount') === read(c).at('netWorth.amount') && read(m).at('liquid.amount') === read(c).at('liquid.amount'); }));
  const mv = read(qt.r.at('movements'));
  check('movements are compacted: 102 counted, 12 shown, total conserved',
    mv.at('count') === 102 && list(mv.at('first')).length === 12 && mv.at('compacted') === true
      && mv.at('contributions.total') === row('2035-02-28').at('movements.contributionsToDate.total'), JSON.stringify([mv.at('count'), mv.at('contributions.total')]));
  console.log(`   quarterly to 2035-02-28: ${qt.ms} ms, ${qt.bytes} B`);
  const thinned = await run('scenario_projection', { to: '2035-02-28', granularity: 'monthly', annualReturnPct: 7, contributions: floor(50000, 1) });
  check('explicit monthly past the ceiling is thinned to quarterly and says which dates fell out',
    thinned.r.at('horizon.granularity') === 'quarterly' && thinned.r.at('horizon.requested') === 'monthly'
      && read(thinned.r.at('horizon.omitted')).at('count') === 67 && read(thinned.r.at('horizon.omitted')).at('how') === 'THINNED',
    JSON.stringify(thinned.r.at('horizon.omitted')));
  check('…and the dates once invented by the model are real rows now',
    ['2033-06-30', '2033-12-31', '2034-06-30', '2034-12-31'].every((d) => list(thinned.r.at('checkpoints')).some((c) => c.date === d)));

  console.log(failures === 0 ? '\nACCEPTANCE PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
