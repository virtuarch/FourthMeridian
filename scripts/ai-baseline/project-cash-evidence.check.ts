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
 * ⚠️ NO DATE, ROW COUNT OR DISTANCE IS WRITTEN DOWN ANY MORE. The first version
 * froze the as-of at 2026-09-13 and pinned what followed from it — "31 rows",
 * "16 rows", "67 omitted", "5 months, 15 days", "30.3 years". None of that was
 * personal money, but all of it was one day's calendar, and none of it could be
 * run on another. The as-of is today (or `CHECK_AS_OF`); horizons are placed
 * relative to it (inside the monthly band, past it, a non-quarter day ten years
 * out, a February month-end past the 80-row ceiling); and what a cadence must
 * return is computed HERE from the calendar — every month-end, the quarter-ends
 * among them, the Decembers among them, the horizon appended — and compared as
 * exact date lists, which is stronger than a count. Every row's `elapsed` is
 * checked against the distance authority AND against plain day arithmetic. The
 * "5 months, 15 days, not 1.5 years" literal lives in the pure
 * `scenario-crossing.test.ts`, where it belongs.
 *
 *   npm run ai:project-cash-check
 *   CHECK_AS_OF=2027-01-31 npm run ai:project-cash-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, monthEndsBetween, type ToolContext } from '@/lib/ai/conversation/tools';
import { elapsedBetween } from '@/lib/ai/conversation/scenario-crossing';
import type { SpaceContext } from '@/lib/space';

const SPACE = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const YEAR = Number(ASOF.slice(0, 4));
const QUARTER_END = /-(03-31|06-30|09-30|12-31)$/;
/** What each cadence must return to a horizon: the calendar's own period-ends after the as-of, then the horizon. */
const monthly = (to: string) => monthEndsBetween(ASOF, to);
const quarterly = (to: string) => monthly(to).filter((d) => QUARTER_END.test(d) || d === to);
const yearly = (to: string) => monthly(to).filter((d) => d.endsWith('-12-31') || d === to);
// ── Horizons, placed relative to the as-of ─────────────────────────────────
const THIRTY = `${YEAR + 30}-12-31`;                        // decades: yearly by default
const SHORT = monthly(shift(ASOF, 480))[14];                // ~15 months: inside the 548-day monthly band
const MID = `${YEAR + 4}-12-31`;                            // several years: quarterly by default, monthly still fits 80 rows
let TEN = shift(ASOF, 3652); if (shift(TEN, 1).endsWith('-01')) TEN = shift(TEN, -3);   // ~10 years, NOT a month-end
const TINY = shift(ASOF, 30);                               // under ~45 days: no rows by default
/** A February month-end 8–9 years out: not a quarter-end, and more than 80 month-ends away. */
const FEB = monthly(`${YEAR + 9}-12-31`).find((d) => d > `${YEAR + 8}-01-31` && /-02-(28|29)$/.test(d))!;
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
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  console.log(`Space ${SPACE} as of ${ASOF}: short ${SHORT}, mid ${MID}, ten ${TEN}, feb ${FEB}, thirty ${THIRTY}\n`);
  check('the horizons sit where the cadence bands need them',
    daysBetween(ASOF, SHORT) <= 548 && daysBetween(ASOF, SHORT) > 365 && daysBetween(ASOF, MID) > 548 && monthly(MID).length <= 80
      && !QUARTER_END.test(TEN) && !QUARTER_END.test(FEB) && monthly(FEB).length > 80 && quarterly(FEB).length <= 80 && daysBetween(ASOF, TINY) < 45);
  const wellFormed = (p: Payload, name: string, to: string) => {
    const ds = dates(p);
    check(`${name}: ascending, unique, horizon last, every row carries elapsed`,
      ds.every((d, i) => i === 0 || d > ds[i - 1]) && ds[ds.length - 1] === to
        && p.rows.every((r) => typeof r.elapsed?.months === 'number' && typeof r.elapsed?.label === 'string'),
      `${ds.length} rows, ${p.at('horizon.granularity')} (${p.at('horizon.cadenceSource')}), ${p.bytes} B, ${p.ms} ms`);
  };

  console.log('1. the thirty-year residual');
  const thirty = await cash({ to: THIRTY });
  wellFormed(thirty, 'default over 30 years', THIRTY);
  check(`…is yearly by default: the ${yearly(THIRTY).length} Decembers, not ${monthly(THIRTY).length} month-ends`,
    same(dates(thirty), yearly(THIRTY)) && thirty.at('horizon.granularity') === 'yearly'
    && thirty.at('horizon.cadenceSource') === 'DEFAULT' && thirty.at('horizon.omitted') === undefined, `${thirty.rows.length} rows`);
  check('…and under a tenth of the old payload', thirty.bytes < 112_136 / 10, `${thirty.bytes} B vs 112,136 B before`);
  const ex = thirty.at('projection.basis.excluded') as { count: number; groups: unknown[]; compacted: boolean };
  // ⚠️ THE COUNT IS THE SPACE'S, NOT THE CONTRACT'S. How many unlicensed streams a
  // Space has, and how far they run, moves with its data (727 occurrences in 2
  // groups on 2026-09-14; 364 in 1 the next day, after a stream lapsed). What the
  // contract promises is the SHAPE: many occurrences, a handful of groups.
  if (!ex || ex.count === 0) console.log('   branch: this Space has NO unlicensed recurring stream today — there is nothing to group, and nothing is asserted about grouping');
  else check('…the unlicensed events are grouped by stream, not listed per occurrence',
    ex.groups.length >= 1 && ex.groups.length * 10 <= ex.count && ex.compacted === true,
    `${ex.count} occurrences in ${ex.groups.length} groups`);
  const thirtyMonthly = await cash({ to: THIRTY, checkpoints: 'monthly' });
  check('explicit monthly over 30 years is thinned to yearly and says which dates fell out',
    thirtyMonthly.at('horizon.granularity') === 'yearly' && thirtyMonthly.at('horizon.requested') === 'monthly'
      && at(thirtyMonthly.at('horizon.omitted'), 'how') === 'THINNED'
      && at(thirtyMonthly.at('horizon.omitted'), 'count') === monthly(THIRTY).length - yearly(THIRTY).length,
    JSON.stringify(thirtyMonthly.at('horizon.omitted')).slice(0, 120));
  check('…every returned row equals the default run\'s row at the same date',
    JSON.stringify(thirtyMonthly.rows.map((r) => [r.date, r.closingCash])) === JSON.stringify(thirty.rows.map((r) => [r.date, r.closingCash])));

  console.log('2. cadence by horizon');
  const short = await cash({ to: SHORT });
  wellFormed(short, 'within 18 months', SHORT);
  check('…monthly: every month-end to the horizon', same(dates(short), monthly(SHORT)) && short.at('horizon.granularity') === 'monthly', `${short.rows.length} rows`);
  const mid = await cash({ to: MID });
  wellFormed(mid, 'several years', MID);
  check(`…quarterly: every quarter-end (${quarterly(MID).length} rows, where monthly would be ${monthly(MID).length})`,
    same(dates(mid), quarterly(MID)) && mid.at('horizon.granularity') === 'quarterly', `${mid.rows.length} rows`);
  const ten = await cash({ to: TEN });
  wellFormed(ten, 'about ten years, non-quarter horizon', TEN);
  check('…quarterly with the exact horizon appended after the last quarter-end before it',
    ten.at('horizon.granularity') === 'quarterly' && same(dates(ten), quarterly(TEN)) && QUARTER_END.test(ten.rows[ten.rows.length - 2].date));
  const tiny = await cash({ to: TINY });
  check('under ~45 days: no checkpoints by default, horizon still carries elapsed',
    tiny.rows.length === 0 && at(tiny.at('horizon.elapsed'), 'label') === elapsedBetween(ASOF, TINY).label && tiny.at('horizon.checkpoints') === 0);
  const none = await cash({ to: MID, checkpoints: 'none' });
  check('`none` still means none', none.rows.length === 0);

  console.log('3. explicit cadences');
  const q = await cash({ to: FEB, checkpoints: 'quarterly' });
  wellFormed(q, 'explicit quarterly to a non-quarter horizon', FEB);
  check('…every quarter-end as requested, nothing omitted', same(dates(q), quarterly(FEB)) && q.at('horizon.cadenceSource') === 'REQUESTED' && q.at('horizon.omitted') === undefined, `${q.rows.length} rows`);
  const y = await cash({ to: MID, checkpoints: 'yearly' });
  check('explicit yearly: Decembers only', same(dates(y), yearly(MID)) && dates(y).every((d) => d.endsWith('-12-31')), dates(y).join(','));
  const m = await cash({ to: MID, checkpoints: 'monthly' });
  check('explicit monthly under the ceiling: every month-end, none omitted', same(dates(m), monthly(MID)) && m.at('horizon.omitted') === undefined, `${m.rows.length} rows`);
  const over = await cash({ to: FEB, checkpoints: 'monthly' });
  check('explicit monthly over the ceiling: quarterly returned, the month-ends that fell out counted, horizon kept',
    over.at('horizon.granularity') === 'quarterly' && same(dates(over), quarterly(FEB))
      && at(over.at('horizon.omitted'), 'count') === monthly(FEB).length - quarterly(FEB).length && dates(over).slice(-1)[0] === FEB,
    `${at(over.at('horizon.omitted'), 'count')} omitted of ${monthly(FEB).length}`);

  console.log('4. the plan never touches the spine');
  const byDate = new Map(m.rows.map((r) => [r.date, r.closingCash]));
  check('every default quarterly row equals the explicit monthly run at the same date',
    mid.rows.every((r) => byDate.get(r.date) === r.closingCash));
  check('…and the yearly rows too', y.rows.every((r) => byDate.get(r.date) === r.closingCash));
  check('the horizon figure is the same on every cadence',
    new Set([mid, y, m, none].map((p) => p.at('projection.endingCash'))).size === 1, String(mid.at('projection.endingCash')));
  const scen = await findTool('scenario_projection')!.run({ to: MID, granularity: 'quarterly' }, toolCtx);
  const scenLiquid = new Map(((at(scen, 'checkpoints') as { date: string; liquid: { amount: number } }[]) ?? []).map((c) => [c.date, c.liquid.amount]));
  check('…and equals the liquid line scenario_projection composes at the same dates (one spine)',
    mid.rows.every((r) => scenLiquid.get(r.date) === r.closingCash));
  check('changeSincePrevious sums to the horizon movement',
    Math.abs(mid.rows.reduce((s, r) => s + (r.changeSincePrevious ?? 0), 0)
      - ((mid.at('projection.endingCash') as number) - (mid.at('openingCash') as number))) < 0.02);

  console.log('5. elapsed');
  const distanceOk = (e: Row['elapsed'] | undefined, to: string) => { const want = elapsedBetween(ASOF, to);
    return !!e && e.months === want.months && e.days === want.days && e.monthsFractional === want.monthsFractional
      && e.years === want.years && e.label === want.label
      // …and, independently of that authority: years is the day count over 365.25, to two places.
      && e.years === Math.round((daysBetween(ASOF, to) / 365.25) * 100) / 100; };
  check('every row of every run carries the distance from the as-of to ITS date — never to the horizon, never to today',
    [thirty, short, mid, ten, q, y, m, over].every((p) => p.rows.length > 0 && p.rows.every((r) => distanceOk(r.elapsed, r.date))));
  check('…and rows farther away are farther away', m.rows.every((r, i) => i === 0 || r.elapsed.years >= m.rows[i - 1].elapsed.years));
  const sixth = m.rows[5];
  console.log(`   live: ${sixth.date} is ${sixth.elapsed.label} away (${sixth.elapsed.monthsFractional} months, ${sixth.elapsed.years} years)`);
  check('the horizon carries its own distance', distanceOk(thirty.at('horizon.elapsed') as Row['elapsed'], THIRTY)
    && distanceOk(short.at('horizon.elapsed') as Row['elapsed'], SHORT) && distanceOk(tiny.at('horizon.elapsed') as Row['elapsed'], TINY),
    JSON.stringify(short.at('horizon.elapsed')));

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
