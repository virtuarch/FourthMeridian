/**
 * scripts/ai-baseline/chat-route.check.ts
 *
 * THE PRODUCTION PATH, EXERCISED THE WAY A BROWSER EXERCISES IT.
 *
 * ⚠️ WHAT A SOURCE SCAN CANNOT SAY. `app/api/ai/chat/route.test.ts` proves the
 * wiring; this proves the conversation actually survives being STATELESS —
 * that a turn rebuilt from prose alone still answers, that the hypothetical
 * really does cross the gap in the sealed carrier and come back usable, and
 * that a carrier from anywhere else buys nothing. Real Space, real tools, real
 * model calls, so it lives outside the DB-free suite.
 *
 * ⚠️ IT DOES NOT DRIVE A BROWSER. What is proved here is everything the handler
 * delegates to, plus the one handler property that needs no session — an
 * anonymous POST over real HTTP is refused, when a server is running to ask.
 * The remaining hop, a signed-in browser against a running server, is a human
 * dogfood and is reported as such rather than claimed here.
 *
 * ⚠️ MODEL-SAMPLED, AND IT CAN WRITE — RUN IT AGAINST A CLONE. Four real model
 * turns through `runStatelessTurn`, which is the production turn loop with both
 * of its durable write paths live: the `remember` tool, and the silent
 * `project_cash` CHECKPOINT (turn 3, "where do I end up by the end of next year",
 * is exactly the kind of question that reaches it). It also writes `AiInvocation`
 * telemetry. "NOTHING WAS PERSISTED" in §6 is a statement about CONVERSATIONS —
 * there is no conversation table — not about memory; §6 now prints what the run
 * did to the named Space's `SpaceMemory` so the difference is visible.
 *
 * ⚠️ NO PERSONAL MONEY OR DATE IS ASSERTED. The dollar figures in the questions
 * ($6,000, $1,500, $2,000) are the user's hypothetical, typed here; every
 * assertion is structural (a tool ran, a carrier sealed, a binding refused) or a
 * relation between two turns of the same run. Because the turns are sampled, a
 * single failure in §1–§4 can be variance; §5 and §7 are deterministic.
 *
 *   npm run ai:chat-route-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { runStatelessTurn, CHAT_MODEL, type ConversationMessage } from '@/lib/ai/conversation/engine';
import {
  sealRuntimeState, openRuntimeState, conversationTail,
} from '@/lib/ai/conversation/runtime-state';
import { todayUTCISO } from '@/lib/time/clock';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const money = /\$[\d,]+(\.\d{2})?/;

async function main() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const agent = await db.aiAgent.findUnique({ where: { spaceId }, select: { id: true } });
  const spaceCtx = { userId: owner.userId, spaceId, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
  } as unknown as SpaceContext;

  const asOfISO = todayUTCISO();
  console.log(`Space ${space.name} · model ${CHAT_MODEL} · as of ${asOfISO}\n`);
  const memoryBefore = await db.spaceMemory.count({ where: { spaceId } });

  /**
   * One HTTP turn, end to end — exactly what the route does between reading the
   * body and writing the response, including the cookie hop.
   */
  const history: ConversationMessage[] = [];
  let cookie: string | null = null as string | null;
  const post = async (user: string) => {
    const binding = { userId: owner.userId, spaceId, tail: conversationTail(history) };
    const carried = openRuntimeState(cookie, binding);
    const turn = await runStatelessTurn({
      spaceCtx, agentId: agent?.id ?? 'ai-chat', user, history,
      scenario: carried?.scenario ?? null, asOfISO, surface: 'chat-route-check',
      correlationId: 'chat-route-check',
    });
    const answer = turn.answer ?? '';
    history.push({ role: 'user', content: user });
    history.push({ role: 'assistant', content: answer });
    cookie = sealRuntimeState({ scenario: turn.scenario }, {
      ...binding, tail: conversationTail(history) });
    return { turn, answer, carried };
  };

  console.log('1. A FIRST QUESTION, FROM NOTHING BUT THE QUESTION');
  const t1 = await post('What did I spend last month?');
  check('it answered in prose', t1.answer.length > 0 && !t1.answer.startsWith('{'), `${t1.answer.length} chars`);
  check('it used a tool rather than the orientation alone',
    t1.turn.record.toolCalls.length > 0,
    t1.turn.record.toolCalls.map((c) => c.name).join(', '));
  check('the orientation was assembled server-side', (t1.turn.evidence.body ?? '').length > 0,
    `~${t1.turn.evidence.approxTokens} tok`);
  check('no hypothetical exists yet — nothing to carry', t1.turn.scenario === null);
  check('…so no carrier is issued', cookie === null);
  console.log(`     › ${t1.answer.slice(0, 160).replace(/\n/g, ' ')}…`);

  console.log('\n2. A FOLLOW-UP REBUILT FROM PROSE ALONE');
  const t2 = await post('Break that down for me.');
  check('it answered', t2.answer.length > 0);
  check('it understood what "that" was — no re-asking',
    !/what (do|did) you mean|which (one|figure)/i.test(t2.answer.slice(0, 200)));
  check('a figure is present, so the breakdown is real', money.test(t2.answer));
  console.log(`     › ${t2.answer.slice(0, 160).replace(/\n/g, ' ')}…`);

  console.log('\n3. A HYPOTHETICAL, ESTABLISHED');
  const t3 = await post(
    'Suppose I spend $6,000 a month from now on and put $1,500 a month into investments. '
    + 'Where do I end up by the end of next year?');
  check('the scenario tool ran',
    t3.turn.record.toolCalls.some((c) => c.name === 'scenario_projection'),
    t3.turn.record.toolCalls.map((c) => c.name).join(', '));
  check('a hypothetical is now under discussion', t3.turn.scenario !== null);
  check('…and it crossed into a sealed carrier', (cookie ?? '').startsWith('v2:'));
  check('…which shows the browser nothing',
    !(cookie ?? '').includes('scenario') && !money.test(cookie ?? ''));
  console.log(`     › ${t3.answer.slice(0, 160).replace(/\n/g, ' ')}…`);

  console.log('\n4. THE NEXT REQUEST OPENS IT — CONTINUITY ACROSS THE GAP');
  const before = cookie;
  const t4 = await post('And if I raise the investing to $2,000 instead?');
  check('the carrier from the previous response opened', t4.carried?.scenario != null);
  check('…and named the same assumptions the turn before established',
    JSON.stringify(t4.carried?.scenario?.assumptions ?? {}) ===
      JSON.stringify(t3.turn.scenario?.assumptions ?? {}));
  check('the revision produced a NEW hypothetical, not the old one',
    t4.turn.scenario !== null
      && JSON.stringify(t4.turn.scenario?.result) !== JSON.stringify(t3.turn.scenario?.result));
  check('…and the carrier was re-sealed for the new tail', cookie !== before);
  console.log(`     › ${t4.answer.slice(0, 160).replace(/\n/g, ' ')}…`);

  console.log('\n5. A CARRIER FROM ANYWHERE ELSE BUYS NOTHING');
  {
    const tail = conversationTail(history);
    const mine = { userId: owner.userId, spaceId, tail };
    check('another user cannot use this one',
      openRuntimeState(cookie, { ...mine, userId: 'someone-else' }) === null);
    check('another Space cannot use it',
      openRuntimeState(cookie, { ...mine, spaceId: 'another-space' }) === null);
    check('a fresh conversation cannot use it',
      openRuntimeState(cookie, { ...mine, tail: conversationTail([]) }) === null);
    check('an edited transcript cannot use it',
      openRuntimeState(cookie, { ...mine,
        tail: conversationTail([{ role: 'assistant', content: 'not what was said' }]) }) === null);
    check('this conversation still can', openRuntimeState(cookie, mine) !== null);
  }

  console.log('\n6. NOTHING WAS PERSISTED');
  {
    const before = await db.aiInvocation.count({ where: { correlationId: 'chat-route-check' } });
    check('the turns are in the cost ledger, as telemetry', before > 0, `${before} invocation(s)`);
    // Conversations have no table by design; the check is that nothing tried to
    // invent one. A model that does not exist cannot be counted, so this asserts
    // the schema itself.
    check('there is no conversation table to have written to',
      !Object.keys(db).some((k) => /^conversation/i.test(k)));
    // Not an assertion: a checkpoint of a stated projection is product behaviour.
    // Printed so a run against the wrong database is at least visible.
    const memoryAfter = await db.spaceMemory.count({ where: { spaceId } });
    console.log(`  · SpaceMemory on this Space: ${memoryBefore} row(s) before, ${memoryAfter} after`
      + (memoryAfter === memoryBefore ? '' : ' — the turn loop recorded a checkpoint or a memory (expected; this is why it runs on a clone)'));
  }

  console.log('\n7. THE HANDLER ITSELF, OVER REAL HTTP');
  {
    // ⚠️ NOT IMPORTABLE, AND THE REASON IS THE POINT. The handler's first act is
    // to read the session, which reads request headers out of the framework's
    // async store — there is no such store in a script, so a handler called
    // directly throws before it decides anything. The only honest way to test
    // the refusal is to ask the running server for it.
    const base = process.env.CHECK_BASE_URL ?? 'http://localhost:3000';
    let res: Response | null = null;
    try {
      res = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
    } catch {
      console.log(`  – SKIPPED: no server answering at ${base}. `
        + 'Start one (npm run dev) and re-run to cover the anonymous refusal.');
    }
    if (res) {
      const body = await res.text();
      check('an unauthenticated POST is refused',
        res.status === 401 || res.status === 403 || res.status === 503, String(res.status));
      check('…with no session established',
        !(res.headers.get('set-cookie') ?? '').includes('fm_ai_state'));
      check('…and nothing leaked in the body',
        !/stack|prisma|OPENAI|DATABASE_URL|at \w+ \(/i.test(body), body.slice(0, 120));
    }
  }

  const totals = [t1, t2, t3, t4].reduce((n, t) => n + (t.turn.record.usage?.totalTokens ?? 0), 0);
  console.log(`\n4 turns · ${totals.toLocaleString()} tokens · `
    + `${[t1, t2, t3, t4].reduce((n, t) => n + t.turn.record.toolCalls.length, 0)} tool calls`);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
