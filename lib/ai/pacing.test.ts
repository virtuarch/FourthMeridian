/**
 * lib/ai/pacing.test.ts  (SEC-AI-004)
 *
 * THE AI PACING WINDOWS FAIL CLOSED. The verdict → response mapping, the wrapper
 * over an injected strict judge, and source pins that both AI routes use it and
 * neither calls the fail-open `limitByUser` any more.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/pacing.test.ts
 */

import { readFileSync } from 'node:fs';
import { paceAiRequest, pacingResponse, PACING_UNAVAILABLE_CODE, PACING_RETRY_AFTER_SECONDS } from './pacing';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const strip = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main() {
  console.log('1. the verdict → response mapping');
  {
    check('ok ⇒ proceed (null)', pacingResponse({ status: 'ok' }, 'Conversations') === null);
    const limited = pacingResponse({ status: 'limited', retryAfterSec: 42 }, 'Conversations')!;
    check('limited ⇒ 429 with Retry-After (the limiter\'s own shape)', limited.status === 429 && limited.headers.get('Retry-After') === '42' && limited.headers.get('Cache-Control') === 'no-store');
    const down = pacingResponse({ status: 'unavailable' }, 'Conversations')!;
    const body = await down.json() as Record<string, unknown>;
    check('unavailable ⇒ 503, retryable, Retry-After, a sentence that says nothing was changed',
      down.status === 503 && down.headers.get('Retry-After') === String(PACING_RETRY_AFTER_SECONDS) && body.code === PACING_UNAVAILABLE_CODE
        && body.retryable === true && /Nothing was changed/.test(String(body.error)) && /Conversations/.test(String(body.error)));
  }

  console.log('\n2. the wrapper over the strict judge');
  {
    const seen: { key: string; name: string; limit: number }[] = [];
    const judge = (status: 'ok' | 'limited' | 'unavailable') => async (key: string, name: string, cfg: { limit: number }) => {
      seen.push({ key, name, limit: cfg.limit });
      return status === 'ok' ? { status } : status === 'limited' ? { status, retryAfterSec: 7 } : { status };
    };
    check('ok ⇒ null, keyed on the user id and the window name', await paceAiRequest('usr_1', 'ai-chat-hour', { limit: 60, windowSec: 3600 }, 'Conversations', judge('ok')) === null
      && seen[0].key === 'usr_1' && seen[0].name === 'ai-chat-hour' && seen[0].limit === 60);
    check('limited ⇒ 429', (await paceAiRequest('usr_1', 'ai-chat', { limit: 10, windowSec: 60 }, 'Conversations', judge('limited')))?.status === 429);
    check('store unavailable ⇒ 503 (FAIL CLOSED), never null', (await paceAiRequest('usr_1', 'ai-chat', { limit: 10, windowSec: 60 }, 'Conversations', judge('unavailable')))?.status === 503);
  }

  console.log('\n3. source: both AI routes pace through it; the fail-open limiter is gone from them');
  {
    const chat = strip('app/api/ai/chat/route.ts');
    const brief = strip('app/api/brief/generate/route.ts');
    check('chat: minute and hour windows through paceAiRequest, before the kill switch and the allowance',
      (chat.match(/paceAiRequest\(user\.id, 'ai-chat(?:-hour)?'/g) ?? []).length === 2 && !/limitByUser/.test(chat)
        && chat.indexOf("'ai-chat-hour'") < chat.indexOf('readPaidRequestsAdmission()'));
    check('brief: the 20/min window through paceAiRequest, before the kill switch',
      /paceAiRequest\(user\.id, 'ai-brief-generate', \{ limit: 20, windowSec: 60 \}/.test(brief) && !/limitByUser/.test(brief)
        && brief.indexOf("'ai-brief-generate'") < brief.indexOf('readPaidRequestsAdmission()'));
    const pacing = strip('lib/ai/pacing.ts');
    check('the wrapper uses the limiter\'s public strict variant, not a private key format', /checkKeyLimitStrict/.test(pacing) && !/`user:\$\{/.test(pacing));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
