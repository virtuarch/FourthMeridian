/**
 * lib/ai/rate-limit-retry.test.ts
 *
 * A RATE LIMIT IS ABSORBED — BOUNDED, 429 ONLY, INSIDE THE CALLER'S DEADLINE.
 *
 *   npx tsx lib/ai/rate-limit-retry.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  BACKOFF_MAX_MS, BACKOFF_STEP_MS, DEFAULT_MAX_RATE_LIMIT_RETRIES, SUGGESTED_WAIT_MARGIN_MS,
  callWithRateLimitRetry, isRateLimitError, rateLimitWaitMs, type RateLimitRetryRecord,
} from './rate-limit-retry';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const RATE_LIMITED = new Error('429 Rate limit reached for gpt-5.1 in organization org-x on tokens per min (TPM): Limit 500000. Please try again in 12.4s.');
const BARE_429 = Object.assign(new Error('Too Many Requests'), { status: 429 });

/** A fake provider: fails `failures` times with `err`, then answers. Virtual clock. */
function harness(failTimes: number, err: unknown = RATE_LIMITED) {
  let t = 1_000_000;
  const calls: number[] = [];
  const sleeps: number[] = [];
  const retries: RateLimitRetryRecord[] = [];
  const call = async (attempt: number) => {
    calls.push(attempt);
    t += 300;                                   // a 429 comes back fast
    if (calls.length <= failTimes) throw err;
    return 'ok';
  };
  const options = { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, onRetry: (r: RateLimitRetryRecord) => retries.push(r) };
  return { call, options, calls, sleeps, retries, start: 1_000_000, clock: () => t };
}

async function main() {
  console.log('1. what is a rate limit, and how long to wait');
  {
    check('a 429 by status', isRateLimitError(BARE_429));
    check('a 429 by message', isRateLimitError(RATE_LIMITED) && isRateLimitError(new Error('Rate limit exceeded')));
    check('a timeout, a 5xx, a refusal are not', ![new Error('503 upstream'), new Error('did not arrive within 60000 ms'), 'nope'].some(isRateLimitError));
    check('the provider\'s own wait is honoured, plus a margin', rateLimitWaitMs(RATE_LIMITED, 1) === 12_400 + SUGGESTED_WAIT_MARGIN_MS);
    check('no suggestion ⇒ linear backoff, capped', rateLimitWaitMs(BARE_429, 1) === BACKOFF_STEP_MS
      && rateLimitWaitMs(BARE_429, 3) === 3 * BACKOFF_STEP_MS && rateLimitWaitMs(BARE_429, 99) === BACKOFF_MAX_MS);
  }

  console.log('\n2. bounded');
  {
    const once = harness(1);
    check('one 429 then an answer: two calls, one wait, the answer returned',
      await callWithRateLimitRetry(once.call, once.options) === 'ok' && once.calls.length === 2 && once.sleeps.length === 1
        && once.sleeps[0] === 13_900 && once.retries[0].attempt === 1 && /429/.test(once.retries[0].reason));

    const forever = harness(99);
    let threw: unknown;
    await callWithRateLimitRetry(forever.call, forever.options).catch((e) => { threw = e; });
    check(`a provider that never recovers is asked ${DEFAULT_MAX_RATE_LIMIT_RETRIES + 1} times and no more`,
      threw === RATE_LIMITED && forever.calls.length === DEFAULT_MAX_RATE_LIMIT_RETRIES + 1 && forever.sleeps.length === DEFAULT_MAX_RATE_LIMIT_RETRIES);

    const capped = harness(99);
    await callWithRateLimitRetry(capped.call, { ...capped.options, maxRetries: 2 }).catch(() => {});
    check('maxRetries bounds it further', capped.calls.length === 3);

    const zero = harness(99);
    await callWithRateLimitRetry(zero.call, { ...zero.options, maxRetries: 0 }).catch(() => {});
    check('maxRetries 0 is exactly one call', zero.calls.length === 1 && zero.sleeps.length === 0);
  }

  console.log('\n3. 429 only');
  {
    for (const [name, err] of [['a 5xx', new Error('503 upstream')], ['a timeout', new Error('Structured response did not arrive within 60000 ms.')],
      ['malformed output', new Error('Model returned a structured response that is not JSON.')]] as const) {
      const h = harness(1, err);
      let threw: unknown;
      await callWithRateLimitRetry(h.call, h.options).catch((e) => { threw = e; });
      check(`${name} fails immediately — one call, no wait`, threw === err && h.calls.length === 1 && h.sleeps.length === 0);
    }
  }

  console.log('\n4. a deadline — the caller holds a lease');
  {
    // 75 s budget, 20 s minimum attempt: a 13.9 s wait fits once… twice… and then does not.
    const h = harness(99);
    let threw: unknown;
    await callWithRateLimitRetry(h.call, { ...h.options, deadlineAt: h.start + 75_000, minAttemptMs: 20_000 }).catch((e) => { threw = e; });
    check('waits are taken only while a useful attempt still fits after them',
      threw === RATE_LIMITED && h.sleeps.length === 3 && h.calls.length === 4, `${h.sleeps.length} waits, ${h.calls.length} calls`);
    check('…so the last attempt STARTED with at least the minimum left, and nothing ran past the deadline',
      h.clock() <= h.start + 75_000 && h.clock() - 300 + 20_000 <= h.start + 75_000);

    const long = harness(99, new Error('429 rate limit — try again in 70s'));
    await callWithRateLimitRetry(long.call, { ...long.options, deadlineAt: long.start + 75_000, minAttemptMs: 20_000 }).catch(() => {});
    check('a suggested wait that cannot fit is not slept through: fail NOW, inside the lease', long.calls.length === 1 && long.sleeps.length === 0);

    const noDeadline = harness(1, new Error('429 rate limit — try again in 70s'));
    check('without a deadline the same wait is honoured (the chat turn\'s behaviour)',
      await callWithRateLimitRetry(noDeadline.call, noDeadline.options) === 'ok' && noDeadline.sleeps[0] === 71_500);
  }

  console.log('\n5. one rule, not two — the chat turn CALLS this function and keeps no copy');
  {
    const turn = readFileSync('lib/ai/conversation/turn.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    check('turn.ts imports the canonical retry', /import \{ callWithRateLimitRetry \} from '@\/lib\/ai\/rate-limit-retry';/.test(turn));
    check('…and defines none of its own', !/function callWithRateLimitRetry/.test(turn) && !/MAX_RATE_LIMIT_RETRIES/.test(turn));
    check('…nor a private predicate, wait parse or backoff', !/rate limit\|429/.test(turn) && !/try again in/.test(turn) && !/setTimeout/.test(turn));
    check('every wait is still written into the turn artifact', /onRetry: \(r\) => rec\.retries\.push\(r\)/.test(turn));
    check('the defaults are the constants the private copy used', DEFAULT_MAX_RATE_LIMIT_RETRIES === 5
      && SUGGESTED_WAIT_MARGIN_MS === 1_500 && BACKOFF_MAX_MS === 60_000 && BACKOFF_STEP_MS === 5_000);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
