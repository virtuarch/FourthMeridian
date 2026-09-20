/**
 * scripts/ai-baseline/liquid-floor.check.ts
 *
 * KEEP THIS MUCH LIQUID; INVEST A SHARE OF WHAT IS ABOVE IT — against real data.
 *
 * `lib/ai/conversation/liquid-floor-contribution.test.ts` pins the arithmetic
 * purely and runs in CI: 0% conservation, floor activation, the crossing month,
 * pause/resume under the line, target ordering, return arithmetic. This proves
 * what a fixture cannot — that the production tools, over a live Space's own cash
 * spine, still behave that way. Read-only; nothing is written.
 *
 * ⚠️ NO LIVE MONEY OR DATE IS PINNED HERE ANY MORE (M1). The first version
 * asserted the Space's figures on 2026-09-13 to the cent — the $1M crossing at
 * 1,001,443.24 on 2035-02-28, a first contribution of 4,044.40 — and by
 * 2026-09-16 thirteen of them had failed for the best possible reason: the
 * user's finances had legitimately moved (recovered closes, a month of activity).
 * A harness that fails when the data is right and the code is right teaches its
 * reader to repin it, which is the one response that detects nothing.
 *
 * Every assertion below is one of three kinds, and none of them is a personal
 * constant:
 *
 *   SEMANTIC      what the rule MEANS — conservation at 0%, the two refusals,
 *                 the solver landing on the crossing's own return.
 *   STRUCTURAL    what the payload must LOOK like — cash at the floor once
 *                 reached, one ledger behind every cadence, thinning that names
 *                 what it dropped, elapsed time that matches its dates.
 *   RELATIONAL    two live readings that must AGREE or be ORDERED — the floor's
 *                 first month is the month the current-trend search found; the
 *                 first contribution is that month's balance less the floor; a
 *                 higher floor or a lower return never crosses sooner; the table's
 *                 last row is the crossing.
 *
 * So it still fails on a broken authority, an impossible reconciliation, a wrong
 * contribution, a wrong crossing or a wrong echo — and not on a paycheck.
 * Live values are printed for the reader and asserted nowhere.
 *
 *   npm run ai:liquid-floor-check
 */
import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { findTool, monthEndsBetween, type ToolContext } from '@/lib/ai/conversation/tools';
import { elapsedBetween } from '@/lib/ai/conversation/scenario-crossing';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
const FLOOR = 50_000;
const TARGET = 1_000_000;
let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`); if (!cond) failures++; };

const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
const isMonthEnd = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).getUTCDate() === 1;
const QUARTER_END = /-(03-31|06-30|09-30|12-31)$/;

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
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const floor = (liquidFloor: number, fractionOfExcess: number) => [{ liquidFloor, fractionOfExcess }];
  const crossing = (threshold: number, annualReturnPct: number, contributions: unknown[]) =>
    run('scenario_crossing', { metric: 'netWorth', direction: 'at_or_above', threshold, annualReturnPct, contributions });
  /** A payload's `elapsed` must be the distance its own dates imply. */
  const elapsedMatches = (e: Payload, to: string) => {
    const want = elapsedBetween(ASOF, to);
    return e.at('months') === want.months && e.at('days') === want.days && e.at('label') === want.label;
  };
  console.log(`Space ${SPACE} as of ${ASOF}\n`);

  const snap = await run('get_financial_snapshot', {});
  const openingLiquid = num(snap.r.at('liquid'));

  console.log(`1. current-trend liquid reaching the floor (${FLOOR})`);
  const q1 = await run('scenario_crossing', { metric: 'liquid', direction: 'at_or_above', threshold: FLOOR });
  const reach = str(q1.r.at('crossing.date'));
  const reachValue = num(q1.r.at('crossing.value'));
  const alreadyAbove = openingLiquid >= FLOOR;
  if (alreadyAbove) console.log(`   (liquid ${openingLiquid} is already at or above the floor — the run-up relations are skipped)`);
  else {
    check('it crosses at a month-end, at or above the line, with the month before under it',
      isMonthEnd(reach) && reachValue >= FLOOR && num(q1.r.at('crossing.previousCheckpoint.value')) < FLOOR,
      `${reach} ${reachValue} / previous ${q1.r.at('crossing.previousCheckpoint.value')}`);
    check('…and carries the distance its own date implies (Slice C)', elapsedMatches(read(q1.r.at('crossing.elapsed')), reach), JSON.stringify(q1.r.at('crossing.elapsed')));
    check('…as does the month before', elapsedMatches(read(q1.r.at('crossing.previousCheckpoint.elapsed')), str(q1.r.at('crossing.previousCheckpoint.date'))));
    console.log(`   live: ${reach} at ${reachValue}`);
  }

  console.log(`\n2. floor ${FLOOR} / 100% of excess / 7% → net worth ${TARGET}`);
  const q2 = await crossing(TARGET, 7, floor(FLOOR, 1));
  const hit = str(q2.r.at('crossing.date'));
  const fr = read(q2.r.at('assumptionsInForce.contributions.floorRule'));
  check('it crosses at a month-end, at or above the line, with the month before under it',
    isMonthEnd(hit) && num(q2.r.at('crossing.value')) >= TARGET && num(q2.r.at('crossing.previousCheckpoint.value')) < TARGET,
    `${hit} ${q2.r.at('crossing.value')} / previous ${q2.r.at('crossing.previousCheckpoint.value')}`);
  const comp = read(q2.r.at('crossing.composition'));
  check('the crossing reconciles: liquid + investments + other assets − debt = net worth',
    near(num(comp.at('liquid')) + num(comp.at('investments')) + num(comp.at('otherAssets')) - num(comp.at('debt')), num(comp.at('netWorth')))
      && near(comp.at('netWorth'), q2.r.at('crossing.value')), JSON.stringify(comp.raw));
  check('…with the distance its date implies', elapsedMatches(read(q2.r.at('crossing.elapsed')), hit), JSON.stringify(q2.r.at('crossing.elapsed')));
  check('floorRule echoes the rule it ran', fr.at('liquidFloor') === FLOOR && fr.at('fractionOfExcess') === 1 && fr.at('derivedFrom') === undefined, JSON.stringify(fr.raw).slice(0, 200));
  check('…whether cash already stood above the floor is the position\'s fact, not the rule\'s', fr.at('alreadyAboveFloorAtStart') === openingLiquid > FLOOR);
  if (!alreadyAbove) {
    check('the floor is first reached in the month the current-trend search found — two tools, one spine',
      fr.at('firstMonthEndAtOrAboveFloor') === reach, `${fr.at('firstMonthEndAtOrAboveFloor')} vs ${reach}`);
    check('…after exactly the month-ends that precede it', fr.at('monthsBeforeFloorReached') === monthEndsBetween(ASOF, reach).length - 1,
      `${fr.at('monthsBeforeFloorReached')} vs ${monthEndsBetween(ASOF, reach).length - 1}`);
  }
  check('cash is held AT the floor at the crossing whenever the floor was never lost', num(fr.at('monthsBelowFloor')) > 0 || comp.at('liquid') === FLOOR,
    `liquid ${comp.at('liquid')}, monthsBelowFloor ${fr.at('monthsBelowFloor')}`);
  check('…the horizon is echoed in assumptionsInForce', typeof q2.r.at('assumptionsInForce.horizon.to') === 'string');
  console.log(`   live: ${hit} at ${q2.r.at('crossing.value')} (liquid ${comp.at('liquid')}, investments ${comp.at('investments')}); ${q2.ms} ms, ${q2.bytes} B, months examined ${q2.r.at('searchedThrough.monthsExamined')}`);

  if (!alreadyAbove) {
    const after = monthEndsBetween(reach, hit)[0] ?? hit;
    const proj = await run('scenario_projection', { to: after, granularity: 'monthly', annualReturnPct: 7, contributions: floor(FLOOR, 1) });
    const first = list(proj.r.at('movements.first')).find((m) => m.kind === 'CONTRIBUTION' && num(m.amount) > 0);
    check('the first contribution falls in that month and is that month\'s balance less the floor',
      first?.date === reach && near(first?.amount, r2(num(first?.availableBefore) - FLOOR)) && near(first?.availableBefore, reachValue), JSON.stringify(first));
    check('…leaving liquid at exactly the floor', read(list(proj.r.at('checkpoints')).find((c) => c.date === reach)).at('liquid.amount') === FLOOR);
  }

  console.log('\n3. revisions move the answer the right way');
  const q75 = await crossing(TARGET, 7, floor(FLOOR * 1.5, 1));
  check('a higher floor never crosses sooner, and holds ITS floor', str(q75.r.at('crossing.date')) >= hit
    && (num(q75.r.at('assumptionsInForce.contributions.floorRule.monthsBelowFloor')) > 0 || q75.r.at('crossing.composition.liquid') === FLOOR * 1.5),
    `${q75.r.at('crossing.date')} liquid ${q75.r.at('crossing.composition.liquid')}`);
  const q5 = await crossing(TARGET, 5, floor(FLOOR, 1));
  check('a lower return crosses later', str(q5.r.at('crossing.date')) > hit, str(q5.r.at('crossing.date')));
  const qh = await crossing(TARGET, 7, floor(FLOOR, 0.5));
  check('half of the excess never crosses sooner than all of it', str(qh.r.at('crossing.date')) >= hit, str(qh.r.at('crossing.date')));
  check('…and leaves cash ABOVE the floor, not pinned to it', num(qh.r.at('crossing.composition.liquid')) > FLOOR, String(qh.r.at('crossing.composition.liquid')));
  const q2m = await crossing(TARGET * 2, 7, floor(FLOOR, 1));
  check('twice the target is reached later', str(q2m.r.at('crossing.date')) > hit, str(q2m.r.at('crossing.date')));
  console.log(`   live: floor ×1.5 ${q75.r.at('crossing.date')} | 5% ${q5.r.at('crossing.date')} | 50% ${qh.r.at('crossing.date')} | 2× target ${q2m.r.at('crossing.date')}`);

  console.log('\n4. conservation on the real spine at 0%');
  // Thirty years of monthly detail exceeds the row ceiling, so both runs come back
  // thinned to the same coarser cadence — the comparison is still row for row.
  const thirty = `${Number(ASOF.slice(0, 4)) + 30}${ASOF.slice(4)}`;
  const base = await run('scenario_projection', { to: thirty, granularity: 'monthly' });
  const zero = await run('scenario_projection', { to: thirty, granularity: 'monthly', contributions: floor(FLOOR, 1) });
  check('both runs returned the same dates', JSON.stringify(list(base.r.at('checkpoints')).map((c) => c.date))
    === JSON.stringify(list(zero.r.at('checkpoints')).map((c) => c.date)), String(zero.r.at('horizon.granularity')));
  const zeroCps = list(zero.r.at('checkpoints')); const baseCps = list(base.r.at('checkpoints'));
  const maxDiff = Math.max(...zeroCps.map((c, i) => Math.abs(num(read(c).at('netWorth.amount')) - num(read(baseCps[i]).at('netWorth.amount')))));
  check('max net-worth difference vs baseline = 0.00 across every returned checkpoint', maxDiff === 0, `${maxDiff} over ${zeroCps.length} checkpoints`);
  console.log(`   30-year projection (${zero.r.at('horizon.granularity')}): ${zero.ms} ms, ${zero.bytes} B (baseline ${base.bytes} B)`);

  console.log('\n5. goal seek receives the rule');
  const gs = await run('scenario_goal_seek', { target: TARGET, by: hit, solveFor: 'annualReturnPct', contributions: floor(FLOOR, 1) });
  check('for the date the 7% crossing found, the required return is at most 7%', gs.r.at('feasible') === true && num(gs.r.at('required')) <= 7.01,
    `required ${gs.r.at('required')}, reached ${gs.r.at('reachedAtSolution')}`);
  const before = str(q2.r.at('crossing.previousCheckpoint.date'));
  const gsPrev = await run('scenario_goal_seek', { target: TARGET, by: before, solveFor: 'annualReturnPct', contributions: floor(FLOOR, 1) });
  check('…and for the month before — where 7% fell short — it is more than 7%', gsPrev.r.at('feasible') !== true || num(gsPrev.r.at('required')) > 7,
    `required ${gsPrev.r.at('required')} by ${before}`);
  check('the deadline carries the distance the crossing carried', read(gs.r.at('timeToTarget')).at('months') === read(q2.r.at('crossing.elapsed')).at('months')
    && read(gs.r.at('timeToTarget')).at('days') === read(q2.r.at('crossing.elapsed')).at('days'));
  check('assumptionsInForce echoes the floor rule and the horizon', gs.r.at('assumptionsInForce.contributions.floorRule.liquidFloor') === FLOOR
    && gs.r.at('assumptionsInForce.horizon.to') === hit, JSON.stringify(gs.r.at('assumptionsInForce.horizon')));
  check('…the same field the projection presents', gs.r.at('scenario.assumptions.horizon.to') === hit);

  console.log('\n6. malformed rule reaches the ledger\'s refusal, not a silent default');
  const soon = monthEndsBetween(ASOF, thirty)[15];
  const bad = await run('scenario_projection', { to: soon, contributions: [{ liquidFloor: FLOOR, fractionOfExcess: 1, surplusFraction: 0.5 }] });
  check('two bases rejected', list(bad.r.at('rejected')).length === 1 && /EXACTLY ONE/.test(String(list(bad.r.at('rejected'))[0].reason)) && list(bad.r.at('movements')).length === 0, String(list(bad.r.at('rejected'))[0]?.reason).slice(0, 80));
  const half = await run('scenario_projection', { to: soon, contributions: [{ liquidFloor: FLOOR }] });
  check('a floor without a share rejected', list(half.r.at('rejected')).length === 1 && /go together/.test(String(list(half.r.at('rejected'))[0].reason)));

  console.log('\n7. a quarterly table of the same scenario, from the same ledger (Slice B)');
  const qt = await run('scenario_projection', { to: hit, granularity: 'quarterly', annualReturnPct: 7, contributions: floor(FLOOR, 1) });
  const rows = list(qt.r.at('checkpoints'));
  const row = (d: string) => read(rows.find((c) => c.date === d));
  const monthEnds = monthEndsBetween(ASOF, hit);
  const expectedQuarterly = monthEnds.filter((d) => QUARTER_END.test(d) || d === hit);
  check('quarterly was returned as requested, nothing omitted',
    qt.r.at('horizon.granularity') === 'quarterly' && qt.r.at('horizon.cadenceSource') === 'REQUESTED' && qt.r.at('horizon.omitted') === undefined,
    JSON.stringify(qt.r.at('horizon')));
  check('one row per quarter-end, ending at the horizon', JSON.stringify(rows.map((c) => c.date)) === JSON.stringify(expectedQuarterly), `${rows.length} vs ${expectedQuarterly.length}`);
  const held = rows.filter((c) => str(c.date) >= str(fr.at('firstMonthEndAtOrAboveFloor') ?? ASOF));
  check('every row from the month the floor was reached shows liquid at the floor (when it was never lost)',
    num(fr.at('monthsBelowFloor')) > 0 || held.every((c) => read(c).at('liquid.amount') === FLOOR));
  check('every row reconciles: liquid + investments + other assets − debt = net worth', rows.every((c) => { const k = read(c);
    return near(num(k.at('liquid.amount')) + num(k.at('investments.amount')) + num(k.at('otherAssets.amount')) - num(k.at('debt.amount')), num(k.at('netWorth.amount'))); }));
  check('the last quarterly row IS the crossing the search found', near(row(hit).at('netWorth.amount'), q2.r.at('crossing.value')),
    `${row(hit).at('netWorth.amount')} vs ${q2.r.at('crossing.value')}`);
  const threeYears = monthEnds.filter((d) => d.endsWith('-12-31'))[2] ?? hit;
  const monthly = await run('scenario_projection', { to: threeYears, granularity: 'monthly', annualReturnPct: 7, contributions: floor(FLOOR, 1) });
  const mrows = list(monthly.r.at('checkpoints'));
  const shared = rows.filter((c) => str(c.date) <= threeYears);
  check('every quarterly row in the first three years equals the same date\'s row in a monthly run — one ledger, no second path',
    shared.length > 0 && shared.every((c) => { const m = mrows.find((x) => x.date === c.date);
      return !!m && read(m).at('netWorth.amount') === read(c).at('netWorth.amount') && read(m).at('liquid.amount') === read(c).at('liquid.amount'); }), `${shared.length} rows`);
  const mv = read(qt.r.at('movements'));
  check('movements are compacted: one per month-end counted, 12 shown, total conserved',
    mv.at('count') === monthEnds.length && list(mv.at('first')).length === 12 && mv.at('compacted') === true
      && mv.at('contributions.total') === row(hit).at('movements.contributionsToDate.total'), JSON.stringify([mv.at('count'), monthEnds.length, mv.at('contributions.total')]));
  console.log(`   quarterly to ${hit}: ${rows.length} rows, ${qt.ms} ms, ${qt.bytes} B`);
  const thinned = await run('scenario_projection', { to: hit, granularity: 'monthly', annualReturnPct: 7, contributions: floor(FLOOR, 1) });
  const trows = list(thinned.r.at('checkpoints'));
  if (monthEnds.length <= trows.length) console.log('   (the monthly grid fits the row ceiling at this horizon — thinning not exercised)');
  else {
    check('explicit monthly past the ceiling is thinned one step coarser and says which dates fell out',
      thinned.r.at('horizon.granularity') === 'quarterly' && thinned.r.at('horizon.requested') === 'monthly'
        && read(thinned.r.at('horizon.omitted')).at('how') === 'THINNED'
        && read(thinned.r.at('horizon.omitted')).at('count') === monthEnds.length - trows.length,
      JSON.stringify(thinned.r.at('horizon.omitted')).slice(0, 160));
    check('…and every half-year end inside the horizon is a real row, never one to be estimated',
      monthEnds.filter((d) => /-(06-30|12-31)$/.test(d)).every((d) => trows.some((c) => c.date === d)));
  }

  console.log('\n8. the floor stated as months of expenses is the SAME rule (M1)');
  const qm = await crossing(TARGET, 7, [{ liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1 }]);
  const fm = read(qm.r.at('assumptionsInForce.contributions.floorRule'));
  const monthlySpend = num(qm.r.at('assumptionsInForce.spending.monthly'));
  check('the floor is six times the spending this scenario runs at', near(fm.at('liquidFloor'), r2(6 * monthlySpend)), `${fm.at('liquidFloor')} vs 6 × ${monthlySpend}`);
  check('…and says so beside the dollars', fm.at('derivedFrom.rule') === '6 months of expenses' && near(fm.at('derivedFrom.baseline.amount'), monthlySpend));
  const ql = await crossing(TARGET, 7, floor(num(fm.at('liquidFloor')), 1));
  check('…crossing on the same date, at the same value, as that floor passed in dollars', ql.r.at('crossing.date') === qm.r.at('crossing.date') && ql.r.at('crossing.value') === qm.r.at('crossing.value'),
    `${qm.r.at('crossing.date')} ${qm.r.at('crossing.value')}`);

  console.log(failures === 0 ? '\nACCEPTANCE PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
