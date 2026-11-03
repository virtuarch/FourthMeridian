/**
 * lib/ai/conversation/memory-user-evidence.test.ts — SEC-AI-006 (S2 P8 #3)
 *
 * A "user said" memory needs the USER to have said it. `remember` used to accept
 * a model-supplied `statedAs` with no user-turn evidence, so the model could
 * write a memory the user never said. Now the `statedAs` words must appear, as a
 * folded whole-word substring, in one of THIS conversation's user turns
 * (`ctx.turn.userTexts`), or the tool returns a typed refusal and writes nothing.
 *
 *   1. the pure matcher: normalisation (case, whitespace, punctuation, curly quotes)
 *   2. the tool: a match writes; a fabricated quote, an assistant-turn-only quote
 *      and a context with no turn evidence all refuse BEFORE the store
 *   3. read-only default (FM-AUDIT-019) still wins first
 *
 * Standalone tsx script. No DB (the store is an injected fake), no network, no model.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/memory-user-evidence.test.ts
 */
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
delete process.env.DATABASE_URL;

import { readFileSync } from 'node:fs';
import { foldForUserEvidence, statedInUserTurns, turnEvidence } from './memory-model';
import { MEMORY_TOOLS, STATED_AS_NOT_FROM_USER } from './memory-tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const remember = MEMORY_TOOLS.find((t) => t.name === 'remember')!;
const TODAY = '2026-09-20';

/** A fake memory client: records every touch, stores nothing, returns no prior row. */
function fakeClient() {
  const touched: string[] = [];
  const spaceMemory = new Proxy({}, {
    get: (_t, op: string) => async (args: { data?: Record<string, unknown> } = {}) => {
      touched.push(op);
      if (op === 'create') return { id: 'mem_1', createdAt: new Date(TODAY), updatedAt: new Date(TODAY), status: 'ACTIVE', supersedesId: null, ...args.data };
      if (op === 'findMany') return [];
      if (op === 'findFirst' || op === 'findUnique') return null;
      return { count: 0 };
    },
  });
  const client = new Proxy({ spaceMemory } as Record<string, unknown>, {
    get: (t, k: string) => k in t ? t[k] : k === '$transaction'
      ? async (fn: (tx: unknown) => unknown) => fn(client)
      : undefined,
  });
  return { client, touched };
}

function ctxWith(userTexts: string[] | null, messages: unknown[] = []) {
  const f = fakeClient();
  return {
    f,
    ctx: { spaceId: 'spc_test', asOfISO: TODAY, spaceCtx: { userId: 'usr_test' }, memoryClient: f.client,
      memoryWrites: true, ...(userTexts ? { turn: turnEvidence(userTexts, messages) } : {}) } as never,
  };
}

const RULE_CALL = (statedAs: string) => ({ subject: 'cash-strategy', statedAs, rule: { liquidFloorMonthsOfExpenses: 6 } });

async function main() {
  console.log('1. the matcher');
  {
    check('case folds', statedInUserTurns('KEEP SIX MONTHS', ['keep six months of expenses']));
    check('whitespace folds', statedInUserTurns('keep   six\nmonths', ['Keep six months of expenses']));
    check('punctuation folds', statedInUserTurns('keep six months, of expenses.', ['Keep six months of expenses!']));
    check('curly apostrophe ≡ straight', statedInUserTurns('I don’t want debt', ["I don't want debt anymore"]));
    check('curly double quotes ≡ straight', statedInUserTurns('“the car”', ['remember "the car" for 2027']));
    check('hyphen vs space folds', statedInUserTurns('six-month floor', ['a six month floor please']));
    check('a substring of one user turn matches', statedInUserTurns('a car around 20k in 2027', ['Hey — remember I want a car around 20k in 2027, ok?']));
    check('any user turn, not only the latest', statedInUserTurns('net worth of 1m by 2030', ['I want a net worth of 1M by 2030', 'what about now?']));
    check('a partial WORD does not match', !statedInUserTurns('car', ['I like my scarf']));
    check('blank never matches', !statedInUserTurns('   ', ['anything']) && !statedInUserTurns('...', ['anything']));
    check('non-string never matches', !statedInUserTurns(undefined, ['x']) && !statedInUserTurns(42, ['42']));
    check('no user turns never matches', !statedInUserTurns('x', []) && !statedInUserTurns('x', null));
    check('a quote spanning two turns does not match', !statedInUserTurns('first part second part', ['first part', 'second part']));
    check('fold is stable', foldForUserEvidence('  It’s  "Fine", OK?  ') === 'its fine ok');
  }

  console.log('\n2. the tool');
  {
    const said = 'Remember: I always want six months of expenses in cash.';
    const { f, ctx } = ctxWith([said]);
    const r = await remember.run(RULE_CALL('I always want six months of expenses in cash'), ctx) as Record<string, unknown>;
    check('a statedAs from the user\'s turn WRITES', r.stored === true, JSON.stringify(r));
    check('…through the store', f.touched.includes('create'), f.touched.join(','));
  }
  {
    const { f, ctx } = ctxWith(['How am I doing this month?']);
    const r = await remember.run(RULE_CALL('I always want six months of expenses in cash'), ctx) as Record<string, unknown>;
    check('a fabricated quote REFUSES', r.stored === false && r.refusal === STATED_AS_NOT_FROM_USER, JSON.stringify(r));
    check('…with `stored` as the first key (the echo rule)', JSON.stringify(r).startsWith('{"stored":false'));
    check('…and the store is never touched', f.touched.length === 0, f.touched.join(','));
  }
  {
    const assistantSaid = 'You should always keep six months of expenses in cash.';
    const messages = [
      { role: 'user', content: 'What should my buffer be?' },
      { role: 'assistant', content: assistantSaid },
      { role: 'user', content: 'Remember that.' },
    ];
    const { f, ctx } = ctxWith(['What should my buffer be?', 'Remember that.'], messages);
    const r = await remember.run(RULE_CALL('always keep six months of expenses in cash'), ctx) as Record<string, unknown>;
    check('a quote found only in an ASSISTANT turn REFUSES', r.stored === false && r.refusal === STATED_AS_NOT_FROM_USER, JSON.stringify(r));
    check('…and the store is never touched', f.touched.length === 0);
  }
  {
    const { f, ctx } = ctxWith(null);
    // `retire` (not a money record), so the pre-existing blind money gate is not what refuses.
    const r = await remember.run({ op: 'retire', subject: 'car', statedAs: 'forget the car' }, ctx) as Record<string, unknown>;
    check('no turn evidence on the context REFUSES (never falls back to writing)', r.stored === false && r.refusal === STATED_AS_NOT_FROM_USER, JSON.stringify(r));
    check('…and the store is never touched', f.touched.length === 0);
  }
  {
    const { f, ctx } = ctxWith(['forget the car']);
    const r = await remember.run({ op: 'retire', subject: 'car', statedAs: 'never said this' }, ctx) as Record<string, unknown>;
    check('retire is gated too', r.stored === false && r.refusal === STATED_AS_NOT_FROM_USER && f.touched.length === 0);
    const r2 = await remember.run({ op: 'amend', subject: 'cash-strategy', statedAs: 'make it nine', set: { liquidFloorMonthsOfExpenses: 9 } }, ctx) as Record<string, unknown>;
    check('amend is gated too', r2.stored === false && r2.refusal === STATED_AS_NOT_FROM_USER && f.touched.length === 0);
  }

  console.log('\n3. ordering');
  {
    const f = fakeClient();
    const ro = { spaceId: 's', asOfISO: TODAY, spaceCtx: { userId: 'u' }, memoryClient: f.client,
      turn: turnEvidence(['I always want six months'], []) } as never;
    const r = await remember.run(RULE_CALL('I always want six months'), ro) as Record<string, unknown>;
    check('a read-only context still refuses on the policy (memory writes off by default)', r.stored === false && r.refusal === undefined && /disabled/.test(String(r.reason)));
    const src = readFileSync('lib/ai/conversation/memory-tools.ts', 'utf8');
    const run = src.slice(src.indexOf("name: 'remember'"));
    check('the evidence gate sits before the only store call', run.indexOf('statedInUserTurns(') > -1
      && run.indexOf('statedInUserTurns(') < run.indexOf('rememberStated('));
    check('the gate reads the explicit user turns, never the transcript', /statedInUserTurns\(a\.statedAs, ctx\.turn\?\.userTexts\)/.test(run));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
