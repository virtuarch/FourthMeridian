/**
 * lib/ai/conversation/turn-deadline.test.ts  (SEC-AI-003)
 *
 * THE TURN LOOP IS THE ONE RETRY AUTHORITY, AND IT IS BOUNDED. With a fake
 * provider and a virtual clock: a transient 429 costs one retry; a permanent one
 * costs exactly CHAT_RATE_LIMIT_ATTEMPTS calls and the turn records why; the
 * sleep budget and the deadline cut retries short; a cancelled turn makes no
 * further call; quota is never retried. No network, no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/turn-deadline.test.ts
 */

import { executeTurn } from './turn';
import type { ToolContext } from './tools';
import { getAiInvocationContext } from '@/lib/ai/invocation-context';
import {
  CHAT_RATE_LIMIT_ATTEMPTS, CHAT_RATE_LIMIT_WAIT_BUDGET_MS, isTurnTimeoutFailure, openTurnDeadline, type TurnDeadline,
} from '@/lib/ai/turn-deadline';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

type Generate = NonNullable<Parameters<typeof executeTurn>[0]['generate']>;
type GenArgs = Parameters<Generate>[0] & { signal?: AbortSignal };
const RATE_LIMITED = () => Object.assign(new Error('Too Many Requests'), { status: 429 });
const QUOTA = () => Object.assign(new Error('429 You have no credits remaining.'), { status: 429, code: 'insufficient_quota' });
const prose = (content: string) => ({ content, toolCalls: [], raw: { role: 'assistant', content }, usage: null, latencyMs: 1, finishReason: 'stop' });
const toolCall = () => ({ content: null, toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }],
  raw: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }] },
  usage: null, latencyMs: 1, finishReason: 'tool_calls' });

/** A fake provider over a scripted sequence, on a virtual clock. */
function harness(script: (() => unknown)[]) {
  let t = 1_000_000;
  const seen: { attempt: number | undefined; signal: AbortSignal | undefined }[] = [];
  const sleeps: number[] = [];
  const generate = (async (a: GenArgs) => {
    seen.push({ attempt: getAiInvocationContext()?.attempt, signal: a.signal });
    t += 300;
    const step = script.shift();
    if (!step) throw new Error('script exhausted');
    const r = step();
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as Generate;
  const clock = { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
  const toolCtx = { plan: { pending: { clauses: [] }, scenarioRan: false } } as unknown as ToolContext;
  const run = (deadline?: TurnDeadline) => executeTurn({ messages: [], user: 'q', index: 0, model: 'gpt-5.1', toolSchemas: [], toolCtx,
    correlationId: 'conv-1', surface: 'chat', generate, clock, deadline });
  const deadline = (budgetMs: number) => openTurnDeadline({ budgetMs, now: () => t, setTimer: () => null, clearTimer: () => {} });
  return { run, seen, sleeps, clock, deadline, start: 1_000_000 };
}

async function main() {
  console.log('1. a transient 429 then an answer');
  {
    const h = harness([() => RATE_LIMITED(), () => prose('fine')]);
    const rec = await h.run();
    check('two calls, one recorded wait, the answer', h.seen.length === 2 && rec.retries.length === 1 && rec.assistant === 'fine' && !rec.error);
    check('each call saw its attempt number in the ambient context', h.seen.map((s) => s.attempt).join(',') === '1,2');
  }

  console.log('\n2. a permanent 429');
  {
    const h = harness(Array.from({ length: 10 }, () => () => RATE_LIMITED()));
    const rec = await h.run();
    check(`exactly ${CHAT_RATE_LIMIT_ATTEMPTS} provider calls (1 + 2 retries), then the turn records the failure`,
      h.seen.length === CHAT_RATE_LIMIT_ATTEMPTS && rec.retries.length === CHAT_RATE_LIMIT_ATTEMPTS - 1 && !rec.assistant && /Too Many Requests/.test(rec.error ?? ''),
      `${h.seen.length} calls, error=${rec.error}`);
    check('the waits are the linear backoff (5 s, 10 s), 15 s in all', h.sleeps.join(',') === '5000,10000');
  }

  console.log('\n3. the sleep budget');
  {
    const h = harness(Array.from({ length: 10 }, () => () => Object.assign(new Error('429 rate limit — try again in 50s'), { status: 429 })));
    const rec = await h.run();
    check(`two 50 s suggested waits do not fit ${CHAT_RATE_LIMIT_WAIT_BUDGET_MS / 1000} s: two calls, one wait, fail now`,
      h.seen.length === 2 && h.sleeps.length === 1 && h.sleeps[0] === 51_500 && /429/.test(rec.error ?? ''));
  }

  console.log('\n4. the deadline');
  {
    const h = harness(Array.from({ length: 10 }, () => () => RATE_LIMITED()));
    const d = h.deadline(3_000); // less than the 5 s first wait + 5 s minimum attempt
    const rec = await h.run(d);
    check('no retry is taken past the deadline: one call, no wait, the 429 recorded', h.seen.length === 1 && h.sleeps.length === 0 && /Too Many Requests/.test(rec.error ?? ''));

    const h2 = harness([() => prose('x')]);
    const d2 = h2.deadline(0);
    d2.abort();
    const rec2 = await h2.run(d2);
    check('a turn that is already out of time makes NO provider call and records the deadline', h2.seen.length === 0 && isTurnTimeoutFailure(rec2.error) && rec2.roundTrips === 0);

    // The provider answers hop 1 with a tool call and the deadline fires before hop 2.
    const h3 = harness([() => { d3.abort(); return toolCall(); }, () => prose('never')]);
    const d3 = h3.deadline(60_000);
    const rec3 = await h3.run(d3);
    check('cancelled after hop 1 ⇒ hop 2 is never asked; the tool result is kept; the deadline is the recorded error',
      h3.seen.length === 1 && rec3.toolCalls.length === 1 && isTurnTimeoutFailure(rec3.error) && rec3.assistant === null, `${h3.seen.length} calls, error=${rec3.error}`);

    const h4 = harness([() => prose('ok')]);
    const d4 = h4.deadline(60_000);
    await h4.run(d4);
    check('every provider call carries the deadline\'s signal', h4.seen[0]?.signal === d4.signal);
  }

  console.log('\n5. quota is never retried (db1950b)');
  {
    const h = harness([() => QUOTA(), () => prose('never')]);
    const rec = await h.run();
    check('one call, no wait, the quota error recorded', h.seen.length === 1 && h.sleeps.length === 0 && rec.retries.length === 0 && /no credits/.test(rec.error ?? ''));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
