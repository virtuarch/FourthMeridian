/**
 * lib/ai/invocation-failures.test.ts  (OPERATIONALIZATION P0 — AI failure facts)
 *
 * THE FAILURE PATH IS A FACT. Before this slice a provider call that threw wrote
 * nothing to AiInvocation, so an outage was a console line. Now every throw at
 * the chokepoint writes ONE zero-token row with an outcome and an error CODE,
 * under the same attribution a success carries, and the error is rethrown
 * UNCHANGED. Proven against the real chokepoint with an injected client and an
 * injected ledger — no database, no network.
 *
 *   npx tsx lib/ai/invocation-failures.test.ts
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-never-used';

import { readFileSync } from 'node:fs';
import {
  generateStructuredWithUsage, StructuredOutputTimeoutError, type StructuredClient,
} from './provider';
import { classifyAiFailure, recordAiInvocationFailure, recordAiInvocation } from './invocation';
import { runWithAiInvocationContext } from './invocation-context';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const settle = () => new Promise((r) => setImmediate(r));
const SCHEMA = { name: 't', schema: { type: 'object', properties: {}, additionalProperties: false } };

function ledger() {
  const rows: Record<string, unknown>[] = [];
  return { rows, sinks: { invocationClient: { aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); } } } } };
}
const throwing = (err: unknown): StructuredClient => ({ chat: { completions: { create: async () => { throw err; } } } });
const apiError = (over: Record<string, unknown>) => Object.assign(new Error('provider said no: <prompt fragment would be here>'), over);

const CTX = { correlationId: 'conv-1', turnIndex: 3, surface: 'chat', subSurface: 'chat:answer',
  userId: 'usr_1', spaceId: 'spc_1', conversationId: '6f1d2c3b-0000-4000-8000-000000000001' };

async function main() {
  console.log('1. classification');
  {
    check('insufficient_quota (a 429) → QUOTA', classifyAiFailure(apiError({ status: 429, code: 'insufficient_quota' })).outcome === 'QUOTA');
    check('a plain 429 → RATE_LIMITED', classifyAiFailure(apiError({ status: 429 })).outcome === 'RATE_LIMITED');
    check('…with code 429 when the provider gave none', classifyAiFailure(apiError({ status: 429 })).errorCode === '429');
    check('the module\'s own timeout → TIMEOUT/abort', JSON.stringify(classifyAiFailure(new StructuredOutputTimeoutError(5))) === JSON.stringify({ outcome: 'TIMEOUT', errorCode: 'abort' }));
    const abort = Object.assign(new Error('x'), { name: 'APIUserAbortError' });
    check('the SDK\'s abort error → TIMEOUT', classifyAiFailure(abort).outcome === 'TIMEOUT');
    check('a 500 → FAILED/500', JSON.stringify(classifyAiFailure(apiError({ status: 500 }))) === JSON.stringify({ outcome: 'FAILED', errorCode: '500' }));
    check('an unknown error → FAILED with its class name', classifyAiFailure(new TypeError('boom')).errorCode === 'TypeError');
    check('the error MESSAGE is never the code', !/prompt fragment/.test(JSON.stringify(classifyAiFailure(apiError({ status: 500 })))));
  }

  console.log('\n2. the chokepoint writes a failure row and rethrows the same error');
  for (const [label, err, outcome, code] of [
    ['quota', apiError({ status: 429, code: 'insufficient_quota' }), 'QUOTA', 'insufficient_quota'],
    ['rate limit', apiError({ status: 429 }), 'RATE_LIMITED', '429'],
    ['5xx', apiError({ status: 503 }), 'FAILED', '503'],
  ] as const) {
    const L = ledger();
    let caught: unknown = null;
    await runWithAiInvocationContext(CTX, async () => {
      try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client: throwing(err), sinks: L.sinks }); }
      catch (e) { caught = e; }
    });
    await settle();
    const row = L.rows[0] ?? {};
    check(`${label}: the SAME error object is rethrown`, caught === err);
    check(`${label}: exactly one row, outcome ${outcome}`, L.rows.length === 1 && row.outcome === outcome, JSON.stringify(row));
    check(`${label}: error code ${code}, zero tokens`, row.errorCode === code && row.promptTokens === 0 && row.completionTokens === 0 && row.toolCallCount === 0);
    check(`${label}: attribution rides along`, row.userId === 'usr_1' && row.spaceId === 'spc_1' && row.conversationId === CTX.conversationId
      && row.subSurface === 'chat:answer' && row.correlationId === 'conv-1' && row.turnIndex === 3 && row.surface === 'chat');
    check(`${label}: no message text in the row`, !JSON.stringify(row).includes('prompt fragment'));
  }

  console.log('\n3. a timeout is OUR deadline → TIMEOUT');
  {
    const L = ledger();
    const slow: StructuredClient = { chat: { completions: { create: (_b, opts) => new Promise((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })));
    }) } } };
    let caught: unknown = null;
    try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1', timeoutMs: 30 }, { client: slow, sinks: L.sinks }); }
    catch (e) { caught = e; }
    await settle();
    check('the caller still gets StructuredOutputTimeoutError', caught instanceof StructuredOutputTimeoutError);
    check('the row says TIMEOUT / abort', L.rows.length === 1 && L.rows[0].outcome === 'TIMEOUT' && L.rows[0].errorCode === 'abort', JSON.stringify(L.rows[0]));
  }

  console.log('\n4. a success row carries attribution + the provider request id; a refusal stays RETURNED');
  {
    const L = ledger();
    const ok: StructuredClient = { chat: { completions: { create: async () => Object.assign({
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }, { _request_id: 'req_abc123' }) } } };
    await runWithAiInvocationContext(CTX, () => generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client: ok, sinks: L.sinks }));
    await settle();
    const row = L.rows[0] ?? {};
    check('outcome RETURNED with usage', row.outcome === 'RETURNED' && row.promptTokens === 10 && row.completionTokens === 2);
    check('providerRequestId from the SDK\'s _request_id', row.providerRequestId === 'req_abc123');
    check('userId / spaceId / conversationId / subSurface written', row.userId === 'usr_1' && row.spaceId === 'spc_1'
      && row.conversationId === CTX.conversationId && row.subSurface === 'chat:answer');

    const R = ledger();
    const refusing: StructuredClient = { chat: { completions: { create: async () => ({
      choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    }) } } };
    let caught: unknown = null;
    try { await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1' }, { client: refusing, sinks: R.sinks }); } catch (e) { caught = e; }
    await settle();
    check('a refusal throws for the caller but is a billed RETURNED row, not a failure row',
      caught !== null && R.rows.length === 1 && R.rows[0].outcome === 'RETURNED' && R.rows[0].promptTokens === 10);
  }

  console.log('\n5. outside any context, both writers still write (billable / observable), unattributed');
  {
    const L = ledger();
    await recordAiInvocation({ provider: 'OPENAI', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, latencyMs: 5 }, L.sinks.invocationClient);
    await recordAiInvocationFailure({ provider: 'OPENAI', model: 'm', outcome: 'FAILED', errorCode: 'X', latencyMs: 5 }, L.sinks.invocationClient);
    check('two rows, no attribution keys', L.rows.length === 2 && L.rows.every((r) => !('userId' in r) && !('conversationId' in r) && !('subSurface' in r)));
    const broken = { aiInvocation: { create: async () => { throw new Error('ledger down'); } } };
    let threw = false;
    try { await recordAiInvocationFailure({ provider: 'OPENAI', model: 'm', outcome: 'FAILED', errorCode: 'X', latencyMs: 5 }, broken); } catch { threw = true; }
    check('a ledger failure never throws out of the writer', !threw);
  }

  console.log('\n6. source: every provider create() site has a failure path, and the writer is the only one');
  {
    const src = readFileSync('lib/ai/provider.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const creates = (src.match(/completions\.create\(/g) ?? []).length;
    const failurePaths = (src.match(/recordOpenAiFailure\(\{/g) ?? []).length;
    check(`every create() (${creates}) is paired with a recordOpenAiFailure call (${failurePaths})`, creates >= 3 && failurePaths === creates, `${creates} vs ${failurePaths}`);
    check('the chokepoint rethrows on every failure path', (src.match(/recordOpenAiFailure\(\{[^\n]*\n\s*throw /g) ?? []).length === failurePaths);
    check('the failure writer lives in lib/ai/invocation.ts (the systemDb-allowlisted file)', /export async function recordAiInvocationFailure/.test(readFileSync('lib/ai/invocation.ts', 'utf8')));
    check('no other runtime module writes aiInvocation rows',
      !/aiInvocation\.create/.test(readFileSync('lib/ai/provider.ts', 'utf8')));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}
main();
