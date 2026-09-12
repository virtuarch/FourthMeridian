/**
 * scripts/ai-baseline/active-scenario.test.ts
 *
 * THE CONTINUITY CONTRACT, PINNED. Pure — no model, no database — so the state
 * machine and the compaction interaction run in CI. The replay proof (that a
 * stored result is reproducible from its stored assumptions) needs real data and
 * lives in active-scenario.check.ts.
 *
 *   npx tsx scripts/ai-baseline/active-scenario.test.ts
 */

import { readFileSync } from 'node:fs';

import {
  captureActiveScenario, applyCapture, injectScenario, newScenarioSlot,
  scenarioMessage, ACTIVE_SCENARIO_MARKER, SCENARIO_TOOL, type ActiveScenario,
} from '@/scripts/ai-baseline/active-scenario';
import { compactToolHistory, DEFAULT_COMPACTION } from '@/scripts/ai-baseline/compaction';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

/** A scenario result shaped exactly like the live one from 1d67786. */
const scenarioResult = (liquid: number, netWorth: number) => ({
  asOf: '2026-09-12',
  horizon: { to: '2026-12-31', granularity: 'monthly', checkpoints: 4 },
  assumptions: { outflows: { count: 1 } },
  checkpoints: [
    { date: '2026-09-30', liquid: { amount: 17324.95 }, investments: { amount: 24346.97 },
      debt: { amount: 0 }, netWorth: { amount: 41671.92 } },
    { date: '2026-12-31', liquid: { amount: liquid }, investments: { amount: 24346.97 },
      debt: { amount: 0 }, netWorth: { amount: netWorth } },
  ],
});
const A1 = { to: '2026-12-31', granularity: 'monthly',
  outflows: [{ onDate: '2026-12-07', amount: -15000, label: 'bonus (net)' }] };
const A2 = { to: '2026-12-31', granularity: 'monthly',
  outflows: [{ onDate: '2026-12-07', amount: -15700, label: 'bonus (net)' }] };
const R1 = scenarioResult(50898.84, 75245.81);
const R2 = scenarioResult(51598.84, 75945.81);

console.log('1. CAPTURE — success establishes the pair');
{
  const c = captureActiveScenario(SCENARIO_TOOL, A1, R1);
  check('a successful scenario REPLACEs', c.action === 'REPLACE');
  if (c.action !== 'REPLACE') process.exit(1);
  check('assumptions are the arguments VERBATIM',
    JSON.stringify(c.scenario.assumptions) === JSON.stringify(A1));
  check('result is the ledger\'s FINAL checkpoint, not the first',
    c.scenario.result.liquid === 50898.84 && c.scenario.result.netWorth === 75245.81);
  check('…with the two dates that place it',
    c.scenario.result.asOf === '2026-09-12' && c.scenario.result.to === '2026-12-31');
  check('exactly the six figures and nothing else',
    Object.keys(c.scenario.result).join(',') === 'asOf,to,liquid,investments,debt,netWorth');
  check('exactly two keys on the envelope',
    Object.keys(c.scenario).join(',') === 'assumptions,result');
  for (const absent of ['id', 'fingerprint', 'hash', 'name', 'status', 'createdAt', 'turn', 'label']) {
    check(`no \`${absent}\``, !(absent in c.scenario));
  }
}

console.log('\n2. SUCCESSIVE SCENARIOS — replacement, never accumulation');
{
  const slot = newScenarioSlot();
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, A1, R1));
  check('A1/R1 active', slot.active?.result.liquid === 50898.84);
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, A2, R2));
  check('A2 replaces A1 in the assumptions',
    JSON.stringify(slot.active?.assumptions) === JSON.stringify(A2));
  check('…and R2 replaces R1 in the same write',
    slot.active?.result.liquid === 51598.84 && slot.active?.result.netWorth === 75945.81);
  check('no trace of A1/R1 remains anywhere in the slot',
    !JSON.stringify(slot).includes('-15000') && !JSON.stringify(slot).includes('50898.84'));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL,
    { ...A2, to: '2027-06-30' }, scenarioResult(70000, 94346.97)));
  check('a third replaces the second — one slot, no array, no history',
    slot.active?.result.liquid === 70000 && !Array.isArray(slot.active));
  check('the slot holds exactly one scenario', Object.keys(slot).join(',') === 'active');
}

console.log('\n3. FAILED RECOMPUTATION CLEARS — the non-negotiable half');
{
  for (const [label, bad] of [
    ['a thrown error', { error: 'boom' }],
    ['an unavailable refusal', { unavailable: 'no accounts in scope' }],
    ['no checkpoints', { asOf: '2026-09-12', horizon: { to: '2026-12-31' }, checkpoints: [] }],
    ['an unreadable final checkpoint', { asOf: '2026-09-12', horizon: { to: '2026-12-31' },
      checkpoints: [{ date: 'x', liquid: { amount: null }, investments: { amount: 1 },
        debt: { amount: 0 }, netWorth: { amount: 1 } }] }],
    ['a missing horizon', { asOf: '2026-09-12', checkpoints: R1.checkpoints }],
    ['null', null],
  ] as [string, unknown][]) {
    const slot = newScenarioSlot();
    applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, A1, R1));
    check(`${label}: was active first`, slot.active !== null);
    const c = captureActiveScenario(SCENARIO_TOOL, A2, bad);
    check(`${label}: CLEARs`, c.action === 'CLEAR', c.action === 'CLEAR' ? c.reason : c.action);
    applyCapture(slot, c);
    check(`${label}: the old result is GONE, not retained`, slot.active === null);
  }
}

console.log('\n4. ORDINARY TURNS AND project_cash LEAVE IT ALONE');
{
  const slot = newScenarioSlot();
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, A1, R1));
  const before = JSON.stringify(slot.active);
  for (const tool of ['project_cash', 'get_spending', 'get_transactions', 'remember',
    'scenario_goal_seek', 'reconcile_projection']) {
    const c = captureActiveScenario(tool, { to: '2026-12-31' }, { projection: { endingCash: 35898.84 } });
    check(`${tool} IGNOREs`, c.action === 'IGNORE');
    applyCapture(slot, c);
  }
  check('the hypothetical is byte-identical after all of them',
    JSON.stringify(slot.active) === before);
  check('a FAILED project_cash also leaves it alone — only a scenario can clear it',
    (() => { applyCapture(slot, captureActiveScenario('project_cash', {}, { error: 'boom' }));
      return JSON.stringify(slot.active) === before; })());
  check('scenario_goal_seek is NOT in this slice', SCENARIO_TOOL === 'scenario_projection');
}

console.log('\n5. CLIP 6 — the raw result is elided, the envelope is not');
{
  const slot = newScenarioSlot();
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, A1, R1));

  // A transcript shaped like 1d67786: scenario at turn 0, then two toolless turns.
  let messages: unknown[] = [
    { role: 'system', content: 'instruction' },
    { role: 'user', content: 'FINANCIAL ORIENTATION' },
  ];
  const turn = (user: string, withTool: boolean, answer: string) => {
    injectScenario(messages, slot);
    messages.push({ role: 'user', content: user });
    if (withTool) {
      messages.push({ role: 'assistant', content: null,
        tool_calls: [{ id: 't0', type: 'function',
          function: { name: SCENARIO_TOOL, arguments: JSON.stringify(A1) } }] });
      messages.push({ role: 'tool', tool_call_id: 't0', content: JSON.stringify(R1) });
    }
    messages.push({ role: 'assistant', content: answer });
    messages = compactToolHistory(messages, DEFAULT_COMPACTION).messages;
  };
  turn('what if I get a 15k bonus?', true, 'about $50.9k');
  turn('ga but exempt, and yes for fica', false, 'about $15.7k net');
  turn('exactly', false, '~$75-76k');
  injectScenario(messages, slot);
  messages.push({ role: 'user', content: 'how much should I invest?' });

  const raw = messages.filter((m) => (m as { role?: string }).role === 'tool');
  check('the raw scenario result HAS been elided — compaction unchanged',
    raw.every((m) => String((m as { content: string }).content).includes('"elided":true')),
    JSON.stringify(raw));
  const envelopes = messages.filter((m) =>
    typeof (m as { content?: unknown }).content === 'string'
    && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER));
  check('exactly ONE envelope survives — replaced each turn, never appended',
    envelopes.length === 1);
  check('…it is the LAST message, after the user\'s turn is popped',
    messages.indexOf(envelopes[0]) === messages.length - 2);
  check('…and it still carries 50898.84 with the -15000 assumption',
    String((envelopes[0] as { content: string }).content).includes('50898.84')
    && String((envelopes[0] as { content: string }).content).includes('-15000'));
  check('the deterministic figure needs no assistant prose to recover it',
    JSON.parse(String((envelopes[0] as { content: string }).content)
      .slice(ACTIVE_SCENARIO_MARKER.length)).result.liquid === 50898.84);
  check('the envelope is role:system, so compaction\'s turn count never sees it',
    (envelopes[0] as { role: string }).role === 'system');
  check('…and turn counting is unaffected: 3 completed turns, as without it',
    compactToolHistory(messages, DEFAULT_COMPACTION).stats.completedTurns === 3);

  // And when it goes away, the transcript is what it always was.
  slot.active = null;
  injectScenario(messages, slot);
  check('cleared ⇒ the message is removed entirely, not nulled',
    !messages.some((m) => typeof (m as { content?: unknown }).content === 'string'
      && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)));
}

console.log('\n6. SIZE');
{
  const s = scenarioMessage({ assumptions: A1, result: {
    asOf: '2026-09-12', to: '2026-12-31', liquid: 50898.84,
    investments: 24346.97, debt: 0, netWorth: 75245.81 } } as ActiveScenario).content;
  const tok = Math.ceil(s.length / 4);
  check('within the design estimate (~423 B / ~106 tok)', s.length < 700 && tok < 180,
    `${s.length} B / ~${tok} tok`);
  check('no prose doctrine in the label',
    !/prefer|always|never|trust|instead of|rather than|baseline/i.test(ACTIVE_SCENARIO_MARKER),
    ACTIVE_SCENARIO_MARKER);
}

console.log('\n7. STRUCTURE — no partial write exists');
{
  const code = (rel: string) => readFileSync(rel, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const mod = code('scripts/ai-baseline/active-scenario.ts');
  const run = code('scripts/ai-baseline/run.ts');
  check('the pair is built in ONE object literal',
    (mod.match(/assumptions:[\s\S]{0,200}?result: \{ asOf, to, liquid, investments, debt, netWorth \}/g) ?? []).length === 1);
  check('the slot is only ever assigned a WHOLE scenario or null',
    (mod.match(/slot\.active\s*=/g) ?? []).length === 2
    && /slot\.active = capture\.scenario/.test(mod) && /slot\.active = null/.test(mod));
  check('there is no setter for either half',
    !/\.assumptions\s*=/.test(mod) && !/\.result\s*=/.test(mod));
  // The type union declares `action: 'REPLACE';`; only the return constructs
  // `action: 'REPLACE',` with a scenario beside it. One minting site.
  check('capture is the only producer of a scenario',
    (mod.match(/action: 'REPLACE',/g) ?? []).length === 1
    && (mod.match(/scenario: \{\n\s*assumptions:/g) ?? []).length === 1);
  check('the write hook sits beside checkpointProjection, same position',
    /checkpointProjection\(toolCtx, call\.name, result\)[\s\S]{0,700}captureActiveScenario\(call\.name/.test(run));
  check('…and nothing here persists: no db, no memory, no checkpoint',
    !/db\.|prisma|rememberMemory|SpaceMemory|checkpointProjection/.test(mod));
  check('the envelope is injected before the user message, replaced not appended',
    /injectScenario\(messages, args\.scenario\);\s*messages\.push\(\{ role: 'user'/.test(run));
  check('compaction is untouched',
    !code('scripts/ai-baseline/compaction.ts').includes('ACTIVE_SCENARIO')
    && /retainCompletedTurns: 2/.test(code('scripts/ai-baseline/compaction.ts')));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
