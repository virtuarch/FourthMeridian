/**
 * lib/ai/conversation/conversation-identity.test.ts  (OPERATIONALIZATION P0)
 *
 * A REAL CONVERSATION IDENTITY, END TO END — and the attribution that rides
 * with it. The chat route used to group a conversation's invocations under
 * sha256(userId + opening message)[:16]: two chats that opened with the same
 * words were ONE conversation to the ledger (dev DB: 51 chat rows → 2 keys).
 * Now the route mints a random id, carries it in the sealed state, and hands
 * it — with the user and Space — to the turn loop, which puts it on the
 * ambient context every provider call reads.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/conversation/conversation-identity.test.ts
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-never-used';

import { readFileSync } from 'node:fs';
import { executeTurn } from './turn';
import { getAiInvocationContext, type AiInvocationContext } from '@/lib/ai/invocation-context';
import type { ToolContext } from './tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const strip = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main() {
  console.log('1. the route: no content-derived key, a minted identity carried in the seal');
  {
    const route = strip('app/api/ai/chat/route.ts');
    check('no sha256 / createHash conversation key remains', !/createHash|conversationKey|sha256/.test(route));
    check('the identity is the carried one or a fresh randomUUID', /const conversationId = carried\?\.conversationId \?\? randomUUID\(\);/.test(route));
    check('correlationId IS the conversation identity (grouping keeps working)', /correlationId: conversationId,/.test(route));
    check('user, Space and conversation are handed to the turn as attribution',
      /attribution: \{ userId: user\.id, spaceId: spaceCtx\.spaceId, conversationId \}/.test(route));
    check('the identity is sealed back every turn', /provenance: turn\.provenance,\s*conversationId \}/.test(route));
    check('the route never puts the identity in the response body or the transcript',
      !/conversationId/.test(route.slice(route.indexOf('const body: AiChatResponse'), route.indexOf('const res = NextResponse.json(body)'))));
  }

  console.log('\n2. the turn loop: attribution lands on the ambient context of EVERY provider call');
  {
    const seen: (AiInvocationContext | undefined)[] = [];
    const generate = (async () => {
      seen.push(getAiInvocationContext() ? { ...getAiInvocationContext()! } : undefined);
      return { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' }, usage: null, latencyMs: 1, finishReason: 'stop' };
    }) as unknown as NonNullable<Parameters<typeof executeTurn>[0]['generate']>;
    const toolCtx = { plan: { pending: { clauses: [] }, scenarioRan: false } } as unknown as ToolContext;
    await executeTurn({ messages: [], user: 'q', index: 4, model: 'gpt-5.1', toolSchemas: [], toolCtx,
      correlationId: 'conv-x', surface: 'chat',
      attribution: { userId: 'usr_1', spaceId: 'spc_1', conversationId: 'conv-x' }, generate });
    const c = seen[0];
    check('the provider call saw the context', !!c);
    check('correlationId / turnIndex / surface as before', c?.correlationId === 'conv-x' && c?.turnIndex === 4 && c?.surface === 'chat');
    check('subSurface names the answer call', c?.subSurface === 'chat:answer');
    check('userId / spaceId / conversationId attributed', c?.userId === 'usr_1' && c?.spaceId === 'spc_1' && c?.conversationId === 'conv-x');

    const seen2: (AiInvocationContext | undefined)[] = [];
    const generate2 = (async () => {
      seen2.push(getAiInvocationContext() ? { ...getAiInvocationContext()! } : undefined);
      return { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' }, usage: null, latencyMs: 1, finishReason: 'stop' };
    }) as unknown as NonNullable<Parameters<typeof executeTurn>[0]['generate']>;
    await executeTurn({ messages: [], user: 'q', index: 0, model: 'gpt-5.1', toolSchemas: [], toolCtx, generate: generate2 });
    const h = seen2[0];
    check('the harness (no attribution) stays unattributed: harness:answer, no user/Space/conversation',
      h?.surface === 'harness' && h?.subSurface === 'harness:answer' && h?.userId === undefined && h?.spaceId === undefined && h?.conversationId === undefined);
  }

  console.log('\n3. the labeller and the Brief carry the same attribution');
  {
    const engine = strip('lib/ai/conversation/engine.ts');
    check('the guidance labeller runs under <surface>:guidance with the attribution spread in',
      /subSurface: `\$\{args\.surface \?\? 'harness'\}:guidance`,\s*\.\.\.\(args\.attribution \?\? \{\}\)/.test(engine));
    check('runStatelessTurn threads attribution into executeTurn', /attribution: args\.attribution,/.test(engine));
    const brief = strip('lib/ai/brief/generate.ts');
    check('Brief generation runs under <surface>:generate with its attribution', /subSurface: `\$\{surface\}:generate`,\s*\.\.\.\(options\.attribution \?\? \{\}\)/.test(brief));
    const lifecycle = strip('lib/ai/brief/lifecycle.ts');
    check('the lifecycle hands the Brief scope (owner, Space) to generation as attribution only',
      /attribution: \{ userId: scope\.ownerUserId, spaceId: scope\.spaceId \}/.test(lifecycle) && /deps\.generate\(modelPkg, now, reason, key\)/.test(lifecycle));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}
main();
