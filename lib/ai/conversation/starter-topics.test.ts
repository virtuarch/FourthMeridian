/**
 * lib/ai/conversation/starter-topics.test.ts
 *
 * The AI page's memory-backed starters. Standalone tsx (house pattern), exits 0/1.
 * Pure: rows in, strings out — no database, no model. The fixtures deliberately
 * carry a raw `statedAs`, a checkpoint value and a past opening balance, so every
 * "never shown" rule is tested against a string that would otherwise leak.
 */

import type { RecalledMemory } from './memory-store';
import { STATED_CLASSES, toPayload, type StatedClass } from './memory-model';
import { selectStarterTopics, selectMemoryPlans, MAX_INTENTION_PROMPTS } from './starter-topics';
import {
  composeStarters, EMPTY_STATE_SUGGESTIONS, MAX_STARTER_PROMPTS,
} from '@/components/ai/conversation-surface';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TODAY = '2026-09-13';
const RAW = 'RAW-WORDS actually make it 750k, also my $15k bonus';
let n = 0;
function mem(kind: string, payload: unknown, over: Partial<RecalledMemory> = {}): RecalledMemory {
  n++;
  return {
    id: `mem_${n}`, kind: kind as RecalledMemory['kind'], subject: `subject-${n}`,
    status: 'ACTIVE' as RecalledMemory['status'], payload, statedAs: RAW,
    statedAt: '2026-09-08T00:00:00.000Z', appliesFrom: null, appliesTo: null, supersedesId: null,
    ...over,
  };
}
const GOAL = { targetMetric: 'netWorth', targetAmount: 750000, byDate: '2029-12-31' };
const checkpoint = (horizon: string, value = 19896.54) => mem('CHECKPOINT', {
  metric: 'liquid', horizon, value,
  basis: { openingCash: 14610.26, dailyRate: 142.8979726027397, spendingSource: 'OBSERVED' },
});
const select = (rows: RecalledMemory[], currency = 'USD') => selectStarterTopics(rows, TODAY, currency);
const dump = (x: unknown) => JSON.stringify(x);

console.log('an active future target is a personal headline and chip');
{
  const out = select([mem('INTENTION', GOAL)]);
  check('headline names the user\'s own target', out.headline === 'Still aiming for $750K by 2029?', String(out.headline));
  check('one goal chip', out.prompts.length === 1 && out.prompts[0].topic === 'goal');
  check('chip label', out.prompts[0]?.label === 'Am I on pace for $750K by 2029?', out.prompts[0]?.label);
  check('prompt is ordinary prose naming the metric',
    out.prompts[0]?.prompt === 'Am I still on pace for my $750K net worth goal by the end of 2029?', out.prompts[0]?.prompt);
  const march = select([mem('INTENTION', { ...GOAL, byDate: '2027-03-31' })]);
  check('a non-year-end deadline reads as month + year', march.headline === 'Still aiming for $750K by Mar 2027?', String(march.headline));
  const unknown = select([mem('INTENTION', { ...GOAL, targetMetric: 'somethingNew' })]);
  check('a metric V1 never documented makes the row unreadable — not a chip, and never guessed',
    unknown.headline === null && unknown.prompts.length === 0, JSON.stringify(unknown));
  check('amounts follow the Space currency', select([mem('INTENTION', GOAL)], 'EUR').headline === 'Still aiming for €750K by 2029?');
  check('an unrenderable currency drops the topic rather than printing dollars',
    select([mem('INTENTION', GOAL)], 'NOT-A-CURRENCY').prompts.length === 0);
}

console.log('superseded, retired, passed and out-of-force memory never surfaces');
{
  const none = (rows: RecalledMemory[]) => { const o = select(rows); return o.headline === null && o.prompts.length === 0; };
  check('SUPERSEDED target ignored', none([mem('INTENTION', GOAL, { status: 'SUPERSEDED' as RecalledMemory['status'] })]));
  check('RETIRED target ignored', none([mem('INTENTION', GOAL, { status: 'RETIRED' as RecalledMemory['status'] })]));
  check('target whose byDate has passed ignored', none([mem('INTENTION', { ...GOAL, byDate: '2026-06-30' })]));
  check('memory whose appliesTo has passed ignored', none([mem('INTENTION', GOAL, { appliesTo: '2026-09-01T00:00:00.000Z' })]));
  check('memory whose appliesTo is still ahead is kept', !none([mem('INTENTION', GOAL, { appliesTo: '2027-01-01T00:00:00.000Z' })]));
  check('SUPERSEDED checkpoint ignored', none([{ ...checkpoint('2026-12-31'), status: 'SUPERSEDED' as RecalledMemory['status'] }]));
}

console.log('shapes that are not topics');
{
  const accountability = mem('INTENTION', {
    label: 'accountability preference', amount: 0,
    intent: 'Tell me when something may negatively affect me or get in the way of my plans.' });
  const out = select([accountability]);
  check('amount:0 preference-style intention ignored', out.headline === null && out.prompts.length === 0, dump(out));
  check('a zero target ignored', select([mem('INTENTION', { ...GOAL, targetAmount: 0 })]).prompts.length === 0);
  const assumption = select([mem('ASSUMPTION', { monthlySpending: 6000 })]);
  check('an assumption alone is never a topic', assumption.headline === null && assumption.prompts.length === 0);
  check('its figure never appears', !/6,?000|6K/.test(dump(assumption)));
  check('a non-liquid checkpoint is not a cash topic',
    select([mem('CHECKPOINT', { metric: 'netWorth', horizon: '2026-12-31', value: 1 })]).prompts.length === 0);
  check('an over-long planned-expense label is not a chip',
    select([mem('INTENTION', { intent: 'buy', label: 'x'.repeat(41), amount: 5000 })]).prompts.length === 0);
  const planned = select([mem('INTENTION', { intent: 'buy', label: 'a car', amount: 20000, earliest: '2027-03-01' })]);
  check('a planned expense with a real amount is a chip',
    planned.prompts[0]?.label === 'Can I afford a car (~$20K)?' && planned.prompts[0]?.topic === 'planned-expense', dump(planned));
  check('a planned expense alone does not claim the headline', planned.headline === null);
}

console.log('memory V2: every class `remember` can write goes through the one reader');
{
  const RULE = { liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: ['highest_apr', 'investments'] };
  const written: Record<StatedClass, RecalledMemory> = {
    GOAL: mem('INTENTION', toPayload('GOAL', { targetMetric: 'netWorth', targetAmount: 750000, byDate: '2029-12-31' })),
    PLANNED_EXPENSE: mem('INTENTION', toPayload('PLANNED_EXPENSE', { label: 'a car', amount: 20000, earliest: '2027-03-01' })),
    RULE: mem('INTENTION', toPayload('RULE', RULE)),
    BASELINE: mem('ASSUMPTION', toPayload('BASELINE', { monthlySpending: 5000 })),
  };
  for (const cls of STATED_CLASSES) {
    const plans = selectMemoryPlans([written[cls]], TODAY);
    const text = dump([plans, select([written[cls]])]);
    check(`${cls}: selected or deliberately silent — never mis-rendered`, !/undefined|null ~|NaN|\[object/.test(text.replace(/"headline":null|"nearestLiquidCheckpoint":null|"metric":null/g, '')), text);
  }
  check('a V2 goal is the same headline and chip as ever', select([written.GOAL]).headline === 'Still aiming for $750K by 2029?');
  check('a V2 planned expense is the same chip as ever', select([written.PLANNED_EXPENSE]).prompts[0]?.label === 'Can I afford a car (~$20K)?');
  check('a RULE is never a starter or a plan — a chip must not be one click from running it',
    selectMemoryPlans([written.RULE], TODAY).intentions.length === 0 && select([written.RULE]).prompts.length === 0);
  check('a planning figure is never a starter or a plan, and its figure never appears',
    selectMemoryPlans([written.BASELINE], TODAY).intentions.length === 0 && !/5,?000|5K/.test(dump(select([written.BASELINE]))));
  check('an open-ended goal and a debt-free goal are goals, but not dated targets to be "on pace" for',
    select([mem('INTENTION', toPayload('GOAL', { targetMetric: 'netWorth', targetAmount: 1000000 })),
      mem('INTENTION', toPayload('GOAL', { targetMetric: 'debt', targetAmount: 0, byDate: '2028-12-31' }))]).prompts.length === 0);
  check('a V2 projection is a topic by its horizon only',
    select([mem('CHECKPOINT', { v: 2, class: 'PROJECTION', metric: 'liquid', horizon: '2026-12-31', value: 37450.62, basis: { openingCash: 9274.31 } })])
      .prompts[0]?.label === 'Check my year-end cash projection');
  check('a retirement marker is nothing', select([mem('INTENTION', { v: 2, class: 'RULE', retired: true }, { status: 'RETIRED' as RecalledMemory['status'] })]).prompts.length === 0);

  // The chips the V1 reader produced from coerced rows — observed in the product.
  const coerced = [
    mem('INTENTION', { intent: 'keep-buffer', amount: 6, label: 'monthsOfExpenses' }),
    mem('INTENTION', { intent: 'allocation-rule', amount: 30000, label: 'Keep $30k cash, then pay highest-APR debt' }),
    mem('INTENTION', { targetMetric: 'liquid', targetAmount: 19096.50, byDate: null }),
    mem('INTENTION', { targetMetric: 'monthsOfExpenses', targetAmount: 9, byDate: '2030-01-01' }),
  ];
  const out = select(coerced);
  check('"Can I afford monthsOfExpenses (~$6)?" is no longer a chip — nor is any coerced row',
    out.headline === null && out.prompts.length === 0, dump(out));
}

console.log('checkpoints: one topic, nearest future horizon, never a figure');
{
  const rows = [checkpoint('2027-02-28', 53901.5), checkpoint('2026-12-31', 35898.84),
    checkpoint('2026-10-19', 19896.54), checkpoint('2026-09-01', 11111.11)];
  const out = select(rows);
  const cash = out.prompts.filter((p) => p.topic === 'cash-projection');
  check('exactly one projection topic', cash.length === 1, dump(out.prompts));
  check('the nearest FUTURE horizon (settled 2026-09-01 skipped)', cash[0]?.label === 'Check my Oct 19 cash projection', cash[0]?.label);
  check('its prompt names the horizon in words', cash[0]?.prompt === 'How is my cash projection for October 19, 2026 tracking?', cash[0]?.prompt);
  check('with no goal, a projection may carry the headline', out.headline === 'Want to check your Oct 19 cash projection?', String(out.headline));
  const text = dump(out);
  for (const leak of ['19896', '19,896', '19.9', '35898', '35,898', '35.9', '53901', '53.9', '11111', '14610', '14,610', '14.6', '142.89']) {
    check(`checkpoint value/basis "${leak}" never appears`, !text.includes(leak));
  }
  const yearEnd = select([checkpoint('2026-12-31')]);
  check('a current-year Dec 31 horizon reads "year-end"', yearEnd.prompts[0]?.label === 'Check my year-end cash projection', yearEnd.prompts[0]?.label);
  check('...and "the end of this year" in prose', yearEnd.prompts[0]?.prompt === 'How is my cash projection for the end of this year tracking?');
  check('a horizon of today is not yet settled', select([checkpoint(TODAY)]).prompts.length === 1);
  const settledOnly = select([checkpoint('2026-08-31'), checkpoint('2026-01-01')]);
  check('settled-only checkpoints produce nothing', settledOnly.headline === null && settledOnly.prompts.length === 0);
}

console.log('raw memory text never reaches the page');
{
  const everything = select([mem('INTENTION', GOAL), checkpoint('2026-12-31'),
    mem('INTENTION', { intent: 'buy', label: 'a car', amount: 20000 }), mem('ASSUMPTION', { monthlySpending: 6000 })]);
  const text = dump(everything);
  check('statedAs never appears', !text.includes('RAW-WORDS') && !text.includes('bonus'));
  check('no memory id or subject appears', !/mem_\d|subject-\d/.test(text));
  for (const p of everything.prompts) {
    check(`"${p.label}" is plain prose (no markup, no newline, no braces)`, /^[^{}<>\n]+$/.test(p.label + p.prompt));
  }
}

console.log('ordering and caps');
{
  const goals = [
    mem('INTENTION', { ...GOAL, targetAmount: 900000 }),
    mem('INTENTION', { ...GOAL, targetAmount: 800000, byDate: '2030-12-31' }),
    mem('INTENTION', { ...GOAL, targetAmount: 700000, byDate: '2031-12-31' }),
  ];
  const out = select([...goals, checkpoint('2026-12-31')]);
  check('the newest live goal is the headline (rows arrive newest first)', out.headline === 'Still aiming for $900K by 2029?', String(out.headline));
  check(`intention chips capped at ${MAX_INTENTION_PROMPTS}`, out.prompts.filter((p) => p.topic === 'goal').length === MAX_INTENTION_PROMPTS);
  check('order: goal, projection, further intention',
    dump(out.prompts.map((p) => p.topic)) === dump(['goal', 'cash-projection', 'goal']), dump(out.prompts.map((p) => p.topic)));
  check('an invalid today yields nothing', selectStarterTopics([mem('INTENTION', GOAL)], 'not-a-date', 'USD').prompts.length === 0);
}

console.log('composition over the generic empty state');
{
  const generic = composeStarters(null);
  check('no memory ⇒ generic headline (null ⇒ the rotating line)', generic.headline === null);
  check('no memory ⇒ exactly the generic chips',
    dump(generic.prompts) === dump(EMPTY_STATE_SUGGESTIONS.map(({ label, prompt }) => ({ label, prompt }))));
  check('an empty selection composes to the same generic state', dump(composeStarters(select([]))) === dump(generic));

  const both = composeStarters(select([mem('INTENTION', GOAL), checkpoint('2026-12-31')]));
  check(`at most ${MAX_STARTER_PROMPTS} chips`, both.prompts.length === MAX_STARTER_PROMPTS);
  check('personal chips lead', both.prompts[0].label === 'Am I on pace for $750K by 2029?' && both.prompts[1].label === 'Check my year-end cash projection');
  check('generic "Project my cash" steps aside for the personal projection', !both.prompts.some((p) => p.label === 'Project my cash'));
  check('remaining slots filled with generics', both.prompts[2].label === 'How am I looking?' && both.prompts[3].label === 'Where did I spend most?', dump(both.prompts));
  check('only label + prompt reach the browser', both.prompts.every((p) => dump(Object.keys(p)) === dump(['label', 'prompt'])));

  const goalOnly = composeStarters(select([mem('INTENTION', GOAL)]));
  check('one personal chip ⇒ three generics, "Project my cash" kept',
    dump(goalOnly.prompts.map((p) => p.label)) === dump(['Am I on pace for $750K by 2029?', 'How am I looking?', 'Project my cash', 'Where did I spend most?']),
    dump(goalOnly.prompts.map((p) => p.label)));
}

if (failures > 0) {
  console.error(`\nstarter-topics.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nstarter-topics.test: all passed.');
