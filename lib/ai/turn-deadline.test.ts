/**
 * lib/ai/turn-deadline.test.ts  (SEC-AI-003)
 *
 * THE BOUNDS NOW IN FORCE, PINNED. The SDK client's timeout and retry count,
 * the turn budget against the route's `maxDuration`, the per-hop attempt and
 * wait bounds, the deadline's clock, and the source sites that must thread the
 * signal (provider construction, route → engine → turn → guidance).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/turn-deadline.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  CHAT_ROUTE_MAX_DURATION_S, TURN_DEADLINE_SAFETY_MARGIN_MS, CHAT_TURN_BUDGET_MS,
  CHAT_RATE_LIMIT_ATTEMPTS, CHAT_RATE_LIMIT_WAIT_BUDGET_MS, CHAT_MIN_ATTEMPT_MS, GUIDANCE_MIN_REMAINING_MS,
  TurnTimeoutError, TURN_TIMEOUT_CODE, isTurnTimeoutFailure, openTurnDeadline, spentTurnDeadline,
} from './turn-deadline';
import { OPENAI_CLIENT_TIMEOUT_MS, OPENAI_CLIENT_MAX_RETRIES } from './provider';
import { classifyAiFailure } from './invocation';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const src = (p: string) => readFileSync(p, 'utf8');
const strip = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main() {
  console.log('1. the bounds');
  {
    check('SDK client: 90 s per request, ZERO hidden retries', OPENAI_CLIENT_TIMEOUT_MS === 90_000 && OPENAI_CLIENT_MAX_RETRIES === 0);
    check('the turn budget is the route maxDuration (300 s) minus a 30 s safety margin = 270 s',
      CHAT_ROUTE_MAX_DURATION_S === 300 && TURN_DEADLINE_SAFETY_MARGIN_MS === 30_000 && CHAT_TURN_BUDGET_MS === 270_000);
    check('a hop may ask the provider at most 3 times (1 call + 2 retries), sleeping at most 60 s in all',
      CHAT_RATE_LIMIT_ATTEMPTS === 3 && CHAT_RATE_LIMIT_WAIT_BUDGET_MS === 60_000);
    check('a retry is not taken unless 5 s of budget is left for it; the label is skipped under 5 s',
      CHAT_MIN_ATTEMPT_MS === 5_000 && GUIDANCE_MIN_REMAINING_MS === 5_000);
    check('the SDK timeout can never outlive the turn budget on its own', OPENAI_CLIENT_TIMEOUT_MS < CHAT_TURN_BUDGET_MS);
    check('worst case per hop (3 × 90 s + 60 s asleep) is bounded by the deadline, not by arithmetic',
      CHAT_RATE_LIMIT_ATTEMPTS * OPENAI_CLIENT_TIMEOUT_MS + CHAT_RATE_LIMIT_WAIT_BUDGET_MS > CHAT_TURN_BUDGET_MS);
  }

  console.log('\n2. the deadline object');
  {
    let t = 1_000;
    let fired: (() => void) | null = null;
    let cleared = 0;
    const d = openTurnDeadline({ budgetMs: 5_000, now: () => t, setTimer: (fn) => { fired = fn; return 'h'; }, clearTimer: () => { cleared++; } });
    check('deadlineAt = now + budget; remaining counts down and never goes negative',
      d.deadlineAt === 6_000 && d.remainingMs() === 5_000 && (t = 4_000, d.remainingMs() === 2_000) && (t = 9_000, d.remainingMs() === 0));
    check('not aborted before the timer fires', !d.signal.aborted);
    (fired as unknown as () => void)();
    check('the timer aborts the signal with the turn-deadline error as its reason',
      d.signal.aborted && d.signal.reason instanceof TurnTimeoutError && d.signal.reason.code === TURN_TIMEOUT_CODE);
    d.dispose(); d.dispose();
    check('dispose releases the timer once, and is idempotent', cleared === 1);

    let cleared2 = 0;
    const e = openTurnDeadline({ budgetMs: 5_000, now: () => 0, setTimer: () => 'h', clearTimer: () => { cleared2++; } });
    e.abort(); e.abort();
    check('abort() cancels now (reason: cancelled), releases the timer, idempotent',
      e.signal.aborted && e.signal.reason instanceof TurnTimeoutError && /cancelled/.test(e.signal.reason.message) && cleared2 === 1);
    check('a spent deadline is aborted from birth', spentTurnDeadline().signal.aborted);

    const real = openTurnDeadline({ budgetMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
    check('with the real timer the signal fires at the budget', real.signal.aborted);
    real.dispose();
    const none = openTurnDeadline({ budgetMs: 60_000 });
    none.dispose();
    check('…and a disposed deadline does not keep the process alive (nothing to assert; the test exiting is the proof)', true);
  }

  console.log('\n3. the error is a TIMEOUT fact with its own code');
  {
    const err = new TurnTimeoutError(270_000, 'before hop 2');
    const c = classifyAiFailure(err);
    check('classified TIMEOUT / turn_deadline', c.outcome === 'TIMEOUT' && c.errorCode === TURN_TIMEOUT_CODE, JSON.stringify(c));
    check('the route can recognise it from the recorded turn error', isTurnTimeoutFailure(err.message) && !isTurnTimeoutFailure('no final answer after 6 tool round trips') && !isTurnTimeoutFailure(null));
  }

  console.log('\n4. source: the signal is threaded, the client is pinned, the route literal matches');
  {
    const provider = strip('lib/ai/provider.ts');
    check('the ONE OpenAI construction carries the pinned timeout and maxRetries',
      (provider.match(/new OpenAI\(\{/g) ?? []).length === 1
        && /new OpenAI\(\{[\s\S]*?timeout: OPENAI_CLIENT_TIMEOUT_MS,[\s\S]*?maxRetries: OPENAI_CLIENT_MAX_RETRIES,[\s\S]*?\}\)/.test(provider));
    check('the tool call passes the signal to the SDK', /create\(body, signal \? \{ signal \} : undefined\)/.test(provider));
    check('the structured call aborts on the caller\'s signal too', /outer\?\.addEventListener\('abort', onOuterAbort/.test(provider));

    const route = src('app/api/ai/chat/route.ts');
    const literal = Number(/export const maxDuration\s*=\s*(\d+)/.exec(route)?.[1]);
    check('route maxDuration literal === CHAT_ROUTE_MAX_DURATION_S', literal === CHAT_ROUTE_MAX_DURATION_S, String(literal));
    check('the route opens the deadline from the turn budget less what its gates spent, after the allowance',
      /openTurnDeadline\(\{ budgetMs: CHAT_TURN_BUDGET_MS - \(Date\.now\(\) - arrivedAt\) \}\)/.test(route)
        && route.indexOf('openTurnDeadline(') > route.indexOf('allowanceRefusal(allowance'));
    check('…hands it to the turn and disposes it in the finally beside the release',
      /memoryWrites: true,\s*deadline,/.test(route) && /finally \{[\s\S]*?deadline\.dispose\(\);\s*await allowance\.release\(\);/.test(route));
    check('…and answers a deadline with its own sentence and a 504', /isTurnTimeoutFailure\(turn\.record\.error\)[\s\S]{0,200}refuse\(SAY\.timedOut, 504\)/.test(route));

    const engine = strip('lib/ai/conversation/engine.ts');
    check('the engine threads the deadline into the turn and the guidance call',
      /deadline: args\.deadline,/.test(engine) && /defaultGuidanceCall\(model, args\.deadline\)/.test(engine)
        && /signal: deadline\.signal/.test(engine) && /GUIDANCE_MIN_REMAINING_MS/.test(engine));

    const turn = strip('lib/ai/conversation/turn.ts');
    check('the turn loop checks the deadline before every hop and bounds the retry in count, wait and deadline',
      /if \(deadline\?\.signal\.aborted\)/.test(turn) && /maxRetries: CHAT_RATE_LIMIT_ATTEMPTS - 1, maxTotalWaitMs: CHAT_RATE_LIMIT_WAIT_BUDGET_MS/.test(turn)
        && /deadlineAt: deadline\.deadlineAt, minAttemptMs: CHAT_MIN_ATTEMPT_MS, signal: deadline\.signal/.test(turn));
    check('…and every provider call carries the signal', (turn.match(/signal: deadline\?\.signal/g) ?? []).length === 2);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
