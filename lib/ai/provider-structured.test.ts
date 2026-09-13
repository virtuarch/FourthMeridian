/**
 * lib/ai/provider-structured.test.ts
 *
 * THE STRUCTURED-OUTPUT SEAM, ON THE MODEL THE PRODUCT RUNS.
 *
 * ⚠️ THE PRE-FIX FAILURE IS PINNED FIRST. `generateStructured` always sent
 * `temperature` and `max_tokens`, which gpt-5.x rejects with a 400 (the dialect
 * note in provider.ts, measured 2026-09-07). §1 asserts the gpt-5.1 request now
 * carries neither; §2 asserts the classic dialect is exactly what it was.
 *
 * No network and no database: the OpenAI client and both usage ledgers are
 * injected fakes, and the real invocation writer runs against the fake so the
 * row it would write can be read.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/provider-structured.test.ts
 */

import {
  generateStructuredWithUsage, StructuredOutputRefusalError, StructuredOutputTimeoutError,
  REASONING_COMPLETION_BUDGET, type StructuredClient,
} from './provider';
import { runWithAiInvocationContext } from './invocation-context';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

type Call = { body: Record<string, unknown>; opts?: { signal?: AbortSignal } };

function fakeClient(respond: (call: Call) => Promise<unknown>) {
  const calls: Call[] = [];
  const client: StructuredClient = { chat: { completions: {
    create: (body, opts) => {
      const call = { body: body as Record<string, unknown>, opts };
      calls.push(call);
      return respond(call);
    },
  } } };
  return { client, calls };
}

function fakeSinks() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    sinks: {
      invocationClient: { aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); } } },
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

const USAGE = {
  prompt_tokens: 2100, completion_tokens: 320, total_tokens: 2420,
  prompt_tokens_details: { cached_tokens: 1024 },
  completion_tokens_details: { reasoning_tokens: 40 },
};
const ok = (content: string) => async () => ({
  choices: [{ message: { content }, finish_reason: 'stop' }], usage: USAGE,
});
const SCHEMA = { name: 't', schema: { type: 'object', properties: {}, additionalProperties: false } };

async function main() {
  console.log('1. gpt-5.1 — the modern dialect');
  {
    const { client, calls } = fakeClient(ok('{"headline":"ok"}'));
    const s = fakeSinks();
    const r = await generateStructuredWithUsage<{ headline: string }>(
      'sys', [{ role: 'user', content: 'u' }], SCHEMA,
      { model: 'gpt-5.1', temperature: 0.9 }, { client, sinks: s.sinks });
    const body = calls[0].body;
    check('no temperature is sent (gpt-5.x rejects a non-default one)', !('temperature' in body));
    check('no max_tokens is sent', !('max_tokens' in body));
    check('max_completion_tokens carries the reasoning budget',
      body.max_completion_tokens === REASONING_COMPLETION_BUDGET, String(body.max_completion_tokens));
    const rf = body.response_format as { type: string; json_schema: { strict: boolean; name: string } };
    check('the schema is strict json_schema', rf.type === 'json_schema' && rf.json_schema.strict === true && rf.json_schema.name === 't');
    check('the system prompt leads', (body.messages as { role: string }[])[0].role === 'system');
    check('the value is parsed', r.value.headline === 'ok');
    check('usage is reported as the provider gave it',
      r.usage?.promptTokens === 2100 && r.usage.cachedPromptTokens === 1024
        && r.usage.completionTokens === 320 && r.usage.reasoningTokens === 40);
    check('finish reason and model come back', r.finishReason === 'stop' && r.model === 'gpt-5.1');
    const { client: c2, calls: calls2 } = fakeClient(ok('{}'));
    await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1', maxTokens: 900 }, { client: c2, sinks: fakeSinks().sinks });
    check('an explicit maxTokens is honoured in the modern dialect', calls2[0].body.max_completion_tokens === 900);
  }

  console.log('\n2. gpt-4o-mini — the classic dialect is unchanged');
  {
    const { client, calls } = fakeClient(ok('{}'));
    await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-4o-mini' }, { client, sinks: fakeSinks().sinks });
    const body = calls[0].body;
    check('temperature defaults to 0.3', body.temperature === 0.3);
    check('max_tokens defaults to 1024', body.max_tokens === 1024);
    check('no max_completion_tokens', !('max_completion_tokens' in body));
  }

  console.log('\n3. unsafe responses fail loudly and are still accounted');
  {
    const s = fakeSinks();
    const { client } = fakeClient(ok('not json {'));
    let err: unknown;
    try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client, sinks: s.sinks }); }
    catch (e) { err = e; }
    await settle();
    check('invalid JSON throws', err instanceof Error && /not JSON/.test(err.message));
    check('…and the billed call is still recorded once', s.rows.length === 1);

    const { client: empty } = fakeClient(ok(''));
    let err2: unknown;
    try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client: empty, sinks: fakeSinks().sinks }); }
    catch (e) { err2 = e; }
    check('an empty response throws', err2 instanceof Error && /empty structured/.test(err2.message));

    const s3 = fakeSinks();
    const { client: refusing } = fakeClient(async () => ({
      choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }], usage: USAGE }));
    let err3: unknown;
    try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client: refusing, sinks: s3.sinks }); }
    catch (e) { err3 = e; }
    await settle();
    check('a refusal is a typed error', err3 instanceof StructuredOutputRefusalError);
    check('…and is recorded, because it was billed', s3.rows.length === 1);
  }

  console.log('\n4. the deadline');
  {
    const s = fakeSinks();
    const { client, calls } = fakeClient(({ opts }) => new Promise((_, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
    }));
    const t0 = Date.now();
    let err: unknown;
    try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1', timeoutMs: 40 }, { client, sinks: s.sinks }); }
    catch (e) { err = e; }
    await settle();
    check('a call that never returns is abandoned at the deadline', err instanceof StructuredOutputTimeoutError);
    check('…promptly', Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    check('…the signal reached the client', calls[0].opts?.signal instanceof AbortSignal);
    check('…and nothing was recorded, because nothing returned', s.rows.length === 0);

    const { client: fast, calls: fastCalls } = fakeClient(ok('{}'));
    await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1', timeoutMs: 40 }, { client: fast, sinks: fakeSinks().sinks });
    await new Promise((r) => setTimeout(r, 80));
    check('a call that returns in time is not aborted afterwards', fastCalls[0].opts?.signal?.aborted === false);
  }

  console.log('\n5. accounting — one invocation, attributed by ambient context');
  {
    const s = fakeSinks();
    const { client } = fakeClient(ok('{}'));
    await runWithAiInvocationContext({ correlationId: 'brief_test', turnIndex: 0, surface: 'brief' }, () =>
      generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client, sinks: s.sinks }));
    await settle();
    check('exactly one AiInvocation row', s.rows.length === 1, String(s.rows.length));
    const row = s.rows[0] ?? {};
    check('surface is brief', row.surface === 'brief');
    check('correlation and turn come from context', row.correlationId === 'brief_test' && row.turnIndex === 0);
    check('tokens as reported, tools zero',
      row.model === 'gpt-5.1' && row.promptTokens === 2100 && row.cachedPromptTokens === 1024
        && row.completionTokens === 320 && row.reasoningTokens === 40 && row.toolCallCount === 0);
    check('no prompt or completion text reaches the row',
      !JSON.stringify(row).includes('"s"') && !('content' in row) && !('messages' in row));
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
