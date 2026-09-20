/**
 * scripts/ai-baseline/project-cash-evidence.check.ts
 *
 * PROJECT_CASH ON THE BOUNDED EVIDENCE CONTRACT — against real data.
 *
 * A thirty-year `project_cash` was returning 364 month-end rows (~112 KB) that
 * the model then carried in every later prompt, and no row said how far away
 * it was — the one path on which "1 year and 5½ months" for a five-and-a-half-
 * month gap still reproduced after f070f6d. The tool now plans its rows with
 * the same authority `scenario_projection` uses (`scenario-checkpoints.ts`) and
 * every row carries `elapsed`.
 *
 * ⚠️ THE PLAN CHOOSES DATES; IT NEVER TOUCHES THE SPINE. The proof here is
 * equality: every retained row equals the same date's row from an explicit
 * monthly run, and equals the liquid line `scenario_projection` composes at
 * that date. Read-only; nothing is written.
 *
 *   npm run ai:project-cash-check
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

type Row = { date: string; closingCash: number | null; changeSincePrevious: number | null;
  elapsed: { months: number; days: number; monthsFractional: number; years: number; label: string } };
type Payload = { at: (path: string) => unknown; rows: Row[]; bytes: number; ms: number };

async function main() {
  const space = await db.space.findUniqueOrThrow({ where: { id: SPACE } });
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId: SPACE, role: 'OWNER', status: 'ACTIVE' } });
  const spaceCtx = { userId: owner.userId, spaceId: SPACE, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency } } as unknown as SpaceContext;
  const toolCtx: ToolContext = { spaceCtx, spaceId: SPACE, asOfISO: ASOF };
  const at = (raw: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) =>
    (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), raw);
  const cash = async (args: Record<string, unknown>): Promise<Payload> => {
    const t0 = Date.now(); const raw = await findTool('project_cash')!.run(args, toolCtx);
    const rows = (at(raw, 'projection.checkpoints') as Row[] | undefined) ?? [];
    return { at: (p) => at(raw, p), rows, bytes: JSON.stringify(raw).length, ms: Date.now() - t0 };
  };
  const dates = (p: Payload) => p.rows.map((r) => r.date);
  const wellFormed = (p: Payload, name: string, to: string) => {
    const ds = dates(p);
    check(`${name}: ascending, unique, horizon last, every row carries elapsed`,
      ds.every((d, i) => i === 0 || d > ds[i - 1]) && ds[ds.length - 1] === to
        && p.rows.every((r) => typeof r.elapsed?.months === 'number' && typeof r.elapsed?.label === 'string'),
      `${ds.length} rows, ${p.at('horizon.granularity')} (${p.at('horizon.cadenceSource')}), ${p.bytes} B, ${p.ms} ms`);
  };

  console.log('1. the thirty-year residual');
  const thirty = await cash({ to: '2056-12-31' });
  wellFormed(thirty, 'default over 30 years', '2056-12-31');
  check('…is yearly by default: 31 rows, not 364', thirty.rows.length === 31 && thirty.at('horizon.granularity') === 'yearly'
    && thirty.at('horizon.cadenceSource') === 'DEFAULT' && thirty.at('horizon.omitted') === undefined);
  check('…and under a tenth of the old payload', thirty.bytes < 112_136 / 10, `${thirty.bytes} B vs 112,136 B before`);
  const ex = thirty.at('projection.basis.excluded') as { count: number; groups: unknown[]; compacted: boolean };
  // ⚠️ THE COUNT IS THE SPACE'S, NOT THE CONTRACT'S. How many unlicensed streams a
  // Space has, and how far they run, moves with its data (727 occurrences in 2
  // groups on 2026-09-14; 364 in 1 the next day, after a stream lapsed). What the
  // contract promises is the SHAPE: many occurrences, a handful of groups.
  check('…the unlicensed events are grouped by stream, not listed per occurrence',
    ex.count >= 100 && ex.groups.length <= 5 && ex.groups.length < ex.count && ex.compacted === true, `${ex.count} occurrences in ${ex.groups.length} groups`);
  const thirtyMonthly = await cash({ to: '2056-12-31', checkpoints: 'monthly' });
  check('explicit monthly over 30 years is thinned to yearly and says which dates fell out',
    thirtyMonthly.at('horizon.granularity') === 'yearly' && thirtyMonthly.at('horizon.requested') === 'monthly'
      && at(thirtyMonthly.at('horizon.omitted'), 'how') === 'THINNED' && at(thirtyMonthly.at('horizon.omitted'), 'count') === 364 - 31,
    JSON.stringify(thirtyMonthly.at('horizon.omitted')).slice(0, 120));
  check('…every returned row equals the default run\'s row at the same date',
    JSON.stringify(thirtyMonthly.rows.map((r) => [r.date, r.closingCash])) === JSON.stringify(thirty.rows.map((r) => [r.date, r.closingCash])));

  console.log('2. cadence by horizon');
  const short = await cash({ to: '2027-12-31' });
  wellFormed(short, 'within 18 months', '2027-12-31');
  check('…monthly, 16 rows', short.rows.length === 16 && short.at('horizon.granularity') === 'monthly');
  const mid = await cash({ to: '2030-12-31' });
  wellFormed(mid, 'several years', '2030-12-31');
  check('…quarterly, 18 rows (was 52 monthly)', mid.rows.length === 18 && mid.at('horizon.granularity') === 'quarterly');
  const ten = await cash({ to: '2036-09-13' });
  wellFormed(ten, 'about ten years, non-quarter horizon', '2036-09-13');
  check('…quarterly with the exact horizon appended', ten.at('horizon.granularity') === 'quarterly' && ten.rows[ten.rows.length - 2].date === '2036-06-30');
  const tiny = await cash({ to: '2026-10-13' });
  check('under ~45 days: no checkpoints by default, horizon still carries elapsed',
    tiny.rows.length === 0 && at(tiny.at('horizon.elapsed'), 'months') === 1 && tiny.at('horizon.checkpoints') === 0);
  const none = await cash({ to: '2030-12-31', checkpoints: 'none' });
  check('`none` still means none', none.rows.length === 0);

  console.log('3. explicit cadences');
  const q = await cash({ to: '2035-02-28', checkpoints: 'quarterly' });
  wellFormed(q, 'explicit quarterly to a non-quarter horizon', '2035-02-28');
  check('…35 rows as requested, nothing omitted', q.rows.length === 35 && q.at('horizon.cadenceSource') === 'REQUESTED' && q.at('horizon.omitted') === undefined);
  const y = await cash({ to: '2030-12-31', checkpoints: 'yearly' });
  check('explicit yearly: Decembers only', dates(y).join(',') === '2026-12-31,2027-12-31,2028-12-31,2029-12-31,2030-12-31');
  const m = await cash({ to: '2030-12-31', checkpoints: 'monthly' });
  check('explicit monthly under the ceiling: 52 rows, none omitted', m.rows.length === 52 && m.at('horizon.omitted') === undefined);
  const over = await cash({ to: '2035-02-28', checkpoints: 'monthly' });
  check('explicit monthly over the ceiling: quarterly returned, 67 omitted named, horizon kept',
    over.at('horizon.granularity') === 'quarterly' && at(over.at('horizon.omitted'), 'count') === 67 && dates(over).slice(-1)[0] === '2035-02-28');

  console.log('4. the plan never touches the spine');
  const byDate = new Map(m.rows.map((r) => [r.date, r.closingCash]));
  check('every default quarterly row equals the explicit monthly run at the same date',
    mid.rows.every((r) => byDate.get(r.date) === r.closingCash));
  check('…and the yearly rows too', y.rows.every((r) => byDate.get(r.date) === r.closingCash));
  check('the horizon figure is the same on every cadence',
    new Set([mid, y, m, none].map((p) => p.at('projection.endingCash'))).size === 1, String(mid.at('projection.endingCash')));
  const scen = await findTool('scenario_projection')!.run({ to: '2030-12-31', granularity: 'quarterly' }, toolCtx);
  const scenLiquid = new Map(((at(scen, 'checkpoints') as { date: string; liquid: { amount: number } }[]) ?? []).map((c) => [c.date, c.liquid.amount]));
  check('…and equals the liquid line scenario_projection composes at the same dates (one spine)',
    mid.rows.every((r) => scenLiquid.get(r.date) === r.closingCash));
  check('changeSincePrevious sums to the horizon movement',
    Math.abs(mid.rows.reduce((s, r) => s + (r.changeSincePrevious ?? 0), 0)
      - ((mid.at('projection.endingCash') as number) - (mid.at('openingCash') as number))) < 0.02);

  console.log('5. elapsed');
  const feb = m.rows.find((r) => r.date === '2027-02-28')!;
  check('2027-02-28 is 5 months, 15 days from asOf — about 5.5 months, about 0.46 years',
    feb.elapsed.months === 5 && feb.elapsed.days === 15 && feb.elapsed.monthsFractional === 5.5 && feb.elapsed.years === 0.46
      && feb.elapsed.label === '5 months, 15 days', JSON.stringify(feb.elapsed));
  check('the horizon carries its own distance', at(thirty.at('horizon.elapsed'), 'years') === 30.3
    && at(short.at('horizon.elapsed'), 'label') === '15 months, 18 days', JSON.stringify(short.at('horizon.elapsed')));

  // ⚠️ RELATIONAL, NOT PINNED. No figure below is this Space's money: every
  // assertion is that an interval AGREES WITH the cumulative runs either side of
  // it, which holds for any Space on any day.
  console.log('6. an interval of the projection');
  type Comp = { label: string; value: number };
  const comp = (p: Payload, path: string, re: RegExp) =>
    ((p.at(path) as Comp[] | undefined) ?? []).find((c) => re.test(c.label))?.value ?? 0;
  const year = (Number(ASOF.slice(0, 4)) + 1).toString();
  const [wFrom, wTo, wBefore] = [`${year}-01-01`, `${year}-12-31`, `${Number(year) - 1}-12-31`];
  const win = await cash({ from: wFrom, to: wTo });
  const toEnd = await cash({ to: wTo });
  const toStart = await cash({ to: wBefore });
  const cent = (a: number, b: number) => Math.abs(a - b) <= 0.011;
  check(`next calendar year states its window: ${wFrom}..${wTo}, inclusive days`,
    win.at('interval.from') === wFrom && win.at('interval.to') === wTo
      && win.at('interval.days') === (Number(year) % 4 === 0 ? 366 : 365) && win.at('interval.clamped') === undefined);
  for (const [name, re] of [['income', /income/], ['obligations', /obligations/], ['spending', /spending/]] as [string, RegExp][]) {
    const want = comp(toEnd, 'projection.basis.components', re) - comp(toStart, 'projection.basis.components', re);
    check(`interval ${name} = cumulative(${wTo}) − cumulative(${wBefore}), to the cent`,
      cent(comp(win, 'interval.components', re), want), `${comp(win, 'interval.components', re)} vs ${want.toFixed(2)}`);
  }
  check('its two balances ARE the standalone runs\' ending cash, and cashChange is their difference',
    at(win.at('interval.cashAtEnd'), 'amount') === toEnd.at('projection.endingCash')
      && at(win.at('interval.cashAtStart'), 'amount') === toStart.at('projection.endingCash')
      && at(win.at('interval.cashAtStart'), 'date') === wBefore
      && cent(win.at('interval.cashChange') as number,
        (toEnd.at('projection.endingCash') as number) - (toStart.at('projection.endingCash') as number)));
  check('the parts explain the change, to the cent of rounding',
    Math.abs(comp(win, 'interval.components', /income/) - comp(win, 'interval.components', /obligations/)
      - comp(win, 'interval.components', /spending/) - (win.at('interval.cashChange') as number)) <= 0.021);
  // ⚠️ WHAT THE SILENT CHECKPOINT COPIES IS UNCHANGED BY A WINDOW. `checkpointProjection`
  // reads `horizon.to` and `projection.endingCash` and nothing else; both must be the
  // cumulative answer whether or not `from` was passed, so a CHANGE is never stored as a BALANCE.
  check('a window leaves the two fields the checkpoint copies exactly as they were',
    win.at('projection.endingCash') === toEnd.at('projection.endingCash') && win.at('horizon.to') === toEnd.at('horizon.to')
      && win.at('horizon.asOf') === toEnd.at('horizon.asOf') && win.at('openingCash') === toEnd.at('openingCash'));
  const assumed = await cash({ from: wFrom, to: wTo, assumedMonthlySpending: 5000 });
  const assumedEnd = await cash({ to: wTo, assumedMonthlySpending: 5000 });
  const assumedStart = await cash({ to: wBefore, assumedMonthlySpending: 5000 });
  check('a stated spending level reaches the interval, and is again the difference of the two runs made under it',
    comp(assumed, 'interval.components', /assumed rate/) > 0 && comp(assumed, 'interval.components', /observed rate/) === 0
      && cent(comp(assumed, 'interval.components', /assumed rate/),
        comp(assumedEnd, 'projection.basis.components', /assumed rate/) - comp(assumedStart, 'projection.basis.components', /assumed rate/)),
    String(comp(assumed, 'interval.components', /assumed rate/)));
  const past = await cash({ from: `${Number(year) - 2}-01-01`, to: `${Number(year) - 2}-06-30` });
  check('an interval entirely in the past is refused and points at the measured tools',
    typeof past.at('interval.unavailable') === 'string' && past.at('interval.cashChange') === undefined
      && /measure_flows/.test(String(past.at('interval.instead'))), String(past.at('interval.unavailable')).slice(0, 90));
  const straddle = await cash({ from: `${Number(year) - 1}-01-01`, to: wBefore });
  check('one that starts in the past is clamped to today, says why, and equals the ordinary projection',
    straddle.at('interval.from') === ASOF && typeof straddle.at('interval.clamped') === 'string'
      && at(straddle.at('interval.requested'), 'from') === `${Number(year) - 1}-01-01`
      && cent(comp(straddle, 'interval.components', /spending/), comp(toStart, 'projection.basis.components', /spending/))
      && at(straddle.at('interval.cashAtEnd'), 'amount') === toStart.at('projection.endingCash'));
  check('no `from`, no interval block', toEnd.at('interval') === undefined);

  console.log(failures === 0 ? '\nPROJECT_CASH EVIDENCE CHECK PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
