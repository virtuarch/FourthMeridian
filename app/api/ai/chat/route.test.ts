/**
 * app/api/ai/chat/route.test.ts
 *
 * THE TRUST BOUNDARY OF THE PRODUCTION CHAT ROUTE.
 *
 * ⚠️ A SOURCE SCAN, AND DELIBERATELY SO. What this route decides — who is
 * asking, which Space they may ask about, what of their message may re-enter
 * the prompt, what may leave in a response — is decided by which authority is
 * called and which is not. The pure halves are proved directly next door
 * (lib/ai/conversation/chat-request.test.ts, runtime-state.test.ts); the live
 * half needs a session, a database and a model, and is exercised by
 * `npm run ai:chat-route-check`. What is left is the wiring, and wiring is what
 * a scan is actually good at.
 *
 *   npx tsx app/api/ai/chat/route.test.ts
 */

import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const raw = readFileSync('app/api/ai/chat/route.ts', 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

console.log('1. THE ROUTE ANSWERS AGAIN');
{
  check('the redesign refusal is gone', !/AWAITING_REDESIGN/.test(src));
  check('it runs the shared conversation engine',
    /runStatelessTurn\(/.test(src)
      && /from '@\/lib\/ai\/conversation\/engine'/.test(src));
  check('…and holds no turn loop of its own — one implementation, two clients',
    !/generateWithTools|tool_call_id|findTool\(/.test(src));
  check('…and no prompt of its own', !/SYSTEM_INSTRUCTION\s*=|You are Fourth Meridian/.test(src));
  check('the node runtime is declared — the tools need it',
    /runtime\s*=\s*'nodejs'/.test(src));
  check('a tool loop is given room to finish', /maxDuration\s*=\s*\d{2,}/.test(src));
}

console.log('\n2. AUTHENTICATION AND RATE LIMIT COME FIRST');
{
  const posted = src.slice(src.indexOf('export async function POST'));
  check('requireUser is the first thing the handler does',
    posted.indexOf('requireUser()') < posted.indexOf('req.json()'));
  check('…and its error is returned, not inspected', /if \(authErr\) return authErr/.test(posted));
  check('the rate limit is applied before any model work',
    posted.indexOf('limitByUser') < posted.indexOf('runStatelessTurn'));
  check('…and before the body is even read',
    posted.indexOf('limitByUser') < posted.indexOf('req.json()'));
}

console.log('\n3. THE SPACE IS RE-RESOLVED, NEVER ACCEPTED');
{
  check('membership is resolved server-side', /resolveSpaceContext\(user\.id,/.test(src));
  check('…from the user id the SESSION produced, not the body',
    !/resolveSpaceContext\((?!user\.id)/.test(src));
  // ⚠️ THE RESOLVER FALLS BACK BY DESIGN. Answering about a different Space than
  // the one named would put this user's figures under someone else's label.
  check('a named Space that does not come back as itself is a 403',
    /spaceCtx\.spaceId !== parsed\.spaceId/.test(src) && /403/.test(src));
  check('the sentinel is the only value allowed to fall back',
    /parsed\.spaceId !== null/.test(src)
      && !/ALL_SPACES_SENTINEL/.test(src));   // the sentinel is resolved in the parser
  check('the spaceId from the body is never used for a read',
    !/body\.spaceId|body\?\.spaceId/.test(src));
}

console.log('\n4. THE SERVER OWNS THE PROMPT');
{
  check('the transcript is narrowed by the shared reader, not inline',
    /readChatRequest\(body\)/.test(src));
  check('the route builds no message itself',
    !/role:\s*'system'/.test(src) && !/role:\s*'tool'/.test(src)
      && !/messages:\s*\[/.test(src));
  check('the as-of day comes from the clock, not the request',
    /asOfISO: todayUTCISO\(\)/.test(src));
  check('the model is the engine\'s, not the caller\'s',
    !/model:/.test(src) && !/gpt-/.test(src));
  check('the agent id is read from the Space that was authorised',
    /aiAgent\.findUnique\(\{\s*\n?\s*where: \{ spaceId: spaceCtx\.spaceId \}/.test(src));
  check('no owner id is ever taken from the browser', !/ownerUserId/.test(raw));
  check('memory scope and evidence are not assembled here',
    !/buildEvidence|assembleFullContext|memoryLine|rememberMemory/.test(src));
}

console.log('\n5. WHAT LEAVES THE SERVER');
{
  // ⚠️ THE ANSWER AND WHAT IT COULD NOT ESTABLISH — and nothing else. The body is
  // declared as the shared public type, so a field that is not in the contract
  // cannot be added here without changing the contract on purpose.
  check('the success body is typed by the shared contract',
    /const body: AiChatResponse = \{/.test(src)
      && /from '@\/types'/.test(src));
  check('…it is the answer, plus gaps only when there are gaps',
    /message: turn\.answer,/.test(src)
      && /turn\.knowledgeGaps\.length \? \{ knowledgeGaps: turn\.knowledgeGaps \}/.test(src));
  check('…and a knowledge gap is a 200, never a status of its own',
    !/knowledgeGap[\s\S]{0,120}(refuse\(|status: [45])/.test(src));
  check('no evidence, tool result, record or usage is returned',
    !/turn\.record[^.]/.test(src.replace(/turn\.record\.error/g, ''))
      && !/evidence:|toolCalls:|usage:/.test(src));
  check('the gaps are forwarded, not re-derived here',
    /turn\.knowledgeGaps/.test(src) && !/missingDebtFields|collectKnowledgeGaps/.test(src));
  check('an error response carries a sentence, never the error',
    !/error: err|err\.message|String\(err\)|\.stack/.test(src));
  check('…and the error itself is logged server-side', /console\.error\(/.test(src));
  check('every refusal is one of the stated sentences',
    (src.match(/refuse\(/g) ?? []).length === (src.match(/refuse\(SAY\.|refuse\(say,/g) ?? []).length);
  check('the failure sentence states nothing was changed',
    /Nothing was changed/.test(raw));
}

console.log('\n6. CONTINUITY WITHOUT PERSISTENCE');
{
  check('nothing about the conversation is written',
    !/db\.[\w.]*\.(create|createMany|update|updateMany|upsert|delete)/.test(src)
      && !/aiAdvice|Conversation/.test(src));
  check('the only database read is the Space\'s agent id',
    (src.match(/db\./g) ?? []).length === 1 && /db\.aiAgent\.findUnique/.test(src));
  check('the scenario crosses the gap sealed, not in the response body',
    /openRuntimeState\(/.test(src) && /sealRuntimeState\(/.test(src)
      && !/scenario: turn\.scenario[\s\S]{0,40}NextResponse/.test(src));
  check('the seal is opened against THIS user, Space and conversation',
    /userId: user\.id, spaceId: spaceCtx\.spaceId,[\s\S]{0,60}conversationTail\(history\)/.test(src));
  check('the carrier is httpOnly — the page cannot read it', /httpOnly: true/.test(src));
  check('…secure in production', /secure: process\.env\.NODE_ENV === 'production'/.test(src));
  check('…scoped to this endpoint', /path: '\/api\/ai\/chat'/.test(src));
  check('…and bounded in time', /maxAge: sealed \?/.test(src));
  check('no hypothetical ⇒ the carrier is CLEARED, not left stale',
    /maxAge: sealed \? [^:]+ : 0/.test(src));
  check('there is no server-side conversation store',
    !/new Map|new Set|globalThis|let sessions/.test(src));
}

console.log('\n7. THE CLIENT CONTRACT IS UNCHANGED');
{
  const client = readFileSync('components/dashboard/AnalyzeClient.tsx', 'utf8');
  check('the client still posts {spaceId, messages}',
    /spaceId: selectedSpaceId/.test(client) && /messages: nextMessages\.map/.test(client));
  check('…and still reads {message} on success', /data\.message/.test(client));
  check('…and renders `error` from a refusal as the assistant\'s turn',
    /data\.error \?\?/.test(client));
  check('the client sends only role and content',
    /\(\{ role: m\.role, content: m\.content \}\)/.test(client));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
