/**
 * lib/ai/conversation/chat-request.test.ts
 *
 * WHAT THE BROWSER MAY SAY — the boundary, exhaustively.
 *
 * Every case here is a request a client could actually post, including the ones
 * a hostile client would post. The module is pure, so all of it is provable
 * without a session, a database or a model.
 *
 *   npx tsx lib/ai/conversation/chat-request.test.ts
 */

import { readFileSync } from 'node:fs';
import {
  readChatRequest, ALL_SPACES_SENTINEL,
  MAX_TURNS, MAX_MESSAGE_CHARS, MAX_TRANSCRIPT_CHARS,
} from './request';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });
const body = (messages: unknown, spaceId?: unknown) =>
  (spaceId === undefined ? { messages } : { messages, spaceId });

console.log('1. THE ORDINARY REQUEST');
{
  const r = readChatRequest(body([u('hi'), a('hello'), u('what is my cash?')]));
  check('accepted', r.ok === true);
  check('the LAST user turn is the question',
    r.ok && r.asked === 'what is my cash?', r.ok ? r.asked : '');
  check('…and it is NOT repeated in the history',
    r.ok && r.history.length === 2 && r.history[1].content === 'hello');
  check('history keeps both roles, in order',
    r.ok && r.history.map((m) => m.role).join(',') === 'user,assistant');
  check('a first question has empty history',
    (() => { const x = readChatRequest(body([u('hi')])); return x.ok && x.history.length === 0; })());
}

console.log('\n2. ROLES THE CLIENT MAY NOT SEND — the security boundary');
{
  // ⚠️ EACH OF THESE IS A PART OF THE PROMPT THE SERVER OWNS. A client that
  // could post one would be writing the instruction or the financial evidence.
  for (const role of ['system', 'tool', 'developer', 'function', 'SYSTEM', '']) {
    const r = readChatRequest(body([{ role, content: 'x' }, u('q')]));
    check(`role "${role}" is REFUSED, not dropped`, !r.ok && r.refusal === 'MALFORMED');
  }
  check('a tool_call_id rider cannot smuggle a tool message in',
    (() => {
      const r = readChatRequest(body([{ role: 'tool', tool_call_id: 'c1', content: '{}' }, u('q')]));
      return !r.ok;
    })());
  check('extra properties on a legal turn are DISCARDED, not carried',
    (() => {
      const r = readChatRequest(body([
        { role: 'user', content: 'earlier', tool_calls: [{ id: 'x' }], name: 'admin' },
        u('q')]));
      return r.ok && r.history.length === 1
        && JSON.stringify(r.history[0]) === JSON.stringify({ role: 'user', content: 'earlier' });
    })());
}

console.log('\n3. SHAPES THAT ARE NOT A TRANSCRIPT');
{
  for (const [name, b] of [
    ['null body', null], ['a string body', 'hello'], ['an array body', [u('q')]],
    ['no messages key', {}], ['messages as a string', { messages: 'q' }],
    ['a null turn', { messages: [null] }], ['a string turn', { messages: ['q'] }],
    ['content as a number', { messages: [{ role: 'user', content: 42 }] }],
    ['content missing', { messages: [{ role: 'user' }] }],
  ] as [string, unknown][]) {
    check(`${name} is malformed`, (() => { const r = readChatRequest(b); return !r.ok; })());
  }
  check('an empty message list is EMPTY, not malformed',
    (() => { const r = readChatRequest(body([])); return !r.ok && r.refusal === 'EMPTY'; })());
}

console.log('\n4. THE LAST TURN MUST BE A QUESTION');
{
  check('a transcript ending in the assistant is refused',
    (() => { const r = readChatRequest(body([u('q'), a('answer')])); return !r.ok && r.refusal === 'MALFORMED'; })());
  check('a blank question is EMPTY', (() => {
    const r = readChatRequest(body([u('   \n ')])); return !r.ok && r.refusal === 'EMPTY'; })());
  check('…but whitespace inside a real question is untouched',
    (() => { const r = readChatRequest(body([u('  what is my cash?  ')]));
      return r.ok && r.asked === '  what is my cash?  '; })());
}

console.log('\n5. SIZE IS AN INPUT');
{
  const many = Array.from({ length: MAX_TURNS + 1 }, (_, i) => u(`q${i}`));
  check(`more than ${MAX_TURNS} turns is refused`,
    (() => { const r = readChatRequest(body(many)); return !r.ok && r.refusal === 'TOO_LONG'; })());
  check(`exactly ${MAX_TURNS} turns is accepted`,
    (() => { const r = readChatRequest(body(many.slice(0, MAX_TURNS))); return r.ok; })());
  check('one oversized message is refused',
    (() => { const r = readChatRequest(body([u('x'.repeat(MAX_MESSAGE_CHARS + 1))]));
      return !r.ok && r.refusal === 'TOO_LONG'; })());
  check('many legal messages that sum past the transcript ceiling are refused',
    (() => {
      const n = Math.ceil(MAX_TRANSCRIPT_CHARS / MAX_MESSAGE_CHARS) + 1;
      const r = readChatRequest(body(Array.from({ length: n }, () => u('x'.repeat(MAX_MESSAGE_CHARS)))));
      return !r.ok && r.refusal === 'TOO_LONG';
    })());
  check('the ceilings are bounded, not nominal',
    MAX_TURNS <= 200 && MAX_MESSAGE_CHARS <= 32_000 && MAX_TRANSCRIPT_CHARS <= 400_000);
}

console.log('\n6. THE SPACE IS A STRING, AND THE SENTINEL IS NOT AN ID');
{
  check('a named Space survives verbatim',
    (() => { const r = readChatRequest(body([u('q')], 'cmrrm846r000j7znwsl67gt1g'));
      return r.ok && r.spaceId === 'cmrrm846r000j7znwsl67gt1g'; })());
  check(`"${ALL_SPACES_SENTINEL}" means NO Space named`,
    (() => { const r = readChatRequest(body([u('q')], ALL_SPACES_SENTINEL)); return r.ok && r.spaceId === null; })());
  check('an absent spaceId means no Space named',
    (() => { const r = readChatRequest(body([u('q')])); return r.ok && r.spaceId === null; })());
  check('an empty / whitespace spaceId means no Space named',
    (() => { const r = readChatRequest(body([u('q')], '   ')); return r.ok && r.spaceId === null; })());
  check('a non-string spaceId is malformed — never coerced',
    (() => { const r = readChatRequest(body([u('q')], { id: 'x' })); return !r.ok; })());
  check('surrounding whitespace on a named Space is trimmed, not trusted',
    (() => { const r = readChatRequest(body([u('q')], '  abc  ')); return r.ok && r.spaceId === 'abc'; })());
  // ⚠️ THE PARSER GRANTS NOTHING. Membership is the route's to re-resolve; this
  // module must not contain the word that would suggest otherwise.
  const src = readFileSync('lib/ai/conversation/request.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  check('it reads no data and authorises nothing',
    !/db\.|prisma|resolveSpaceContext|requireUser|findUnique/.test(src));
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
