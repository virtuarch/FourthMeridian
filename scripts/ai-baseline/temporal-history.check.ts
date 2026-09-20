/**
 * scripts/ai-baseline/temporal-history.check.ts
 *
 * THE EXACT DATES, AGAINST THE RECORD THAT GOT THEM WRONG.
 *
 * In the browser dogfood the assistant answered 2026-04-24 to "when did I first
 * hit 0 with my debt this year?" — a day whose debt, in the payload it was
 * reading, was $5,353.81. The first observed zero was 2026-07-22. Both facts were
 * in the same series; and in a LONGER read they were not — a 786-day range
 * capped to 194 points does not contain 2026-07-22 at all. This proves the
 * deterministic tool returns the right day, that it finds it in the FULL record
 * even when the display series has dropped it, that a retrospective read cannot
 * see it early, and that the CLI and the production route get the identical fact
 * because they run the identical code.
 *
 * ⚠️ NO LIVE MONEY OR DATE IS PINNED HERE ANY MORE. The first version asserted
 * this Space's own history — 2026-07-22, $89.46 the day before, a highest debt of
 * $37,437.04, and `17.12000000000003`, a float pinned to fourteen places. History
 * was then legitimately regenerated (recovered closes), the high became
 * $37,449.11, and the harness reported two regressions that were not. The dates
 * that had not drifted yet were the same kind of assertion waiting their turn.
 *
 * ⚠️ AN ANSWER IS NOW CHECKED AGAINST THE RECORD, NOT AGAINST A MEMORY OF IT.
 * Every exact answer is verified by an ORACLE written here, deliberately naive
 * and deliberately independent of `findObservation`, over the canonical daily
 * series read in the same run (`get_net_worth_history`, daily, un-sampled — the
 * same snapshot authority and projection the tool itself reads). That is
 * strictly stronger than a pin: a pin says "the answer is what it was the day I
 * looked", the oracle says "the answer is RIGHT" — it exists in the series,
 * carries the series' own value, satisfies the predicate, and nothing before it
 * (after it, for `last_*`) does. Same taxonomy as `liquid-floor.check.ts`:
 *
 *   SEMANTIC      `below`/`above` INCLUDE the threshold, to within half a cent
 *                 and not a cent more; a tie goes to the earlier day; "nothing
 *                 met it" and "nothing to search" are different answers; the
 *                 information ceiling bounds the search itself.
 *   STRUCTURAL    the previous observation is the immediately preceding one;
 *                 coverage counts what was searched; a sampled series says it
 *                 is a sample; both legs of a payment survive, each naming the
 *                 other; partial months are flagged and left out of the mean.
 *   RELATIONAL    tool answer = oracle answer over the full series;
 *                 `first_below(minimum)` lands on `minimum`'s own day; one month
 *                 read alone equals its row in a six-month read; two tools name
 *                 the same largest expense; route and CLI reach the same fact.
 *
 * Thresholds are taken FROM the series (its median, its extremes) so every
 * branch of the predicate family is exercised whatever the balances are. Where a
 * relation needs a fact the record may not hold (debt that has never been zero,
 * no linked card payment) the script says which branch ran — it never passes
 * silently on an empty premise. Live values are printed and asserted nowhere.
 *
 * Section 6 samples a MODEL (two turns). Everything else is deterministic.
 *
 *   npm run ai:temporal-check
 *   CHECK_AS_OF=2026-08-10 npm run ai:temporal-check     # a retrospective run
 *   CHECK_SKIP_MODEL=1 npm run ai:temporal-check         # deterministic sections only
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, openAiToolSchemas, type ToolContext } from '@/lib/ai/conversation/tools';
import { openTranscript, runStatelessTurn } from '@/lib/ai/conversation/engine';
import { executeTurn } from '@/lib/ai/conversation/turn';
import { newScenarioSlot } from '@/lib/ai/conversation/active-scenario';
import { todayUTCISO } from '@/lib/time/clock';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

type Obs = { date: string; value: number };
type Found = {
  result: (Obs & { previousObservation?: Obs }) | null;
  unmatched?: string; unavailable?: string; error?: string;
  coverage?: { observationsInRange: number; observationsSearched: number; observationsUnassertable: number;
    firstObservation: string | null; lastObservation: string | null;
    historyAvailableFrom: string | null; historyAvailableTo: string | null };
};
type Metric = 'debt' | 'liquid';
type Operation = 'minimum' | 'maximum' | 'first_below' | 'first_above' | 'last_below' | 'last_above';
type Ask = { metric: Metric; operation: Operation; threshold?: number; from?: string; to?: string };
type History = {
  coverage: { pointsReturned: number; observationsInRange: number; seriesIsSample?: boolean };
  series: ({ date: string } & Record<Metric, number | null>)[];
};

const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ⚠️ THE ORACLE. THE DOCUMENTED CONTRACT, RESTATED NAIVELY — NOT IMPORTED.
 * "first_below … INCLUDE[s] the threshold itself" (the tool description) and
 * "at or below zero must include a debt of 2.8e-14; it must not include a debt
 * of one cent" (`snapshot-window.ts`). Half a cent is written out here rather
 * than imported so that moving the production constant FAILS this check instead
 * of moving the oracle with it.
 */
const HALF_CENT = 0.005;
const meets = (operation: Operation, threshold: number) => (v: number) =>
  operation.endsWith('below') ? v < threshold + HALF_CENT : v > threshold - HALF_CENT;
const sameMoney = (a: number, b: number) => Math.abs(a - b) < HALF_CENT;

function oracle(series: readonly Obs[], a: Ask): { at: number } | null {
  if (series.length === 0) return null;
  if (a.operation === 'minimum' || a.operation === 'maximum') {
    // The extreme, and of the days that hold that amount of MONEY, the earliest:
    // 3968.05 and 3968.0500000000015 are one balance, and the first day has it.
    const values = series.map((p) => p.value);
    const extreme = a.operation === 'minimum' ? Math.min(...values) : Math.max(...values);
    return { at: series.findIndex((p) => sameMoney(p.value, extreme)) };
  }
  const ok = meets(a.operation, a.threshold as number);
  const idx = series.map((p, i) => (ok(p.value) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return null;
  return { at: a.operation.startsWith('first_') ? idx[0] : idx[idx.length - 1] };
}

async function main() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const agent = await db.aiAgent.findUnique({ where: { spaceId }, select: { id: true } });
  const spaceCtx = { userId: owner.userId, spaceId, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
  } as unknown as SpaceContext;

  const asOfISO = process.env.CHECK_AS_OF ?? todayUTCISO();
  const tool = findTool('find_in_balance_history')!;
  const ctx: ToolContext = { spaceCtx, spaceId, asOfISO };
  const ask = (args: Ask | Record<string, unknown>, over: Partial<ToolContext> = {}) =>
    tool.run(args as Record<string, unknown>, { ...ctx, ...over }) as Promise<Found>;
  const history = (args: Record<string, unknown>) =>
    findTool('get_net_worth_history')!.run(args, ctx) as Promise<History>;

  // ── The canonical record, read ONCE, un-sampled ───────────────────────────
  const record = await history({ from: '0001-01-01', to: asOfISO, granularity: 'daily' });
  const whole = (metric: Metric): Obs[] => record.series
    .filter((p) => typeof p[metric] === 'number').map((p) => ({ date: p.date, value: p[metric] as number }));
  const within = (s: readonly Obs[], from?: string, to?: string) =>
    s.filter((p) => (!from || p.date >= from) && (!to || p.date <= to));
  console.log(`Space ${spaceId} as of ${asOfISO}`);
  check('the canonical daily series came back whole — every observation, not a sample',
    record.coverage.seriesIsSample === undefined && record.coverage.pointsReturned === record.coverage.observationsInRange
      && record.series.length === record.coverage.observationsInRange && record.series.length >= 60,
    `${record.series.length} observations ${record.series[0]?.date} → ${record.series[record.series.length - 1]?.date}`);
  check('…ordered oldest-first with one observation per day', record.series.every((p, i, s) => i === 0 || s[i - 1].date < p.date));

  /**
   * Ask the tool, ask the oracle, and demand they agree — then demand the answer
   * be RIGHT by the record, property by property. `ceiling` truncates the oracle's
   * series by this script's own filter, never by the clamp it is checking.
   */
  async function verify(label: string, a: Ask, opts: { ceiling?: string } = {}) {
    const to = [a.to, opts.ceiling, asOfISO].filter((d): d is string => !!d).sort()[0];
    const series = within(whole(a.metric), a.from, to);
    const want = oracle(series, a);
    const got = await ask(a, opts.ceiling ? { asOfISO: opts.ceiling } : {});
    const ok = a.threshold === undefined ? null : meets(a.operation, a.threshold);
    console.log(`  · ${label}`);
    check('    every observation in range was searched, and only those',
      got.coverage?.observationsSearched === series.length
        && (series.length === 0 || (got.coverage?.firstObservation === series[0].date
          && got.coverage?.lastObservation === series[series.length - 1].date)),
      `${got.coverage?.observationsSearched} vs ${series.length}`);
    if (!want) {
      check('    the record holds no such day, and the tool says exactly that — no date, no guess',
        got.result === null && (series.length === 0
          ? got.unavailable === 'NO_OBSERVATIONS_IN_RANGE' : got.unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION'),
        JSON.stringify({ result: got.result, unmatched: got.unmatched, unavailable: got.unavailable }));
      return { got, series, at: -1, args: a };
    }
    const at = series.findIndex((p) => p.date === got.result?.date);
    check('    the day returned EXISTS in the full series, with the series\' own value',
      at >= 0 && series[at].value === got.result?.value, `${got.result?.date} ${got.result?.value}`);
    check('    …and is the day the oracle finds by reading every observation',
      at === want.at, `${got.result?.date} vs ${series[want.at].date}`);
    if (ok) {
      const before = series.slice(0, Math.max(at, 0)), after = series.slice(at + 1);
      check('    …it satisfies the predicate (the threshold itself included)', at >= 0 && ok(series[at].value));
      if (a.operation.startsWith('first_')) {
        check('    …NO earlier observation does', !before.some((p) => ok(p.value)));
        check('    …in particular the observation before it does not — that is what it crossed from',
          at <= 0 || !ok(series[at - 1].value), at > 0 ? `${series[at - 1].date} ${series[at - 1].value}` : 'first in range');
      } else {
        check('    …NO later observation does', !after.some((p) => ok(p.value)));
        check('    …in particular the observation after it does not', at < 0 || at === series.length - 1 || !ok(series[at + 1].value));
      }
    } else {
      const v = got.result?.value ?? Number.NaN;
      check(`    …no observation is ${a.operation === 'maximum' ? 'higher' : 'lower'} by half a cent or more`,
        series.every((p) => (a.operation === 'maximum' ? p.value < v + HALF_CENT : p.value > v - HALF_CENT)));
      check('    …and no EARLIER day holds the same money — a tie goes to the first',
        !series.slice(0, Math.max(at, 0)).some((p) => sameMoney(p.value, v)));
    }
    check('    the previous observation named is the immediately preceding one, value and all',
      at <= 0 ? got.result?.previousObservation === undefined
        : got.result?.previousObservation?.date === series[at - 1].date
          && got.result?.previousObservation?.value === series[at - 1].value,
      JSON.stringify(got.result?.previousObservation ?? null));
    return { got, series, at, args: a };
  }

  // The question's own frame (the calendar year) and a frame that is never thin.
  const YEAR = { from: `${asOfISO.slice(0, 4)}-01-01`, to: asOfISO };
  const TRAILING = { from: shift(asOfISO, -364), to: asOfISO };
  const median = (s: readonly Obs[]) => { const v = s.map((p) => p.value).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };

  console.log('\n1. THE QUESTION THAT WAS ANSWERED WRONG');
  const zero = await verify('when did debt first hit zero this year?', { metric: 'debt', operation: 'first_below', threshold: 0, ...YEAR });
  if (zero.got.result) {
    check('the value returned with it IS zero — to the half-cent, whatever the float says',
      Math.abs(zero.got.result.value) < HALF_CENT, String(zero.got.result.value));
    console.log(`   live: ${zero.got.result.date}, from ${zero.got.result.previousObservation?.value} on ${zero.got.result.previousObservation?.date}`);
  } else console.log('   (debt was never observed at zero in this calendar year — the no-match branch ran and was verified)');

  console.log('\n2. THE REST OF THE FAMILY — thresholds taken from the series itself');
  type Verified = Awaited<ReturnType<typeof verify>>;
  const answered: Verified[] = [];
  const keep = (v: Verified) => { if (v.got.result) answered.push(v); return v; };
  for (const metric of ['debt', 'liquid'] as const) {
    const s = within(whole(metric), TRAILING.from, TRAILING.to);
    const mid = median(s);
    const spread = s.some((p) => !sameMoney(p.value, mid));
    check(`${metric}: the trailing year has a spread to cross (${s.length} observations, median ${mid})`, s.length >= 60 && spread);
    for (const operation of ['first_below', 'last_below', 'first_above', 'last_above'] as const) {
      keep(await verify(`${metric} ${operation} its median ${mid}`, { metric, operation, threshold: mid, ...TRAILING }));
    }
    const lo = keep(await verify(`${metric} minimum`, { metric, operation: 'minimum', ...TRAILING }));
    const hi = keep(await verify(`${metric} maximum`, { metric, operation: 'maximum', ...TRAILING }));
    const min = lo.got.result!, max = hi.got.result!;
    // ⚠️ INCLUSIVE AT THE THRESHOLD, AND NOT A CENT WIDER — asked of the extremes,
    // where "includes the threshold" and "excludes it" give different answers.
    check(`${metric}: first_below(the minimum) is the minimum's own day — the threshold itself counts`,
      (await ask({ metric, operation: 'first_below', threshold: min.value, ...TRAILING })).result?.date === min.date);
    check(`${metric}: first_above(the maximum) is the maximum's own day`,
      (await ask({ metric, operation: 'first_above', threshold: max.value, ...TRAILING })).result?.date === max.date);
    check(`${metric}: one cent under the minimum, nothing qualifies`,
      (await ask({ metric, operation: 'first_below', threshold: r2(min.value - 0.01), ...TRAILING })).unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION');
    check(`${metric}: one cent over the maximum, nothing qualifies`,
      (await ask({ metric, operation: 'last_above', threshold: r2(max.value + 0.01), ...TRAILING })).unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION');
    console.log(`   live ${metric}: low ${min.value} on ${min.date}, high ${max.value} on ${max.date}`);
  }
  await verify('the last time debt was zero, this year', { metric: 'debt', operation: 'last_below', threshold: 0, ...YEAR });

  console.log('\n3. THE DEFECT ITSELF — the display series cannot answer; the tool searches the full one');
  {
    // ⚠️ THE GUARD THIS FILE WAS WRITTEN FOR. `get_net_worth_history` downsamples
    // a long daily read, so the day an exact answer lives on can be absent from
    // the payload entirely. For each exact answer over the WHOLE record, find a
    // display read that has dropped its day, and show three things at once: the
    // payload admits it is a sample, reading the sample gives a DIFFERENT answer,
    // and the tool's answer is the one the full series holds.
    const from = record.series[0].date;
    const probes: Ask[] = [
      { metric: 'debt', operation: 'first_below', threshold: 0 },
      ...answered.map((v) => ({ metric: v.args.metric, operation: v.args.operation,
        ...(v.args.threshold === undefined ? {} : { threshold: v.args.threshold }) })),
    ];
    let shown = 0;
    for (const a of probes) {
      const full = whole(a.metric);
      const got = await ask({ ...a });                       // no range: the whole record
      const want = oracle(full, a);
      if (!got.result || !want) continue;
      check(`${a.metric} ${a.operation}${a.threshold === undefined ? '' : ` ${a.threshold}`} over the whole record is the day the full series holds`,
        got.result.date === full[want.at].date && got.result.value === full[want.at].value, got.result.date);
      if (shown >= 3) continue;
      for (const maxPoints of [194, 150, 120, 90, 60, 45, 30, 20, 12, 6, 3]) {
        const display = await history({ from, to: asOfISO, granularity: 'daily', maxPoints });
        if (display.series.some((p) => p.date === got.result!.date)) continue;
        const sample: Obs[] = display.series.filter((p) => typeof p[a.metric] === 'number')
          .map((p) => ({ date: p.date, value: p[a.metric] as number }));
        const misread = oracle(sample, a);
        check(`…a ${maxPoints}-point display read of the same range does NOT contain ${got.result.date}, and says it is a sample`,
          display.coverage.seriesIsSample === true && display.coverage.observationsInRange === record.series.length
            && display.coverage.pointsReturned < display.coverage.observationsInRange,
          `${display.coverage.pointsReturned} of ${display.coverage.observationsInRange}`);
        check('…so reading the sample gives a DIFFERENT day (or none) — and the tool did not read the sample',
          misread === null || sample[misread.at].date !== got.result.date,
          `sample would say ${misread ? sample[misread.at].date : 'never'}; the record says ${got.result.date}`);
        shown++;
        break;
      }
    }
    check('at least one exact answer was shown to be absent from a display series — the guard is not vacuous', shown >= 1, `${shown} shown`);
  }

  console.log('\n4. HONEST ABOUT WHAT IT CANNOT SAY');
  {
    const oldest = record.series[0].date;
    check('a threshold nothing ever met is NO_OBSERVATION_MEETS_THE_CONDITION',
      (await ask({ metric: 'debt', operation: 'first_above', threshold: 1e12, ...YEAR }))
        .unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION');
    check('…which is a different answer from a range with no observations at all',
      (await ask({ metric: 'debt', operation: 'minimum', from: shift(oldest, -400), to: shift(oldest, -1) }))
        .unavailable === 'NO_OBSERVATIONS_IN_RANGE');
    check('a crossing operation with no threshold refuses rather than guessing one',
      typeof (await ask({ metric: 'debt', operation: 'first_below', ...YEAR })).error === 'string');
    check('an unknown metric is refused',
      typeof (await ask({ metric: 'vibes', operation: 'minimum' })).error === 'string');
  }

  console.log('\n5. THE INFORMATION CEILING HOLDS');
  {
    // A crossing with a day before it: asked AS OF that day before, the crossing
    // has not happened yet, and the search must not have read past the ceiling.
    const crossing = [zero, ...answered.filter((v) => v.args.operation.startsWith('first_'))]
      .find((v) => v.got.result?.previousObservation);
    check('the record holds a first crossing with an observation before it', crossing !== undefined);
    if (crossing) {
      const day = crossing.got.result!.date, eve = crossing.got.result!.previousObservation!.date;
      const args = crossing.args;
      console.log(`   hiding: ${args.metric} ${args.operation} ${args.threshold} → ${day}`);
      const early = await verify(`asked as of ${eve}, the day before`, args, { ceiling: eve });
      check(`…so ${day} cannot be seen`, early.got.result === null && early.got.unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION');
      check('…and the search really was bounded, not merely filtered afterwards',
        (early.got.coverage?.lastObservation ?? '9999') <= eve
          && (early.got.coverage?.observationsSearched ?? Infinity) < crossing.series.length,
        `${early.got.coverage?.observationsSearched} searched, through ${early.got.coverage?.lastObservation}`);
      const onTheDay = await verify(`asked as of ${day} itself`, args, { ceiling: day });
      check('…asked on the day itself, the day itself is the answer', onTheDay.got.result?.date === day);
    }
  }

  console.log('\n6. ONE RUNTIME, TWO CLIENTS, ONE FACT  [model-sampled: two turns]');
  if (process.env.CHECK_SKIP_MODEL) console.log('   (skipped: CHECK_SKIP_MODEL)');
  else {
    // ⚠️ THE PRODUCTION PATH AND THE TERMINAL PATH, BOTH DRIVEN HERE. The route
    // calls `runStatelessTurn`; the operator session opens a transcript and calls
    // `executeTurn`. If those ever answered differently, a dogfood session would
    // stop describing the product.
    const question = 'when did i first hit 0 with my debt this year?';
    const viaRoute = await runStatelessTurn({
      spaceCtx, agentId: agent?.id ?? 'temporal-check', user: question, history: [],
      asOfISO, surface: 'temporal-check', correlationId: 'temporal-check' });

    const open = await openTranscript({ spaceCtx, agentId: agent?.id ?? 'temporal-check',
      asOfISO, model: 'gpt-5.1' });
    const viaCli = await executeTurn({
      messages: open.messages, user: question, index: 0, model: 'gpt-5.1',
      toolSchemas: openAiToolSchemas(), toolCtx: { spaceCtx, spaceId, asOfISO },
      scenario: newScenarioSlot(), correlationId: 'temporal-check', surface: 'temporal-check' });

    type Call = { name: string; arguments: unknown; result: unknown };
    const callOf = (calls: readonly Call[]) => calls.find((x) => x.name === 'find_in_balance_history');
    const spoken = (iso: string) => new RegExp(`${iso}|${new Date(`${iso}T00:00:00Z`)
      .toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ${Number(iso.slice(8))}(?!\\d)`);
    const facts: (string | null)[] = [];
    for (const [label, call, answer] of [
      ['route', callOf(viaRoute.record.toolCalls as Call[]), viaRoute.answer],
      ['cli', callOf(viaCli.toolCalls as Call[]), viaCli.assistant]] as const) {
      check(`the ${label} path reached the deterministic tool`, call !== undefined);
      if (!call) continue;
      const a = call.arguments as Ask;
      const fact = (call.result as Found).result;
      facts.push(fact?.date ?? null);
      // Whatever range and threshold the model chose, the fact it was handed must be RIGHT for them.
      const series = within(whole(a.metric), a.from, [a.to, asOfISO].filter((d): d is string => !!d).sort()[0]);
      const want = oracle(series, a);
      check(`…and what it was handed is what the full series says for the arguments it chose`,
        (want ? series[want.at].date : null) === (fact?.date ?? null), `${JSON.stringify(a)} → ${fact?.date ?? 'no match'}`);
      check('…it asked about DEBT reaching ZERO', a.metric === 'debt' && a.operation === 'first_below' && a.threshold === 0, JSON.stringify(a));
      if (fact) {
        check(`the ${label} answer states that day`, spoken(fact.date).test(answer ?? ''), fact.date);
        // The original failure: a day named as the zero-debt day whose debt was not zero.
        const wrongDays = series.filter((p) => p.date !== fact.date && p.date !== fact.previousObservation?.date
          && p.date !== asOfISO && Math.abs(p.value) >= HALF_CENT && spoken(p.date).test(answer ?? ''));
        check('…and names no OTHER day on which debt was not zero', wrongDays.length === 0, wrongDays.map((p) => p.date).join(' '));
      } else {
        check(`the ${label} answer does not invent a date`, !/\b20\d\d-\d\d-\d\d\b/.test((answer ?? '').replace(new RegExp(asOfISO, 'g'), '')));
      }
    }
    check('both clients got the same fact', facts.length === 2 && facts[0] === facts[1], facts.join(' / '));
    console.log(`     route › ${(viaRoute.answer ?? '').slice(0, 130).replace(/\n/g, ' ')}…`);
    console.log(`     cli   › ${(viaCli.assistant ?? '').slice(0, 130).replace(/\n/g, ' ')}…`);
  }

  console.log('\n7. A CARD PAYMENT READS AS ONE EVENT');
  {
    type Row = { date: string; amount: number; account?: string; counterpartyAccount?: string };
    const tx = (args: Record<string, unknown>) => findTool('get_transactions')!.run(args, ctx) as Promise<{ rows: Row[] }>;
    // ⚠️ THE PAYMENT IS FOUND, NOT REMEMBERED. The largest card payment in the
    // record whose other leg is also in the record — then the ordinary browse of
    // those days must show BOTH legs, as the model would see them.
    const ranked = (await tx({ flow: 'card_payments', sort: 'largest', limit: 50 })).rows;
    const mirrors = (l: Row, m: Row) => m.amount === -l.amount && m.account === l.counterpartyAccount
      && m.counterpartyAccount === l.account && Math.abs(Date.parse(m.date) - Date.parse(l.date)) <= 5 * DAY;
    const leg = ranked.find((l) => l.counterpartyAccount && ranked.some((m) => mirrors(l, m)));
    if (!leg) console.log('   (no card payment with both legs in the record — the pairing relations are skipped)');
    else {
      const other = ranked.find((m) => mirrors(leg, m))!;
      const [from, to] = [leg.date, other.date].sort();
      const day = (await tx({ from, to, flow: 'card_payments', sort: 'oldest', limit: 50 })).rows;
      const legs = day.filter((r) => Math.abs(r.amount) === Math.abs(leg.amount)
        && [leg.account, other.account].includes(r.account) && (mirrors(leg, r) || mirrors(other, r)));
      check('both legs of the largest paired card payment are in the ledger the model reads', legs.length === 2, `${legs.length} legs on ${from}..${to}`);
      check('…one on each account, each naming the other',
        legs.length === 2 && legs[0].account === legs[1].counterpartyAccount
          && legs[1].account === legs[0].counterpartyAccount && legs[0].account !== legs[1].account);
      check('…and they are opposite signs, so nothing was collapsed',
        legs.length === 2 && legs[0].amount === -legs[1].amount && legs[0].amount !== 0);
    }
    const purchases = (await tx({ from: shift(asOfISO, -89), to: asOfISO, flow: 'spending', limit: 25 })).rows;
    check('an ordinary purchase names its account and no counterparty',
      purchases.some((r) => r.account && !r.counterpartyAccount), `${purchases.length} recent purchases read`);
  }

  console.log('\n8. A MONTHLY SPENDING FIGURE IS MEASURED OVER WHOLE MONTHS');
  {
    type Month = { month: string; spending: number; cardAndDebtPayments: number; partialMonth: boolean };
    type Spending = {
      totals: { spending: number; cardAndDebtPayments: number };
      monthlySpending?: { completeMonths: number; mean: number;
        lowest: { month: string; spending: number }; highest: { month: string; spending: number } };
      byMonth: Month[]; largestExpense?: { amount: number; date: string } | null;
    };
    const spending = (args: Record<string, unknown>) => findTool('get_spending')!.run(args, ctx) as Promise<Spending>;
    // A window that OPENS mid-month and closes on the as-of: both ends are partial unless they fall on a boundary.
    let from = shift(asOfISO, -190); if (from.endsWith('-01')) from = shift(from, 1);
    const sp = await spending({ from, to: asOfISO });
    const m = sp.monthlySpending;
    const wholeMonths = sp.byMonth.filter((x) => !x.partialMonth);
    check('it is present', m !== undefined);
    check('the month the window opens in is flagged partial — and so is the as-of month, unless it is complete',
      sp.byMonth[0]?.month === from.slice(0, 7) && sp.byMonth[0].partialMonth === true
        && (sp.byMonth[sp.byMonth.length - 1].month !== asOfISO.slice(0, 7)
          || sp.byMonth[sp.byMonth.length - 1].partialMonth === (monthEnd(asOfISO.slice(0, 7)) !== asOfISO)),
      sp.byMonth.map((x) => `${x.month}${x.partialMonth ? '*' : ''}`).join(' '));
    check('partial months are excluded from the count', m?.completeMonths === wholeMonths.length && wholeMonths.length >= 4, `${m?.completeMonths}`);
    check('the mean is the mean of the WHOLE months, to the cent',
      m?.mean === r2(wholeMonths.reduce((n, x) => n + x.spending, 0) / wholeMonths.length), `${m?.mean}`);
    check('lowest and highest are real months at the two ends of that spread',
      m?.lowest.spending === Math.min(...wholeMonths.map((x) => x.spending))
        && m?.highest.spending === Math.max(...wholeMonths.map((x) => x.spending))
        && wholeMonths.some((x) => x.month === m?.lowest.month && x.spending === m?.lowest.spending)
        && wholeMonths.some((x) => x.month === m?.highest.month && x.spending === m?.highest.spending)
        && (m?.lowest.spending ?? 1) <= (m?.mean ?? 0) && (m?.mean ?? 1) <= (m?.highest.spending ?? 0),
      `${m?.lowest.month} ${m?.lowest.spending} → ${m?.highest.month} ${m?.highest.spending}`);

    // ⚠️ A PAYOFF IS NOT SPENDING. The pin this replaces ("the payoff month is the
    // LOWEST spending month") was true of one July. What it meant: the month with
    // the heaviest card payments does not have them in its spending.
    const payoff = [...wholeMonths].sort((x, y) => y.cardAndDebtPayments - x.cardAndDebtPayments)[0];
    if (!payoff || payoff.cardAndDebtPayments <= 0) console.log('   (no whole month with a card payment in the window — the payoff relations are skipped)');
    else {
      const range = { from: `${payoff.month}-01`, to: monthEnd(payoff.month) };
      const alone = await spending(range);
      check(`the heaviest payoff month (${payoff.month}) read ALONE has the same spending and the same payments as its row in the long read`,
        alone.totals.spending === payoff.spending && alone.totals.cardAndDebtPayments === payoff.cardAndDebtPayments,
        `${alone.totals.spending} / ${alone.totals.cardAndDebtPayments}`);
      const tx = (args: Record<string, unknown>) => findTool('get_transactions')!.run(args, ctx) as
        Promise<{ rows: { amount: number; date: string }[]; rankedOver?: number; rankingIsComplete?: boolean }>;
      const biggestPurchase = (await tx({ ...range, flow: 'spending', sort: 'largest', limit: 1 })).rows[0];
      const biggestPayment = (await tx({ ...range, flow: 'card_payments', sort: 'largest', limit: 1 })).rows[0];
      check('…its largest expense is the largest PURCHASE the transaction tool ranks — two tools, one fact',
        !!biggestPurchase && alone.largestExpense?.amount === Math.abs(biggestPurchase.amount) && alone.largestExpense?.date === biggestPurchase.date,
        `${alone.largestExpense?.amount} on ${alone.largestExpense?.date}`);
      check('…and is NOT the card payment, which is reported apart',
        !!biggestPayment && (alone.largestExpense?.amount !== Math.abs(biggestPayment.amount) || alone.largestExpense?.date !== biggestPayment.date));
      if (Math.abs(biggestPayment?.amount ?? 0) > payoff.spending) {
        console.log(`   (that month's largest single payment exceeds its whole spending — it cannot be inside it)`);
      }
    }
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
