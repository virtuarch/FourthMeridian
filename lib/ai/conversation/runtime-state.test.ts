/**
 * lib/ai/conversation/runtime-state.test.ts
 *
 * THE SEALED CARRIER — what it protects, and what it refuses.
 *
 * ⚠️ THE TESTS THAT MATTER HERE ARE THE NEGATIVE ONES. A carrier that round
 * trips is easy; a carrier that cannot be moved to another user, another Space,
 * another conversation or a later day is the reason a browser may hold it at
 * all. Every one of those is asserted against a REAL seal produced by the real
 * cipher — not a hand-written blob that any parser would reject.
 *
 *   npx tsx lib/ai/conversation/runtime-state.test.ts
 */

// ⚠️ SET BEFORE THE MODULE LOADS. The cipher derives its subkey from the root
// key at call time; a fixed test key keeps this DB-free AND env-free, and never
// touches the real one.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { readFileSync } from 'node:fs';
import {
  sealRuntimeState, openRuntimeState, conversationTail,
  RUNTIME_STATE_TTL_MS, MAX_SEALED_CHARS,
} from './runtime-state';
import type { ActiveScenario } from './active-scenario';
import { emptyPlan, stagePlan, MAX_PENDING_CLAUSES } from './pending-plan';
import { turnEvidence } from './memory-model';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const SCENARIO: ActiveScenario = {
  assumptions: { to: '2027-03-31', monthlySpending: 6000, contributions: 1500 },
  result: { asOf: '2026-09-13', to: '2027-03-31',
    liquid: 51_598.84, investments: 210_004.11, debt: -8_112.00, netWorth: 253_490.95 },
  covers: '2027-03-31. No other date was computed.',
};
const BINDING = { userId: 'usr_1', spaceId: 'spc_1', tail: 'tail_a' };

console.log('1. THE ROUND TRIP');
{
  const sealed = sealRuntimeState({ scenario: SCENARIO }, BINDING);
  check('a scenario seals', typeof sealed === 'string' && sealed.length > 0);
  const opened = openRuntimeState(sealed, BINDING);
  check('…and opens to exactly what went in',
    JSON.stringify(opened?.scenario) === JSON.stringify(SCENARIO));
  check('every figure survives to the cent',
    opened?.scenario?.result.liquid === 51_598.84 && opened?.scenario?.result.debt === -8_112.00);
  check('the assumptions survive verbatim — not re-parsed into a second schema',
    JSON.stringify(opened?.scenario?.assumptions) === JSON.stringify(SCENARIO.assumptions));
}

console.log('\n2. IT IS OPAQUE');
{
  const sealed = sealRuntimeState({ scenario: SCENARIO }, BINDING)!;
  check('no figure is readable in the carrier', !/51598|51,598|6000/.test(sealed));
  check('no field name is readable either', !/scenario|assumptions|netWorth|usr_1/.test(sealed));
  check('it is the repo\'s v2 authenticated-cipher format, not a home-made one',
    sealed.startsWith('v2:') && sealed.split(':').length === 4);
}

console.log('\n3. IT CANNOT BE MOVED');
{
  const sealed = sealRuntimeState({ scenario: SCENARIO }, BINDING)!;
  check('another user cannot open it',
    openRuntimeState(sealed, { ...BINDING, userId: 'usr_2' }) === null);
  check('another Space cannot open it',
    openRuntimeState(sealed, { ...BINDING, spaceId: 'spc_2' }) === null);
  check('another conversation cannot open it',
    openRuntimeState(sealed, { ...BINDING, tail: 'tail_b' }) === null);
  check('a NEW conversation (no assistant turn yet) cannot open it',
    openRuntimeState(sealed, { ...BINDING, tail: conversationTail([]) }) === null);
  check('the right binding still opens it — the refusals are not blanket',
    openRuntimeState(sealed, BINDING) !== null);
}

console.log('\n4. IT CANNOT BE FORGED OR EDITED');
{
  const sealed = sealRuntimeState({ scenario: SCENARIO }, BINDING)!;
  const [v, iv, tag, ct] = sealed.split(':');
  const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
  check('a flipped ciphertext byte is refused (authenticated, not merely encrypted)',
    openRuntimeState([v, iv, tag, flip(ct)].join(':'), BINDING) === null);
  check('a flipped auth tag is refused',
    openRuntimeState([v, iv, flip(tag), ct].join(':'), BINDING) === null);
  check('a flipped IV is refused', openRuntimeState([v, flip(iv), tag, ct].join(':'), BINDING) === null);
  check('a truncated carrier is refused', openRuntimeState(sealed.slice(0, -8), BINDING) === null);
  check('plain JSON is refused — a client cannot simply write the state it wants',
    openRuntimeState(JSON.stringify({ v: 1, ...BINDING, iat: Date.now(), scenario: SCENARIO }),
      BINDING) === null);
  check('a scenario with a fabricated result shape is refused',
    (() => {
      const bad = sealRuntimeState(
        { scenario: { assumptions: {}, result: 'all of it' } as unknown as ActiveScenario }, BINDING)!;
      return openRuntimeState(bad, BINDING) === null;
    })());
}

console.log('\n5. IT EXPIRES, AND IT CLEARS');
{
  const now = Date.now;
  try {
    const sealed = sealRuntimeState({ scenario: SCENARIO }, BINDING)!;
    Date.now = () => now() + RUNTIME_STATE_TTL_MS + 1;
    check('past the TTL it is refused', openRuntimeState(sealed, BINDING) === null);
    Date.now = () => now() + RUNTIME_STATE_TTL_MS - 60_000;
    check('inside the TTL it still opens', openRuntimeState(sealed, BINDING) !== null);
  } finally { Date.now = now; }

  check('no scenario seals to nothing — the carrier is cleared, not filled with null',
    sealRuntimeState({ scenario: null }, BINDING) === null);
  // ⚠️ AN OVERSIZED COOKIE IS DISCARDED SILENTLY BY THE BROWSER. Refusing to
  // issue one turns an invisible failure into an ordinary absent hypothetical.
  check('a scenario too large for a cookie is not issued',
    sealRuntimeState({ scenario: { ...SCENARIO,
      assumptions: { note: 'x'.repeat(4000) } } }, BINDING) === null);
  check('…and an ordinary one is comfortably inside the ceiling',
    (sealRuntimeState({ scenario: SCENARIO }, BINDING) ?? '').length < MAX_SEALED_CHARS / 2,
    `${(sealRuntimeState({ scenario: SCENARIO }, BINDING) ?? '').length} chars`);
  check('an absent carrier is simply no state',
    openRuntimeState(undefined, BINDING) === null && openRuntimeState('', BINDING) === null);
  check('a missing encryption key degrades to no continuity, it does not throw',
    (() => {
      const key = process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = '';
      try {
        return sealRuntimeState({ scenario: SCENARIO }, BINDING) === null
          && openRuntimeState('v2:aa:bb:cc', BINDING) === null;
      } finally { process.env.ENCRYPTION_KEY = key; }
    })());
}

console.log('\n6. THE TAIL IDENTIFIES A CONVERSATION');
{
  const t = (...turns: { role: string; content: string }[]) => conversationTail(turns);
  check('it is the LAST assistant turn, not the last turn',
    t({ role: 'assistant', content: 'A' }, { role: 'user', content: 'B' })
      === t({ role: 'assistant', content: 'A' }));
  check('a different reply is a different conversation',
    t({ role: 'assistant', content: 'A' }) !== t({ role: 'assistant', content: 'A ' }));
  check('no assistant turn yet ⇒ empty', t({ role: 'user', content: 'q' }) === '');
  check('it is a digest, not the words',
    !t({ role: 'assistant', content: 'your cash is $51,598.84' }).includes('51'));
  check('…of fixed width', t({ role: 'assistant', content: 'x' }).length
    === t({ role: 'assistant', content: 'x'.repeat(5000) }).length);
}

console.log('\n7. IT IS NOT PERSISTENCE');
{
  const src = readFileSync('lib/ai/conversation/runtime-state.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  check('it touches no database', !/db\.|prisma|findUnique|create\(/.test(src));
  check('it holds no module-level store', !/new Map|new Set|let cache|globalThis/.test(src));
  // Planning continuity widened this from one slot to two — what RAN and what was
  // STATED since — and the rest of the claim is unchanged: no evidence, no tool
  // result, no transcript, no memory.
  check('it carries the scenario and the staged plan, and NOTHING else',
    !/evidence|toolResult|messages|memory|body/.test(src)
    && /interface RuntimeState \{\s*scenario: ActiveScenario \| null;[\s\S]*?pending\?: PendingPlan \| null;\s*\}/.test(src));
}

console.log('\n8. A STAGED PLAN — carried beside the scenario, never as one');
{
  const staged = stagePlan(emptyPlan(), { stage: {
    incomeChanges: [{ op: 'SCALE', from: '2027-01-01', multiplier: 1.1 }],
    contributions: [{ liquidFloorMonthsOfExpenses: 9, fractionOfExcess: 1, target: ['highest_apr', 'investments'] }],
  } }, { turn: 0, evidence: turnEvidence(['up 10% from January; keep 9 months, pay highest APR first, invest the rest'], []) }).plan;
  const onlyPending = sealRuntimeState({ scenario: null, pending: staged }, BINDING);
  check('a conversation with ONLY staged conditions still seals', onlyPending !== null);
  const back = openRuntimeState(onlyPending, BINDING);
  check('…and opens to the same plan, with no scenario invented beside it',
    back !== null && back.scenario === null && JSON.stringify(back.pending) === JSON.stringify(staged));
  check('…and refuses a fresh chat', openRuntimeState(onlyPending, { ...BINDING, tail: '' }) === null);
  check('…another Space', openRuntimeState(onlyPending, { ...BINDING, spaceId: 'spc_2' }) === null);
  check('…another user', openRuntimeState(onlyPending, { ...BINDING, userId: 'usr_2' }) === null);
  check('an EMPTY plan is nothing to carry', sealRuntimeState({ scenario: null, pending: emptyPlan() }, BINDING) === null);
  const both = sealRuntimeState({ scenario: SCENARIO, pending: staged }, BINDING);
  const opened = openRuntimeState(both, BINDING);
  check('scenario and plan travel together, each intact',
    opened !== null && JSON.stringify(opened.scenario) === JSON.stringify(SCENARIO)
    && JSON.stringify(opened.pending) === JSON.stringify(staged));
  // The worst case the caps allow, beside an ordinary scenario, fits the seal.
  const e = turnEvidence(['$1,000 $2,000 $3,000 $4,000 $5,000 $6,000 $7,000 $8,000'], []);
  let worst = emptyPlan();
  for (let i = 0; i < MAX_PENDING_CLAUSES; i++) {
    worst = stagePlan(worst, { stage: { outflows: [{ onDate: `2027-0${i + 1}-15`, amount: (i + 1) * 1000,
      label: 'a forty-character name for a thing here' }] } }, { turn: i, evidence: e }).plan;
  }
  // The envelope's own worst case is pinned under 1,000 B (active-scenario.test.ts);
  // this one is padded to it, so the pair is tested at both ceilings at once.
  const BIG: ActiveScenario = { ...SCENARIO, assumptions: { ...SCENARIO.assumptions,
    pad: 'x'.repeat(Math.max(0, 1000 - JSON.stringify(SCENARIO).length)) } };
  check('the padded envelope is the pinned worst case', JSON.stringify(BIG).length >= 1000);
  const sealedWorst = sealRuntimeState({ scenario: BIG, pending: worst }, BINDING);
  check('the fullest plan the caps allow, beside a scenario, still fits the seal',
    sealedWorst !== null && sealedWorst.length <= MAX_SEALED_CHARS,
    `${sealedWorst?.length ?? 'refused'} chars / ${worst.clauses.length} clauses`);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
