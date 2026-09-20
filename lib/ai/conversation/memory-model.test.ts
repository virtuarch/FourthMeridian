/**
 * lib/ai/conversation/memory-model.test.ts
 *
 * DURABLE MEMORY V2 — the pure model. Deterministic, synthetic fixtures only.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/memory-model.test.ts
 *
 * The replay at the end is the test that would have caught V1's 0-of-90: the
 * recorded `remember` arguments (sanitised, figures remapped) are pushed through
 * `validateFields` + `admitWrite` under the most generous reading available, and
 * no accepted row may hold a derived dollar figure, a month count in a money
 * field, a zero placeholder or a null.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STATED_CLASSES, KIND_OF_CLASS, REMEMBERED, fieldNames, validateFields, validateShape, toPayload,
  tombstonePayload, readMemory, stateOf, describeMemory, mergeAmend, droppedFields, admitWrite,
  turnEvidence, producedNumbers, expectedFrom, composeMemoryLine, validSubject, LINE_CAPS, LINE_EMPTY,
  type MemoryRow, type Fields, type StatedClass, type TurnEvidence,
} from './memory-model';
import { CONTRIBUTION_KEYS, ALLOCATION_TARGET_WORDS, unknownContributionKeys, contributionBasis } from './scenario-rules';
import { scenarioMessage, type ActiveScenario } from './active-scenario';

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const TODAY = '2026-09-20';
interface Line { meaning: string; rules: { rule?: unknown; inWords?: string }[];
  planningAssumptions: { basis: string; meaning: string; stale?: boolean }[] & string;
  projectionsOnRecord: { count: number; horizons: string[] }; [section: string]: unknown }
const RULE3 = { liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: ['highest_apr', 'investments'] };
let n = 0;
const row = (kind: string, payload: unknown, over: Partial<MemoryRow> = {}): MemoryRow => ({
  id: `m${++n}`, kind, subject: `subject-${n}`, status: 'ACTIVE', payload, statedAs: 'RAW-WORDS',
  statedAt: '2026-09-20T00:00:00.000Z', appliesFrom: null, appliesTo: null, supersedesId: null, ...over });
const ok = (cls: StatedClass, f: unknown) => validateFields(cls, f).ok;
const why = (cls: StatedClass, f: unknown) => { const v = validateFields(cls, f); return v.ok ? '' : v.reason; };

console.log('1. a rule is the scenario contract\'s own clause');
{
  check('every RULE field is a contribution key', fieldNames('RULE').every((k) => (CONTRIBUTION_KEYS as readonly string[]).includes(k)));
  check('…so a valid rule holds EXACTLY contract keys', unknownContributionKeys(RULE3).length === 0 && ok('RULE', RULE3));
  check('the three-clause strategy validates', ok('RULE', RULE3));
  check('a floor ALONE is a rule: "keep six months of expenses in cash"', ok('RULE', { liquidFloorMonthsOfExpenses: 6 }));
  check('a floor with a destination but no stated share is admissible', ok('RULE', { liquidFloorMonthsOfExpenses: 6, target: 'investments' }));
  check('a surplus share is a rule', ok('RULE', { surplusFraction: 0.5, target: 'investments' }));
  check('two bases are refused', !ok('RULE', { liquidFloorMonthsOfExpenses: 6, surplusFraction: 1 }));
  check('`fractionOfExcess` without a floor is refused', !ok('RULE', { fractionOfExcess: 1 }) && /no floor/.test(why('RULE', { fractionOfExcess: 1 })));
  check('`target` alone is refused', !ok('RULE', { target: 'investments' }));
  check('a floor is said once — months OR dollars', !ok('RULE', { liquidFloorMonthsOfExpenses: 6, liquidFloor: 30000 }));
  for (const cut of [{ amount: 500, cadence: 'monthly' }, { fractionOfLiquid: 0.1, cadence: 'monthly' }, { liquidFloorMonthsOfExpenses: 6, label: 'x' }, { liquidFloorMonthsOfExpenses: 6, onDate: '2027-01-01' }]) {
    check(`not remembered as a rule: ${Object.keys(cut).join('+')}`, !ok('RULE', cut));
  }
  check('a liability id is not a remembered target', !ok('RULE', { ...RULE3, target: ['acct_123', 'investments'] })
    && !ok('RULE', { ...RULE3, target: { liability: 'acct_123' } }));
  check('the two target words are the contract\'s', JSON.stringify(ALLOCATION_TARGET_WORDS) === '["investments","highest_apr"]');
  check('the observed wrong key is refused by name, pointing at the right one',
    /`monthsOfExpenses` is not a rule field[\s\S]*liquidFloorMonthsOfExpenses/.test(why('RULE', { monthsOfExpenses: 6 })));
  check('a month count is not a dollar-sized number', !ok('RULE', { liquidFloorMonthsOfExpenses: 26078.88 }));
  check('75 is not a share', !ok('RULE', { liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 75 }));
}

console.log('2. null, empty and zero are not values');
{
  for (const bad of [null, '', Number.NaN, '6', undefined]) {
    check(`targetAmount ${JSON.stringify(bad) ?? 'undefined'} refused`, !ok('GOAL', { targetMetric: 'netWorth', targetAmount: bad }));
  }
  check('byDate: null refused (43 stored V1 rows)', !ok('GOAL', { targetMetric: 'liquid', targetAmount: 50000, byDate: null }));
  check('…and the refusal says to leave it out', /Leave a date out/.test(why('GOAL', { targetMetric: 'liquid', targetAmount: 50000, byDate: null })));
  check('byDate is optional — a forced date is an invented date', ok('GOAL', { targetMetric: 'netWorth', targetAmount: 1000000 }));
  check('31 February is not a date', !ok('GOAL', { targetMetric: 'netWorth', targetAmount: 1e6, byDate: '2030-02-31' }));
  check('amount: 0 refused', !ok('PLANNED_EXPENSE', { label: 'car', amount: 0 }) && /placeholder/.test(why('PLANNED_EXPENSE', { label: 'car', amount: 0 })));
  check('surplusFraction: 0 refused', !ok('RULE', { surplusFraction: 0 }));
  check('liquidFloorMonthsOfExpenses: 0 refused', !ok('RULE', { liquidFloorMonthsOfExpenses: 0 }));
  check('debt-free is the one zero that is a value', ok('GOAL', { targetMetric: 'debt', targetAmount: 0 }));
  check('…and ONLY that', !ok('GOAL', { targetMetric: 'liquid', targetAmount: 0 }));
  check('a free-text metric is refused', !ok('GOAL', { targetMetric: 'monthsOfExpensesInCash', targetAmount: 6 }));
  check('a goal refusal points rule-shaped content at `rule`, never at a missing key',
    /it is a `rule`/.test(why('GOAL', { targetMetric: 'liquid' })) && !/needs all of/.test(why('GOAL', { targetMetric: 'liquid' })));
  for (const balanceKey of ['currentCash', 'balance', 'liquid', 'netWorth', 'totalAssets', 'investments', 'debt', 'holdings']) {
    check(`no class can carry \`${balanceKey}\``, STATED_CLASSES.every((c) => !fieldNames(c).includes(balanceKey))
      && !ok('GOAL', { targetMetric: 'netWorth', targetAmount: 1e6, [balanceKey]: 12345 }));
  }
  check('a planning figure is exactly one measure', ok('BASELINE', { monthlySpending: 5000 }) && ok('BASELINE', { annualReturnPct: 7 })
    && !ok('BASELINE', { monthlySpending: 5000, annualReturnPct: 7 }));
  check('a planning figure inside a rule is pointed at its own item',
    /belongs to a BASELINE/.test(why('GOAL', { targetMetric: 'liquid', targetAmount: 1, monthlySpending: 5000 })));
  check('subjects are short stable keys', validSubject('cash-strategy') && !validSubject('Cash Strategy') && !validSubject(''));
}

console.log('3. stored payloads, the REMEMBERED stamp, validate-on-read');
{
  const p = toPayload('BASELINE', { monthlySpending: 5000 });
  check('a BASELINE is stamped REMEMBERED / PLANNING by code', p.basis === REMEMBERED && p.scope === 'PLANNING');
  check('…never with one of M1\'s three words', !['STATED', 'DECLARED', 'MEASURED'].includes(String(p.basis)));
  check('a BASELINE without the stamp does not read', !validateShape({ v: 2, class: 'BASELINE', monthlySpending: 5000 }).ok
    && !validateShape({ v: 2, class: 'BASELINE', monthlySpending: 5000, basis: 'STATED', scope: 'PLANNING' }).ok);
  check('a RULE payload nests its clause, so v/class never sit among contract keys',
    JSON.stringify(toPayload('RULE', RULE3)) === JSON.stringify({ v: 2, class: 'RULE', rule: RULE3 }));
  for (const cls of STATED_CLASSES) {
    const fields: Fields = cls === 'GOAL' ? { targetMetric: 'netWorth', targetAmount: 1e6, byDate: '2030-12-31' }
      : cls === 'PLANNED_EXPENSE' ? { label: 'car', amount: 20000, earliest: '2027-03-01' }
      : cls === 'RULE' ? RULE3 : { monthlySpending: 5000 };
    const read = readMemory({ kind: KIND_OF_CLASS[cls], payload: toPayload(cls, fields) });
    check(`${cls} round-trips through its payload`, read.readable && read.cls === cls && JSON.stringify(read.fields) === JSON.stringify(fields));
    check(`…and is unreadable under the wrong kind`, !readMemory({ kind: 'CHECKPOINT', payload: toPayload(cls, fields) }).readable);
  }
  check('a goal whose date has PASSED still reads — it is LAPSED, not unreadable', (() => {
    const r = row('INTENTION', toPayload('GOAL', { targetMetric: 'netWorth', targetAmount: 1e6, byDate: '2026-01-01' }));
    const read = readMemory(r); return read.readable && stateOf(r, read, TODAY) === 'LAPSED'; })());
  check('a tombstone is a marker, not an item', (() => { const r = readMemory({ kind: 'INTENTION', payload: tombstonePayload('RULE') });
    return !r.readable && r.tombstone; })());
  check('a projection needs its horizon — without one it would be a balance',
    !validateShape({ v: 2, class: 'PROJECTION', metric: 'liquid', value: 38243.5 }).ok);
  check('a projection basis is the closed code-written key set',
    validateShape({ v: 2, class: 'PROJECTION', metric: 'liquid', horizon: '2026-12-31', value: 1, basis: { spendingSource: 'OBSERVED', openingCash: 2 } }).ok
    && !validateShape({ v: 2, class: 'PROJECTION', metric: 'liquid', horizon: '2026-12-31', value: 1, basis: { surplusRule: 'x' } }).ok);
}

console.log('4. legacy rows — deterministic, by value, never reinterpreted');
{
  const read = (kind: string, payload: unknown) => readMemory({ kind, payload });
  const goal = read('INTENTION', { targetMetric: 'netWorth', targetAmount: 1000000, byDate: '2030-12-31' });
  check('a V1 target goal reads as a GOAL', goal.readable && goal.cls === 'GOAL' && goal.legacy);
  check('a V1 goal whose date passed reads, and is LAPSED', (() => { const r = row('INTENTION', { targetMetric: 'liquid', targetAmount: 5000, byDate: '2026-06-30' });
    const x = readMemory(r); return x.readable && stateOf(r, x, TODAY) === 'LAPSED'; })());
  for (const intent of ['buy', 'purchase', 'spend']) {
    const r = read('INTENTION', { intent, amount: 20000, label: 'a car' });
    check(`a V1 planned outlay under the documented intent "${intent}" reads`, r.readable && r.cls === 'PLANNED_EXPENSE');
  }
  const unreadable: [string, string, unknown][] = [
    ['amount: 6 squeezed into an outlay', 'INTENTION', { intent: 'keep-buffer', amount: 6, label: 'monthsOfExpenses' }],
    ['…even with a plausible label', 'INTENTION', { intent: 'Maintain a buffer', amount: 6, label: 'months of expenses to keep in cash' }],
    ['a frozen dollar floor under a rule-shaped intent', 'INTENTION', { intent: 'keep-buffer', amount: 35739.18, label: 'six months of expenses in cash' }],
    ['a zero placeholder', 'INTENTION', { intent: 'allocation-rule', amount: 0, label: 'Keep six months' }],
    ['a zero placeholder under a documented intent', 'INTENTION', { intent: 'buy', amount: 0, label: 'car' }],
    ['byDate: null', 'INTENTION', { targetMetric: 'liquid', targetAmount: 35739.18, byDate: null }],
    ['months smuggled through a free-text metric', 'INTENTION', { targetMetric: 'monthsOfExpenses', targetAmount: 9, byDate: '2030-01-01' }],
    ['an over-long label', 'INTENTION', { intent: 'buy', amount: 5000, label: 'x'.repeat(41) }],
    ['a mixed shape', 'INTENTION', { targetMetric: 'netWorth', targetAmount: 1e6, byDate: '2030-12-31', intent: 'buy' }],
    ['a standalone V1 assumption', 'ASSUMPTION', { monthlySpending: 6000 }],
    ['a checkpoint with no horizon', 'CHECKPOINT', { metric: 'liquid', value: 12382.81 }],
    ['a non-object payload', 'INTENTION', 'keep six months'],
  ];
  for (const [name, kind, payload] of unreadable) check(`unreadable: ${name}`, !read(kind, payload).readable);
  const cp = read('CHECKPOINT', { metric: 'liquid', horizon: '2026-12-31', value: 51598.84, basis: { spendingSource: 'USER_STATED', userAssumptions: ['x'], openingCash: 1 } });
  check('a V1 checkpoint with {metric, horizon, value} stays readable as a PROJECTION', cp.readable && cp.cls === 'PROJECTION' && cp.legacy);
  const line = JSON.stringify(composeMemoryLine(unreadable.map(([, kind, payload]) => row(kind, payload)), TODAY));
  check('no unreadable row reaches the memory line — nothing renders as money', line === JSON.stringify({ note: LINE_EMPTY }), line);
}

console.log('5. amend — field-wise, exclusive fields swap, the whole rule re-validated');
{
  const nine = mergeAmend('RULE', RULE3, { liquidFloorMonthsOfExpenses: 9 });
  check('six → nine changes the floor only', nine.ok && nine.fields.liquidFloorMonthsOfExpenses === 9
    && nine.fields.fractionOfExcess === 1 && JSON.stringify(nine.fields.target) === '["highest_apr","investments"]');
  check('…and echoes what changed and what was kept', nine.ok && JSON.stringify(nine.changed) === '[{"field":"liquidFloorMonthsOfExpenses","from":6,"to":9}]'
    && Object.keys(nine.kept).join() === 'fractionOfExcess,target');
  const dollars = mergeAmend('RULE', RULE3, { liquidFloor: 50000 });
  check('setting the dollar floor REMOVES the months floor (they swap)', dollars.ok && !('liquidFloorMonthsOfExpenses' in dollars.fields) && dollars.fields.liquidFloor === 50000);
  const flow = mergeAmend('RULE', RULE3, { surplusFraction: 0.5 });
  check('setting another basis removes the current basis\'s fields, keeps the target', flow.ok
    && JSON.stringify(flow.fields) === JSON.stringify({ target: ['highest_apr', 'investments'], surplusFraction: 0.5 }), JSON.stringify(flow));
  check('…decided by the contract\'s own basis function', contributionBasis(flow.ok ? flow.fields : {}) === 'SURPLUS_SHARE');
  const gutted = mergeAmend('RULE', RULE3, {}, ['liquidFloorMonthsOfExpenses']);
  check('an amendment leaving an invalid rule is refused, naming what would remain', !gutted.ok && /would leave/.test(gutted.reason) && 'fractionOfExcess' in gutted.wouldRemain);
  const drop = mergeAmend('RULE', RULE3, { target: 'investments' });
  check('"drop the debt-first part" is an amend of `target`', drop.ok && drop.fields.target === 'investments' && drop.fields.liquidFloorMonthsOfExpenses === 6);
  const swap = mergeAmend('BASELINE', { monthlySpending: 5000 }, { annualReturnPct: 7 });
  check('a planning figure is one measure: setting the other replaces it', swap.ok && JSON.stringify(swap.fields) === '{"annualReturnPct":7}');
  check('the drop guard names every field a re-statement would lose',
    droppedFields(RULE3, { liquidFloorMonthsOfExpenses: 9 }).join() === 'fractionOfExcess,target' && droppedFields(RULE3, RULE3).length === 0);
  check('an amend re-validates timelessly — a passed byDate does not block changing the amount',
    mergeAmend('GOAL', { targetMetric: 'netWorth', targetAmount: 1e6, byDate: '2026-01-01' }, { targetAmount: 1200000 }).ok);
}

console.log('6. admitWrite — money only in figures the user stated');
{
  const ev = (userTexts: string[], ours: unknown[] = []): TurnEvidence => ({ userTexts, ours: () => ours });
  const admit = (cls: StatedClass, supplied: Fields, e: TurnEvidence | null, current: Fields | null = null) =>
    admitWrite({ cls, supplied, current, evidence: e, asOf: TODAY });
  check('"$5k" licenses 5000', admit('BASELINE', { monthlySpending: 5000 }, ev(['Use $5k monthly spending for planning.'])).ok);
  check('"$1M" licenses 1000000', admit('GOAL', { targetMetric: 'netWorth', targetAmount: 1000000 }, ev(['I want $1M by 2030'])).ok);
  check('"5,000" and a bare "20000" license', admit('BASELINE', { monthlySpending: 5000 }, ev(['plan with 5,000 a month'])).ok
    && admit('PLANNED_EXPENSE', { label: 'car', amount: 20000 }, ev(['a car for 20000'])).ok);
  check('a bare small amount licenses ("a bike for 800")', admit('PLANNED_EXPENSE', { label: 'bike', amount: 800 }, ev(['a bike for 800'])).ok);
  check('the 6 of "6 months" licenses NO money', !admit('PLANNED_EXPENSE', { label: 'buffer', amount: 6 }, ev(['keep 6 months of expenses'])).ok);
  check('a month count spoken in words licenses no money (the replayed `amount: 6`)',
    !admit('PLANNED_EXPENSE', { label: 'months-of-expenses', amount: 6 }, ev(['Remember that I want six months cash.'])).ok);
  const computed = admit('GOAL', { targetMetric: 'liquid', targetAmount: 26078.88 }, ev(['Keep six months of expenses in cash.'], [{ thresholds: [{ monthsOfExpenses: 6, amount: 26078.88 }] }]));
  check('a figure from this turn\'s tool results is refused as OURS', !computed.ok && /figure we produced/.test(computed.reason));
  check('…including a rounding of it at the precision it was written', !admit('GOAL', { targetMetric: 'liquid', targetAmount: 26000 }, ev(['six months'], ['about $26,078.88'])).ok);
  check('…and a string leaf inside a tool result', (() => { const r = admit('PLANNED_EXPENSE', { label: 'buffer', amount: 30000 }, ev(['six months'], [{ note: 'a floor of $30,000 was kept' }])); return !r.ok && /we produced/.test(r.reason); })());
  check('the user\'s own rounding of our figure is theirs', admit('GOAL', { targetMetric: 'liquid', targetAmount: 26000 }, ev(['ok call it $26k'], ['$26,078.88'])).ok);
  const floor = admit('RULE', { liquidFloor: 30000 }, ev(['Keep six months of expenses in cash.'], ['6 × $5,000 = $30,000']));
  check('R2: a dollar floor the user never stated is refused, naming the months field', !floor.ok && /liquidFloorMonthsOfExpenses/.test(floor.reason));
  check('R2: "keep $50k liquid" is a dollar floor', admit('RULE', { liquidFloor: 50000 }, ev(['keep $50k liquid, invest the rest'])).ok);
  check('R2: a bare small integer is not dollar evidence for a floor', !admit('RULE', { liquidFloor: 500 }, ev(['keep 500'])).ok);
  check('non-money fields need no evidence', admit('RULE', RULE3, ev(['Keep six months of expenses…'])).ok && admit('BASELINE', { annualReturnPct: 7 }, ev(['assume seven percent'])).ok);
  check('no conversation evidence ⇒ a money value cannot be checked (fails closed)', !admit('BASELINE', { monthlySpending: 5000 }, null).ok && admit('RULE', RULE3, null).ok);
  check('R5: an amend never re-gates an inherited value', admit('GOAL', { targetAmount: 1000000, byDate: '2031-12-31' }, ev(['make it 2031']), { targetMetric: 'netWorth', targetAmount: 1000000, byDate: '2030-12-31' }).ok);
  check('R5: a field the call did not supply is not checked', admit('GOAL', { byDate: '2031-12-31' }, null, { targetMetric: 'netWorth', targetAmount: 1e6 }).ok);
  check('a new byDate must be in the future', !admit('GOAL', { byDate: '2026-01-01' }, ev([''])).ok && !admit('GOAL', { byDate: TODAY }, ev([''])).ok);
  check('debt-free (0) needs no figure', admit('GOAL', { targetMetric: 'debt', targetAmount: 0 }, ev(['I want to be debt-free'])).ok);
}

console.log('7. R1 — what the user said is passed in, never read off the transcript');
{
  // An `openTranscript`-shaped array: system, then the ORIENTATION AS A `role: \'user\'` MESSAGE.
  const orientation = `FINANCIAL ORIENTATION\n${JSON.stringify({ asOf: TODAY, position: { netWorth: 182345.67, liquid: 13330.97, investments: 150000 },
    recent: { spending: 16250.4 }, memory: { note: 'x' } }, null, 1)}`;
  const messages: unknown[] = [
    { role: 'system', content: 'You are… Today is 2026-09-20.' },
    { role: 'user', content: orientation },
    { role: 'user', content: 'How am I doing?' },
    { role: 'assistant', content: 'Your net worth is $182,345.67 and you hold $13,330.97 in cash.' },
    { role: 'user', content: 'Remember that as my goal.' },
  ];
  const e = turnEvidence(['How am I doing?', 'Remember that as my goal.'], messages);
  check('the orientation is OURS although it is a role:user message', producedNumbers(e.ours()).includes(13330.97) && producedNumbers(e.ours()).includes(150000));
  check('…and the conversation\'s user turns are not', !e.ours().includes('How am I doing?'));
  for (const v of [182345.67, 13330.97, 150000, 182000]) {
    const r = admitWrite({ cls: 'GOAL', supplied: { targetMetric: 'netWorth', targetAmount: v }, evidence: e, asOf: TODAY });
    check(`an orientation balance (${v}) does NOT license a Money value`, !r.ok && /we produced/.test(r.reason));
  }
  check('had "user messages" been read off the transcript, the orientation would have licensed it (the B1 defect, shown)',
    admitWrite({ cls: 'GOAL', supplied: { targetMetric: 'netWorth', targetAmount: 13330.97 },
      evidence: { userTexts: messages.filter((m) => (m as { role: string }).role === 'user').map((m) => (m as { content: string }).content), ours: () => [] }, asOf: TODAY }).ok);

  // The recorded trace turn: three directives, a scenario run, then "Remember this." — the model stored
  // `targetAmount` = the envelope's projected net worth as the user's goal. Synthetic figures, same structure.
  const scenario = { assumptions: { to: '2029-09-30', assumedMonthlySpending: 5000,
    contributions: [{ liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: ['highest_apr', 'investments'] }] },
    result: { asOf: TODAY, to: '2029-09-30', liquid: 30000, investments: 301204.51, debt: 0, netWorth: 371875.2 } } as unknown as ActiveScenario;
  const users = ['Use $5k/month as my spending assumption.', 'Keep six months of expenses in cash.', 'Pay highest-interest debt first, then invest.', 'Remember this.'];
  const transcript: unknown[] = [
    { role: 'system', content: 'You are…' }, { role: 'user', content: orientation },
    { role: 'user', content: users[0] }, { role: 'assistant', content: 'Understood — planning at $5,000 a month.' },
    { role: 'user', content: users[1] }, { role: 'assistant', content: 'Six months at that level is $30,000.' },
    { role: 'user', content: users[2] }, { role: 'assistant', content: 'Here is how that plays out.' },
    scenarioMessage(scenario),
    { role: 'user', content: users[3] },
  ];
  const te = turnEvidence(users, transcript);
  const goal = admitWrite({ cls: 'GOAL', supplied: { targetMetric: 'netWorth', targetAmount: 371875.2, byDate: '2029-09-30' }, evidence: te, asOf: TODAY });
  check('"Remember this." cannot store the scenario envelope\'s net worth as the user\'s goal', !goal.ok && /we produced/.test(goal.reason), JSON.stringify(goal));
  check('…nor the 30,000 we multiplied out, as a dollar floor', !admitWrite({ cls: 'RULE', supplied: { liquidFloor: 30000 }, evidence: te, asOf: TODAY }).ok);
  check('…while the rule and the $5k they DID state are admitted', admitWrite({ cls: 'RULE', supplied: RULE3, evidence: te, asOf: TODAY }).ok
    && admitWrite({ cls: 'BASELINE', supplied: { monthlySpending: 5000 }, evidence: te, asOf: TODAY }).ok);
  const echoed = turnEvidence(['x'], [{ role: 'tool', content: JSON.stringify({ stored: false, reason: 'r', expected: { baseline: { monthlySpending: 4321 } } }) }]);
  check('a memory write\'s own refusal echo is not evidence against the retry', producedNumbers(echoed.ours()).length === 0);
  check('`ours()` is lazy: a tool result that lands mid-turn is seen', (() => { const live: unknown[] = []; const lazy = turnEvidence(['q'], live);
    live.push({ role: 'tool', content: '{"expense":{"amount":4346.48}}' }); return producedNumbers(lazy.ours()).includes(4346.48); })());
}

console.log('8. refusals teach — the expected shape is built from the caller\'s own payload');
{
  check('the dominant wrong key becomes the contract key', JSON.stringify(expectedFrom({ intent: 'keep-buffer', label: 'x', monthsOfExpenses: 6 })) === '{"rule":{"liquidFloorMonthsOfExpenses":6}}');
  check('nested rule-ish payloads are read', JSON.stringify(expectedFrom({ bufferRule: { monthsOfExpenses: 9 }, allocationOrder: ['highest_apr', 'investments'] }))
    === '{"rule":{"liquidFloorMonthsOfExpenses":9,"target":["highest_apr","investments"]}}');
  check('an ordering in English is not guessed into target words', expectedFrom({ allocationOrder: ['pay highest-interest debt first', 'then invest'] }) === null);
  check('a planning figure inside a rule is handed back as its own item', JSON.stringify(expectedFrom({ plan: { monthlySpending: 5000 } })) === '{"baseline":{"monthlySpending":5000}}');
  check('a money key is never turned into months', expectedFrom({ amount: 6, label: 'monthsOfExpenses' }) === null);
}

console.log('9. words and the memory line');
{
  check('a rule is described from its fields, using the contract\'s own clause name',
    describeMemory('RULE', RULE3) === 'Keep 6 months of expenses in cash; each month-end move all of the cash above a floor of 6 months of expenses to the highest-APR debt first, then investments.',
    describeMemory('RULE', RULE3));
  check('a floor alone says the rest was not stated', /what happens to the rest was not stated/.test(describeMemory('RULE', { liquidFloorMonthsOfExpenses: 6 })));
  check('a flow rule says it keeps no floor', /keeps no cash floor/.test(describeMemory('RULE', { surplusFraction: 1, target: 'investments' })));
  check('a planning figure is described as not measured', /not their measured spending/.test(describeMemory('BASELINE', { monthlySpending: 5000 })));

  const rows = [
    row('INTENTION', toPayload('GOAL', { targetMetric: 'netWorth', targetAmount: 1000000, byDate: '2030-12-31' }), { subject: 'net-worth-target' }),
    row('INTENTION', toPayload('RULE', RULE3), { subject: 'cash-strategy' }),
    row('ASSUMPTION', toPayload('BASELINE', { monthlySpending: 5000 }), { subject: 'planning-spending' }),
    row('INTENTION', toPayload('PLANNED_EXPENSE', { label: 'car', amount: 20000, earliest: '2027-03-01' }), { subject: 'car' }),
    row('CHECKPOINT', { v: 2, class: 'PROJECTION', metric: 'liquid', horizon: '2026-12-31', value: 51598.84, basis: { openingCash: 13330.97 } }, { subject: 'liquid-2026-12-31' }),
  ];
  const line = composeMemoryLine(rows, TODAY) as unknown as Line;
  const text = JSON.stringify(line, null, 1);
  check('every class `remember` can write renders in the line', STATED_CLASSES.every((c) =>
    Array.isArray(line[{ GOAL: 'goals', RULE: 'rules', BASELINE: 'planningAssumptions', PLANNED_EXPENSE: 'planned' }[c]])));
  check('a rule appears as its literal clause — the arguments themselves', JSON.stringify(line.rules[0].rule) === JSON.stringify(RULE3));
  check('…or as one sentence when so configured', typeof (composeMemoryLine(rows, TODAY, { rules: 'sentence' }) as unknown as Line).rules[0].inWords === 'string'
    && !('rule' in (composeMemoryLine(rows, TODAY, { rules: 'sentence' }) as unknown as Line).rules[0]));
  check('the rule\'s line is identical whatever the expense baseline is — it holds no level', !/\d{3,}/.test(JSON.stringify(line.rules[0].rule)));
  check('a planning figure is REMEMBERED, dated, not measured, not in effect', line.planningAssumptions[0].basis === REMEMBERED
    && /On 2026-09-20 the user asked to plan with 5,000\/month of spending — not their measured spending, and not in effect unless they say so\./.test(line.planningAssumptions[0].meaning));
  check('…and the line says what to do with it: measured by default; if used, said to be remembered, measured figure beside it',
    /answer on measured evidence and mention that the figure is available/.test(String(line.planningNote))
      && /asked you to remember on its date, and give the measured figure beside it/.test(String(line.planningNote))
      && !('planningNote' in composeMemoryLine([rows[0]], TODAY)));
  check('…and never wears M1\'s words', !/STATED|DECLARED|MEASURED/.test(text));
  check('nothing listed is in effect, said once', /Nothing listed is in effect/.test(line.meaning));
  check('no projection value or basis reaches the line', !text.includes('51598') && !text.includes('13330') && line.projectionsOnRecord.count === 1
    && line.projectionsOnRecord.horizons[0] === '2026-12-31');
  check('projections point at the tool that reconciles them and are never balances', /`reconcile_projection` compares them/.test(text) && /never current balances/.test(text));
  check('`statedAs` never appears', !text.includes('RAW-WORDS'));
  check('with no planning figure the line says so (no false continuity)', (composeMemoryLine([rows[0]], TODAY) as unknown as Line).planningAssumptions === 'none remembered');
  check('the empty state names the tool', JSON.stringify(composeMemoryLine([], TODAY)) === JSON.stringify({ note: LINE_EMPTY }) && /record it with `remember`/.test(LINE_EMPTY));
  check('"nothing remembered" is said only when nothing at all is on record', !('note' in composeMemoryLine([rows[4]], TODAY)));

  const gone = [
    row('INTENTION', toPayload('RULE', RULE3), { status: 'SUPERSEDED' }), row('INTENTION', toPayload('RULE', RULE3), { status: 'RETIRED' }),
    row('INTENTION', tombstonePayload('RULE'), { status: 'RETIRED' }),
    row('INTENTION', toPayload('RULE', RULE3), { appliesTo: '2026-09-01T00:00:00.000Z' }),
    row('INTENTION', toPayload('GOAL', { targetMetric: 'netWorth', targetAmount: 1e6, byDate: '2026-06-30' })),
    row('INTENTION', toPayload('RULE', RULE3), { appliesFrom: '2027-01-01T00:00:00.000Z' }),
  ];
  check('superseded, retired, lapsed and not-yet items are absent', JSON.stringify(composeMemoryLine(gone, TODAY)) === JSON.stringify({ note: LINE_EMPTY }));
  const old = composeMemoryLine([row('ASSUMPTION', toPayload('BASELINE', { monthlySpending: 5000 }), { statedAt: '2026-03-01T00:00:00.000Z' })], TODAY) as unknown as Line;
  check('a planning figure older than 180 days is shown as stale, never silently trusted', old.planningAssumptions[0].stale === true);

  // R10 — bytes as the orientation serialises them (indent 1). Measured, then pinned.
  const typical = JSON.stringify(composeMemoryLine([rows[1], rows[2], rows[0]], TODAY), null, 1).length;
  const many = (k: number, make: (i: number) => MemoryRow) => Array.from({ length: k }, (_, i) => make(i));
  const worst = JSON.stringify(composeMemoryLine([
    ...many(5, (i) => row('INTENTION', toPayload('GOAL', { targetMetric: 'investments', targetAmount: 1234567.89 + i, byDate: '2035-12-31' }), { subject: `a-goal-subject-key-as-long-as-a-subject-may-be-${i}` })),
    ...many(5, (i) => row('INTENTION', toPayload('RULE', { ...RULE3, liquidFloorMonthsOfExpenses: 6 + i, from: '2026-10-01', to: '2036-09-30' }), { subject: `a-rule-subject-key-as-long-as-a-subject-may-be-${i}` })),
    ...many(4, (i) => row('ASSUMPTION', toPayload('BASELINE', { monthlySpending: 12345.67 + i }), { subject: `a-plan-figure-key-as-long-as-a-subject-may-be-${i}`, statedAt: '2026-01-01T00:00:00.000Z' })),
    ...many(5, (i) => row('INTENTION', toPayload('PLANNED_EXPENSE', { label: 'a kitchen remodel with everything in it!!', amount: 123456.78 + i, earliest: '2027-03-01' }), { subject: `an-outlay-subject-key-as-long-as-a-subject-may-${i}` })),
    ...many(9, (i) => row('CHECKPOINT', { v: 2, class: 'PROJECTION', metric: 'liquid', horizon: `2027-0${i + 1}-28`, value: 1 })),
  ], TODAY), null, 1).length;
  console.log(`     memory line bytes (indent 1): typical=${typical} cappedWorstCase=${worst} empty=${JSON.stringify({ note: LINE_EMPTY }, null, 1).length}`);
  check('typical line (rule + planning figure + goal) within budget', typical <= 1250, String(typical));
  check('capped worst case within budget', worst <= 3000, String(worst));
  check('caps hold', (() => { const l = composeMemoryLine(many(9, () => row('INTENTION', toPayload('RULE', RULE3))), TODAY) as unknown as Line; return l.rules.length === LINE_CAPS.rules; })());
}

console.log('10. replay of the 201 recorded `remember` calls (sanitised) through the V2 validators');
{
  interface Recorded { trace: string; userTexts: string[]; assistantFigures: string[]; scenarioAssumptions: unknown;
    toolResults: { tool: string; result: unknown }[]; args: { kind?: string; payload?: Record<string, unknown> }; v1Stored: boolean }
  const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'remember-replay.json'), 'utf8')) as { calls: Recorded[] };
  const MONTH_WORDS: Record<string, number> = { three: 3, six: 6, nine: 9, twelve: 12 };
  const accepted: { trace: string; cls: StatedClass; fields: Fields; users: string }[] = [];
  let nullOrZero = 0;

  for (const c of fx.calls) {
    const payload = c.args.payload ?? {};
    // THE MOST GENEROUS READING: the payload (and a nested `rule`) offered to EVERY class, foreign keys dropped.
    const flat: Fields = { ...payload, ...(payload.rule && typeof payload.rule === 'object' ? payload.rule as Fields : {}) };
    const evidence: TurnEvidence = { userTexts: c.userTexts,
      ours: () => [...c.assistantFigures, c.scenarioAssumptions, ...c.toolResults.map((t) => t.result)] };
    for (const cls of STATED_CLASSES) {
      const fields = Object.fromEntries(Object.entries(flat).filter(([k]) => fieldNames(cls).includes(k)));
      if (Object.keys(fields).length === 0 || !validateFields(cls, fields).ok) continue;
      if (!admitWrite({ cls, supplied: fields, current: null, evidence, asOf: TODAY }).ok) continue;
      accepted.push({ trace: c.trace, cls, fields, users: c.userTexts.join(' ') });
      if (Object.values(fields).some((v) => v === null || v === 0)) nullOrZero++;
      break;
    }
  }
  const money = (a: typeof accepted[number]) => (['targetAmount', 'amount', 'liquidFloor', 'monthlySpending'] as const)
    .map((k) => a.fields[k]).filter((v): v is number => typeof v === 'number');
  // Independent oracles, none of which call the gate: digits in the user's own turns, and month words.
  const userDigits = (users: string) => [...users.matchAll(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?\b/g)]
    .map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
  const derived = accepted.filter((a) => money(a).some((v) => !userDigits(a.users).includes(v)));
  const monthCounts = accepted.filter((a) => money(a).some((v) => Object.entries(MONTH_WORDS)
    .some(([w, k]) => k === v && new RegExp(`\\b${w}\\b`, 'i').test(a.users))));
  const byClass = accepted.reduce<Record<string, number>>((m, a) => ({ ...m, [a.cls]: (m[a.cls] ?? 0) + 1 }), {});
  console.log(`     recorded=${fx.calls.length} v1Stored=${fx.calls.filter((c) => c.v1Stored).length} v2Accepted=${accepted.length} ${JSON.stringify(byClass)}`);
  check('the fixture is the full recording', fx.calls.length === 201 && fx.calls.filter((c) => c.v1Stored).length === 117);
  check('NO accepted row holds a dollar figure the user did not type', derived.length === 0, JSON.stringify(derived.slice(0, 3)));
  check('NO accepted row holds a month count in a money field', monthCounts.length === 0, JSON.stringify(monthCounts.slice(0, 3)));
  check('NO accepted row holds a zero placeholder or a null', nullOrZero === 0);
  check('every accepted rule is the semantic rule — months, never dollars', accepted.filter((a) => a.cls === 'RULE')
    .every((a) => a.fields.liquidFloorMonthsOfExpenses === 6 && a.fields.liquidFloor === undefined));
  check('every accepted planning figure is the $5k the user typed', accepted.filter((a) => a.cls === 'BASELINE')
    .every((a) => a.fields.monthlySpending === 5000 && /\$5k/i.test(a.users)));
  check('what V1 stored and V2 refuses: 117 stored then, none of the frozen/coerced shapes now',
    accepted.length < 30 && accepted.every((a) => a.cls !== 'PLANNED_EXPENSE'), String(accepted.length));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
