/**
 * lib/ai/provider-deadline.test.ts  (SEC-AI-003)
 *
 * THE CHOKEPOINT HONOURS THE CALLER'S DEADLINE. A signal already aborted means
 * the provider is not asked; one that aborts mid-call abandons it; either way a
 * zero-token TIMEOUT fact with the turn-deadline code is written and the typed
 * error is thrown. The attempt number rides the ambient context onto failure
 * rows. Fake client, fake ledger, no network, no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/provider-deadline.test.ts
 */

import { generateWithTools, generateStructuredWithUsage, StructuredOutputTimeoutError, type StructuredClient } from './provider';
import { TurnTimeoutError, TURN_TIMEOUT_CODE, openTurnDeadline } from './turn-deadline';
import { runWithAiInvocationContext } from './invocation-context';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const settle = () => new Promise((r) => setImmediate(r));

type Call = { body: Record<string, unknown>; opts?: { signal?: AbortSignal } };
function fakeClient(respond: (call: Call) => Promise<unknown>) {
  const calls: Call[] = [];
  const client: StructuredClient = { chat: { completions: { create: (body, opts) => {
    const call = { body: body as Record<string, unknown>, opts }; calls.push(call); return respond(call);
  } } } };
  return { client, calls };
}
function ledger() {
  const rows: Record<string, unknown>[] = [];
  return { rows, sinks: {
    invocationClient: { aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); } } },
    paidRequestsAdmission: async () => ({ paused: false as const, state: 'MISSING' as const, raw: null }),
  } };
}
const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
const answer = async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: USAGE });
/** A provider that never answers until the signal aborts — what a hung connection looks like to the SDK. */
const hung = (call: Call) => new Promise<unknown>((_, reject) => {
  call.opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })), { once: true });
});
const SCHEMA = { name: 't', schema: { type: 'object', properties: {}, additionalProperties: false } };
const quiet = { setTimer: () => null, clearTimer: () => {} };

async function main() {
  console.log('1. the signal reaches the SDK call');
  {
    const { client, calls } = fakeClient(answer);
    const d = openTurnDeadline({ budgetMs: 60_000, ...quiet });
    const out = await generateWithTools({ model: 'gpt-5.1', messages: [], signal: d.signal }, { client, sinks: ledger().sinks });
    check('the call is made with the deadline\'s signal in its request options', calls.length === 1 && calls[0].opts?.signal === d.signal && out.content === 'ok');
    const { client: c2, calls: calls2 } = fakeClient(answer);
    await generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: c2, sinks: ledger().sinks });
    check('without a signal the request options are omitted (byte-identical to before)', calls2.length === 1 && calls2[0].opts === undefined);
  }

  console.log('\n2. already out of time ⇒ the provider is not asked');
  {
    const { client, calls } = fakeClient(answer);
    const l = ledger();
    const d = openTurnDeadline({ budgetMs: 1_000, ...quiet });
    d.abort();
    let threw: unknown;
    await generateWithTools({ model: 'gpt-5.1', messages: [], signal: d.signal }, { client, sinks: l.sinks }).catch((e) => { threw = e; });
    await settle();
    check('zero provider calls', calls.length === 0);
    check('TurnTimeoutError thrown', threw instanceof TurnTimeoutError);
    check('one zero-token TIMEOUT fact with the turn-deadline code',
      l.rows.length === 1 && l.rows[0].outcome === 'TIMEOUT' && l.rows[0].errorCode === TURN_TIMEOUT_CODE && l.rows[0].promptTokens === 0, JSON.stringify(l.rows));
  }

  console.log('\n3. the deadline fires DURING the call ⇒ abandoned, a TIMEOUT fact, the turn-deadline error');
  {
    const { client, calls } = fakeClient(hung);
    const l = ledger();
    const d = openTurnDeadline({ budgetMs: 60_000, ...quiet });
    const p = generateWithTools({ model: 'gpt-5.1', messages: [], signal: d.signal }, { client, sinks: l.sinks }).catch((e) => e);
    await settle();
    d.abort();
    const threw = await p;
    await settle();
    check('one call, abandoned', calls.length === 1 && threw instanceof TurnTimeoutError);
    check('the fact says TIMEOUT / turn_deadline (ours), not the SDK\'s abort',
      l.rows.length === 1 && l.rows[0].outcome === 'TIMEOUT' && l.rows[0].errorCode === TURN_TIMEOUT_CODE);
  }

  console.log('\n4. the structured path (the guidance label) honours the same signal');
  {
    const { client, calls } = fakeClient(hung);
    const l = ledger();
    const d = openTurnDeadline({ budgetMs: 60_000, ...quiet });
    const p = generateStructuredWithUsage('s', [{ role: 'user', content: 'u' }], SCHEMA, { model: 'gpt-5.1', timeoutMs: 60_000, signal: d.signal }, { client, sinks: l.sinks }).catch((e) => e);
    await settle();
    d.abort();
    const threw = await p;
    await settle();
    check('aborted by the turn deadline: TurnTimeoutError, one TIMEOUT fact', calls.length === 1 && threw instanceof TurnTimeoutError && l.rows[0]?.outcome === 'TIMEOUT' && l.rows[0]?.errorCode === TURN_TIMEOUT_CODE);

    const { client: c2 } = fakeClient(hung);
    const l2 = ledger();
    const d2 = openTurnDeadline({ budgetMs: 60_000, ...quiet });
    const threw2 = await generateStructuredWithUsage('s', [{ role: 'user', content: 'u' }], SCHEMA, { model: 'gpt-5.1', timeoutMs: 5, signal: d2.signal }, { client: c2, sinks: l2.sinks }).catch((e) => e);
    await settle();
    check('…while its OWN shorter timeout still says StructuredOutputTimeoutError', threw2 instanceof StructuredOutputTimeoutError && l2.rows[0]?.errorCode === 'abort');
    d2.dispose();

    const { client: c3, calls: calls3 } = fakeClient(answer);
    const d3 = openTurnDeadline({ budgetMs: 0, ...quiet });
    d3.abort();
    const threw3 = await generateStructuredWithUsage('s', [], SCHEMA, { model: 'gpt-5.1', signal: d3.signal }, { client: c3, sinks: ledger().sinks }).catch((e) => e);
    check('already spent ⇒ not asked', calls3.length === 0 && threw3 instanceof TurnTimeoutError);
  }

  console.log('\n5. the attempt number lands on FAILURE rows, never on a RETURNED row');
  {
    const l = ledger();
    const boom = fakeClient(async () => { throw Object.assign(new Error('Too Many Requests'), { status: 429 }); });
    await runWithAiInvocationContext({ correlationId: 'c', turnIndex: 1, surface: 'chat', subSurface: 'chat:answer', attempt: 2 },
      () => generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: boom.client, sinks: l.sinks })).catch(() => {});
    await settle();
    check('a RATE_LIMITED row carries finishReason "attempt:2"', l.rows[0]?.outcome === 'RATE_LIMITED' && l.rows[0]?.finishReason === 'attempt:2', JSON.stringify(l.rows[0]));

    const ok = fakeClient(answer);
    await runWithAiInvocationContext({ correlationId: 'c', turnIndex: 1, surface: 'chat', subSurface: 'chat:answer', attempt: 3 },
      () => generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: ok.client, sinks: l.sinks }));
    await settle();
    check('a RETURNED row keeps the provider\'s own finish_reason', l.rows[1]?.outcome === 'RETURNED' && l.rows[1]?.finishReason === 'stop');

    const l3 = ledger();
    await generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: boom.client, sinks: l3.sinks }).catch(() => {});
    await settle();
    check('no attempt in context ⇒ no finishReason on the failure row (as before)', l3.rows[0]?.outcome === 'RATE_LIMITED' && !('finishReason' in l3.rows[0]));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
