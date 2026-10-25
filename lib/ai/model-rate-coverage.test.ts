/**
 * lib/ai/model-rate-coverage.test.ts  (BETA C7 — every production model has a rate)
 *
 * TWO GUARDS ON THE SAME RULE: an unpriceable model never counts as zero and
 * never bypasses a safeguard.
 *
 *   1. STATIC — every model literal reachable from a production call site
 *      (the conversation engine's CHAT_MODEL, the Daily Brief's alias of it, the
 *      provider's legacy default) has a rate in AI_RATES effective TODAY. A
 *      model change without a rate-card entry fails this file before it ships.
 *   2. RUNTIME — the provider chokepoint refuses a model the card cannot price
 *      BEFORE calling the provider, throws the typed UnpricedModelError, and
 *      records a zero-token FAILED / UNPRICED_MODEL fact. Proven against the real
 *      chokepoint with an injected client (never called) and an injected ledger.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/model-rate-coverage.test.ts
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-never-used';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AI_RATES, rateAt } from '@/lib/usage/pricing';
import { todayUTCISO } from '@/lib/time/clock';
import {
  assertPricedModel, generateStructuredWithUsage, generateWithTools, isUnpricedModelFailure, UnpricedModelError, UNPRICED_MODEL_CODE,
  type StructuredClient,
} from './provider';
import { runWithAiInvocationContext } from './invocation-context';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === 'PrismaClientInitializationError') return;
  console.error('  ✗ unexpected:', err); process.exit(1);
});
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const settle = () => new Promise((r) => setImmediate(r));
const TODAY = todayUTCISO();

function ledger() {
  const rows: Record<string, unknown>[] = [];
  // AI COST CONTROLS — the kill switch is judged before the price; with no database it is PAUSED (fail closed), so the admitted reader is injected.
  return { rows, sinks: { invocationClient: { aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); } } }, paidRequestsAdmission: async () => ({ paused: false as const, state: 'MISSING' as const, raw: null }) } };
}
function countingClient(): { client: StructuredClient; calls: number } {
  const c = { client: undefined as unknown as StructuredClient, calls: 0 };
  c.client = { chat: { completions: { create: async () => { c.calls++; return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }; } } } };
  return c;
}
const SCHEMA = { name: 't', schema: { type: 'object', properties: {}, additionalProperties: false } };

async function main() {
  console.log('1. static: every production model literal has a rate effective today');
  {
    // The conversation engine's model — the one the product runs on.
    const engine = strip(read('lib/ai/conversation/engine.ts'));
    const chatModel = engine.match(/export const CHAT_MODEL = '([^']+)'/)?.[1] ?? null;
    check('engine.ts declares CHAT_MODEL as a literal', chatModel !== null, 'CHAT_MODEL literal not found');
    check(`CHAT_MODEL (${chatModel}) has an OPENAI rate in force today (${TODAY})`, chatModel !== null && rateAt('OPENAI', chatModel, TODAY) !== null);

    // The Daily Brief runs on the chat's model, by alias — pinned so it cannot drift to its own literal silently.
    const brief = strip(read('lib/ai/brief/daily-brief.ts'));
    check('daily-brief.ts aliases BRIEF_MODEL to CHAT_MODEL (no second literal)', /export const BRIEF_MODEL = CHAT_MODEL/.test(brief) && !/BRIEF_MODEL = '/.test(brief));
    const lifecycle = strip(read('lib/ai/brief/lifecycle.ts'));
    check('the Brief lifecycle generates on CHAT_MODEL', /model: CHAT_MODEL/.test(lifecycle));

    // The provider's legacy default (structured calls that omit a model, the dead chat helper) and its env override.
    const provider = strip(read('lib/ai/provider.ts'));
    const def = provider.match(/const CHAT_MODEL = process\.env\.AI_CHAT_MODEL \|\| '([^']+)'/)?.[1] ?? null;
    check('provider.ts declares its default model as a literal', def !== null);
    check(`provider default (${def}) has a rate in force today`, def !== null && rateAt('OPENAI', def, TODAY) !== null);
    if (process.env.AI_CHAT_MODEL) {
      check(`AI_CHAT_MODEL override (${process.env.AI_CHAT_MODEL}) has a rate in force today`, rateAt('OPENAI', process.env.AI_CHAT_MODEL, TODAY) !== null);
    }

    // No other production literal reaches a provider call: the only `model:` sources are these.
    const literals = new Set<string>();
    for (const f of ['lib/ai/conversation/engine.ts', 'lib/ai/conversation/turn.ts', 'lib/ai/brief/generate.ts', 'lib/ai/brief/lifecycle.ts', 'lib/ai/brief/daily-brief.ts', 'lib/ai/provider.ts']) {
      for (const m of strip(read(f)).matchAll(/model:\s*'(gpt-[^']+|o\d[^']*)'/g)) literals.add(m[1]);
    }
    check('no production call site passes a model literal of its own', literals.size === 0, [...literals].join(','));
    check('the rate card is non-empty and every entry is effective on or before today', AI_RATES.length > 0 && AI_RATES.every((r) => r.effectiveFrom <= TODAY));
  }

  console.log('\n2. runtime: the chokepoint refuses an unpriced model BEFORE the provider is called');
  {
    const UNPRICED = 'gpt-99-unpriced-preview';
    check('the fixture model really has no rate', rateAt('OPENAI', UNPRICED, TODAY) === null);
    const CTX = { correlationId: 'conv-x', turnIndex: 1, surface: 'chat', subSurface: 'chat:answer', userId: 'usr_9', spaceId: 'spc_9' };

    // structured path
    {
      const L = ledger(); const C = countingClient();
      let caught: unknown = null;
      await runWithAiInvocationContext(CTX, async () => {
        try { await generateStructuredWithUsage('s', [], SCHEMA, { model: UNPRICED }, { client: C.client, sinks: L.sinks }); } catch (e) { caught = e; }
      });
      await settle();
      check('structured: throws UnpricedModelError naming the model and the day', caught instanceof UnpricedModelError && caught.model === UNPRICED && caught.day === TODAY);
      check('structured: the provider was NEVER called', C.calls === 0);
      const row = L.rows[0] ?? {};
      check('structured: exactly one zero-token FAILED / UNPRICED_MODEL fact, attributed', L.rows.length === 1 && row.outcome === 'FAILED' && row.errorCode === UNPRICED_MODEL_CODE
        && row.promptTokens === 0 && row.completionTokens === 0 && row.model === UNPRICED && row.userId === 'usr_9' && row.surface === 'chat', JSON.stringify(row));
    }
    // tool path
    {
      const L = ledger(); const C = countingClient();
      let caught: unknown = null;
      try { await generateWithTools({ model: UNPRICED, messages: [] }, { client: C.client, sinks: L.sinks }); } catch (e) { caught = e; }
      await settle();
      check('tools: throws UnpricedModelError, provider never called, one FAILED / UNPRICED_MODEL fact',
        caught instanceof UnpricedModelError && C.calls === 0 && L.rows.length === 1 && L.rows[0].errorCode === UNPRICED_MODEL_CODE);
    }
    // a priced model still goes through, with no spurious failure fact
    {
      const L = ledger(); const C = countingClient();
      const r = await generateStructuredWithUsage<Record<string, never>>('s', [], SCHEMA, { model: 'gpt-5.1' }, { client: C.client, sinks: L.sinks });
      await settle();
      check('a priced model is called once and records one RETURNED row', C.calls === 1 && r.model === 'gpt-5.1' && L.rows.length === 1 && L.rows[0].outcome === 'RETURNED');
      const T = ledger(); const TC = countingClient();
      const t = await generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: TC.client, sinks: T.sinks });
      await settle();
      check('…and so is the tool path', TC.calls === 1 && t.usage?.promptTokens === 10 && T.rows.length === 1 && T.rows[0].outcome === 'RETURNED');
    }
    // source: the guard sits before every create, and does not disturb the create ↔ failure-path pairing.
    const src = strip(read('lib/ai/provider.ts'));
    const creates = [...src.matchAll(/completions\.create\(/g)].map((m) => m.index ?? 0);
    const guards = [...src.matchAll(/assertPricedModel\(/g)].map((m) => m.index ?? 0).slice(1); // [0] is the definition
    check(`every create() (${creates.length}) is preceded by an assertPricedModel guard (${guards.length})`, guards.length === creates.length
      && creates.every((c, i) => guards[i] < c));
    const guardBody = src.slice(src.indexOf('function assertPricedModel'), src.indexOf('\n}\n', src.indexOf('function assertPricedModel')));
    check('the guard records through the invocation writer, not the provider failure path (which pairs with a real attempt)',
      /recordAiInvocationFailure\(/.test(guardBody) && /errorCode: UNPRICED_MODEL_CODE/.test(guardBody) && !/recordOpenAiFailure\(/.test(guardBody) && /throw err/.test(guardBody));
    check('the guard resolves the rate for TODAY through the one rate card', /rateAt\('OPENAI', model, day\)/.test(src) && /todayUTCISO\(\)/.test(src));

    // The predicate a route reads the turn's RECORDED error back through.
    const e = new UnpricedModelError(UNPRICED, TODAY);
    check('isUnpricedModelFailure recognises the chokepoint message and nothing else',
      isUnpricedModelFailure(e.message) && !isUnpricedModelFailure('tool budget for this question is spent') && !isUnpricedModelFailure(null) && !isUnpricedModelFailure(undefined));
    // The exported guard — the Brief route's pre-flight — under the Brief's attribution.
    {
      const L = ledger(); let caught: unknown = null;
      try {
        runWithAiInvocationContext({ correlationId: 'b', turnIndex: 0, surface: 'brief', subSurface: 'brief:preflight', userId: 'usr_b', spaceId: 'spc_b' },
          () => assertPricedModel(UNPRICED, L.sinks));
      } catch (err) { caught = err; }
      await settle();
      check('the exported guard throws and records ONE FAILED / UNPRICED_MODEL fact under the caller\'s attribution (brief, user, Space)',
        caught instanceof UnpricedModelError && L.rows.length === 1 && L.rows[0].surface === 'brief' && L.rows[0].userId === 'usr_b' && L.rows[0].spaceId === 'spc_b' && L.rows[0].errorCode === UNPRICED_MODEL_CODE);
      const P = ledger();
      assertPricedModel('gpt-5.1', P.sinks);
      await settle();
      check('…and a priced model passes the exported guard silently (no row)', P.rows.length === 0);
    }
  }

  console.log('\n3. the routes: the refusal reaches the customer as its OWN sentence, never "try rephrasing"');
  {
    // ⚠️ THE TURN LOOP SWALLOWS THE THROW. lib/ai/conversation/turn.ts records a
    // provider failure as `rec.error` (a result, not a crash), so a route-level
    // `catch (err) { if (err instanceof UnpricedModelError) … }` is unreachable for
    // the tool path. The route must read the recorded error back.
    const turn = strip(read('lib/ai/conversation/turn.ts'));
    check('turn.ts still types a provider throw as the turn\'s error (the premise)', /rec\.error = err instanceof Error \? err\.message : String\(err\)/.test(turn));
    const chat = strip(read('app/api/ai/chat/route.ts'));
    const noAnswer = chat.slice(chat.indexOf('if (!turn.answer)'), chat.indexOf('SAY.silent'));
    check('chat: reads the recorded error back through isUnpricedModelFailure BEFORE the generic no-text sentence',
      noAnswer.length > 0 && /isUnpricedModelFailure\(turn\.record\.error\)/.test(noAnswer) && /SAY\.unpriced/.test(noAnswer) && /503/.test(noAnswer));
    check('chat: the unpriced sentence names the gap and says nothing was changed; it does not say "try rephrasing"',
      // The sentence lives in the shared refusal list (AI reliability F2); the route binds SAY to it.
      /const SAY = CHAT_REFUSAL_SAY;/.test(chat)
        && /unpriced:\s*'Conversations are paused: the model in use can’t be priced yet/.test(read('lib/ai/conversation/refusal-sentences.ts'))
        && !/unpriced:[^\n]*\n?[^\n]*rephras/.test(read('lib/ai/conversation/refusal-sentences.ts')));
    const brief = strip(read('app/api/brief/generate/route.ts'));
    const pre = brief.indexOf('assertPricedModel(BRIEF_MODEL)');
    check('brief: a pre-flight through the exported chokepoint runs AFTER the allowance check and BEFORE generateBriefResponse (no claim, no cooldown on an unpriceable model)',
      pre > 0 && brief.indexOf('dailyAiAllowanceFor(') < pre && pre < brief.indexOf('generateBriefResponse(user.id'));
    check('brief: under the Brief\'s own attribution (surface brief, the AUTHENTICATED user; the body\'s Space is NOT attributed before membership is proven), answering 503 with code UNPRICED_MODEL',
      /surface: 'brief', subSurface: 'brief:preflight', userId: user\.id \}/.test(brief) && /code: UNPRICED_MODEL_CODE/.test(brief)
      && /status: 503/.test(brief.slice(brief.indexOf('err instanceof UnpricedModelError'), brief.indexOf('err instanceof UnpricedModelError') + 400)));
    check('brief: the Brief runs on BRIEF_MODEL, the alias of CHAT_MODEL, so the pre-flight checks the model that will be called', /import \{ BRIEF_MODEL \} from '@\/lib\/ai\/brief\/daily-brief'/.test(brief));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}
void main();
