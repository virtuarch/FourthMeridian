/**
 * POST /api/ai/chat
 *
 * THE CONVERSATION, IN PRODUCTION. The runtime measured under arm A2 — thin
 * orientation, coverage envelope, memory line, the sixteen tools, the
 * active-scenario envelope, Clip 6 — answering a real user through a real
 * session, on the model every gate was run on.
 *
 * ── What this route owns, and it is the only thing it owns ──────────────────
 * TRUST. Who is asking (`requireUser`), how often they may ask (`limitByUser`),
 * which Space they are entitled to (`resolveSpaceContext`, re-derived here and
 * never taken on the client's word), what of their transcript may re-enter the
 * model (user and assistant prose, nothing else), and what may leave (one
 * sentence). Everything about the conversation itself belongs to
 * lib/ai/conversation — the same code the harness runs.
 *
 * ── What the browser may and may not say ────────────────────────────────────
 * MAY: a Space id, and a list of user/assistant turns. Both are checked, and
 * the Space id is checked hard: a caller who names a Space they cannot reach
 * gets 403, not a quiet fallback to their own money under someone else's label.
 * MAY NOT: a system message, a tool message, a tool result, an owner id, an
 * as-of date, a model, an agent id, the memory line, the evidence, the active
 * scenario, or a knowledge gap. Every one of those is built here from
 * authorities; a gap posted by a client is stripped with every other unknown
 * property and is never read back as context.
 *
 * ── Continuity without persistence ──────────────────────────────────────────
 * Nothing about a conversation is stored. The hypothetical under discussion
 * crosses the gap in a sealed cookie the browser cannot read or alter
 * (lib/ai/conversation/runtime-state.ts); everything else is rebuilt from the
 * ledger on every turn. A conversation that ends is gone.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash }                from 'crypto';
import { requireUser }               from '@/lib/session';
import { limitByUser }               from '@/lib/rate-limit';
import { resolveSpaceContext }       from '@/lib/space';
import { db }                        from '@/lib/db';
import { todayUTCISO }               from '@/lib/time/clock';
import '@/lib/ai/assemblers';
import { runStatelessTurn } from '@/lib/ai/conversation/engine';
import { readChatRequest, type ChatRequestRefusal } from '@/lib/ai/conversation/request';
import type { AiChatResponse } from '@/types';
import {
  sealRuntimeStateWithReport, openRuntimeState, conversationTail, RUNTIME_STATE_TTL_MS,
} from '@/lib/ai/conversation/runtime-state';

export const preferredRegion = 'sin1';
export const runtime         = 'nodejs';
/** A tool loop is several model calls; the dogfood's slowest turn ran ~70s. */
export const maxDuration     = 300;

/** The sealed continuity carrier. HttpOnly: the page has no business reading it. */
const STATE_COOKIE = 'fm_ai_state';

/** Sentences the user sees. Plain, specific, and never a stack trace. */
const SAY = {
  malformed: 'That request didn’t arrive in a form I could read. Try asking again.',
  empty:     'I didn’t catch a question there — what would you like to know?',
  tooLong:   'This conversation has grown longer than I can carry in one piece. '
    + 'Start a new one and I’ll pick the thread back up.',
  forbidden: 'You don’t have access to that Space.',
  failed:    'Something went wrong while I was working on that. Nothing was changed. '
    + 'Please try again.',
  silent:    'I wasn’t able to put an answer together for that one. Try rephrasing it, '
    + 'or ask me something narrower.',
} as const;

const refuse = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

/** What each refusal says and answers with. One place, so no path invents a status. */
const REFUSAL: Record<ChatRequestRefusal, { say: string; status: number }> = {
  MALFORMED: { say: SAY.malformed, status: 400 },
  EMPTY:     { say: SAY.empty,     status: 400 },
  TOO_LONG:  { say: SAY.tooLong,   status: 413 },
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  if (user.role !== 'SYSTEM_ADMIN') {
    const limited = await limitByUser(user.id, 'ai-chat', { limit: 30, windowSec: 60 });
    if (limited) return limited;
  }

  // ── The request ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse(SAY.malformed, 400);
  }

  const parsed = readChatRequest(body);
  if (!parsed.ok) {
    const { say, status } = REFUSAL[parsed.refusal];
    return refuse(say, status);
  }
  const { asked, history } = parsed;

  // ── The Space ──────────────────────────────────────────────────────────────
  // ⚠️ RE-RESOLVED, NEVER ACCEPTED. `resolveSpaceContext` falls back to the
  // user's own Space when the requested one is unreachable, which is right for
  // a stale cookie and WRONG here: answering about a different Space than the
  // one the user picked would attribute their own figures to someone else's
  // name. So a named Space that does not come back as itself is a refusal, and
  // only the selector's "all my Spaces" sentinel is allowed to fall back.
  let spaceCtx;
  try {
    spaceCtx = await resolveSpaceContext(user.id, parsed.spaceId);
  } catch {
    return refuse(SAY.failed, 503);
  }
  if (parsed.spaceId !== null && spaceCtx.spaceId !== parsed.spaceId) {
    return refuse(SAY.forbidden, 403);
  }

  // ── The turn ───────────────────────────────────────────────────────────────
  try {
    const agent = await db.aiAgent.findUnique({
      where: { spaceId: spaceCtx.spaceId }, select: { id: true } });

    // ⚠️ THE SEAL IS OPENED AGAINST THIS REQUEST, NOT MERELY DECRYPTED. User,
    // Space and the tail of the transcript that was actually posted all have to
    // match the seal, so a cookie from another Space or another conversation is
    // simply absent state.
    const binding = { userId: user.id, spaceId: spaceCtx.spaceId,
      tail: conversationTail(history) };
    const carried = openRuntimeState(req.cookies.get(STATE_COOKIE)?.value, binding);

    const turn = await runStatelessTurn({
      spaceCtx,
      agentId: agent?.id ?? 'ai-chat',
      user: asked,
      history,
      scenario: carried?.scenario ?? null,
      // What was stated earlier in THIS conversation and has not run. Bound by the
      // same seal, so a new chat, another Space or another user carries none.
      pending: carried?.pending ?? null,
      // FM-AUDIT-018 — a plan the previous turn could not carry; this turn is told.
      continuity: carried?.continuity ?? null,
      asOfISO: todayUTCISO(),
      correlationId: conversationKey(user.id, history[0]?.content ?? asked),
      surface: 'chat',
    });

    if (!turn.answer) {
      // The turn record holds why (budget exhausted, finish_reason, round-trip
      // ceiling). That reason is for the server's log; the user gets a sentence.
      console.error('[ai/chat] turn produced no text:', turn.record.error);
      return refuse(SAY.silent, 502);
    }

    // ⚠️ BOTH HALVES OF THE ANSWER, ON A 200. A knowledge gap is not an error
    // and must never become one: the prose renders normally and the missing
    // evidence renders beside it. The key is omitted entirely when there is
    // none, so an ordinary answer is the same single-field body it was.
    // ⚠️ RE-SEALED EVERY TURN, AGAINST THE ANSWER JUST GIVEN. The next request's
    // transcript will end with this reply, so this reply's digest is the tail
    // the seal must be bound to. When the hypothetical is gone — cleared by a
    // failed recomputation, or never established — the carrier is cleared too,
    // rather than left holding a scenario the conversation has moved past.
    // FM-AUDIT-018 — state too large to carry is replaced by a sealed continuity
    // marker (never silently dropped), and the response SAYS so.
    const seal = sealRuntimeStateWithReport(
      { scenario: turn.scenario, pending: turn.pending, continuity: turn.continuity }, {
      ...binding, tail: conversationTail([...history, { role: 'assistant', content: turn.answer }]),
    });
    const sealed = seal.sealed;
    const body: AiChatResponse = {
      message: turn.answer,
      ...(turn.knowledgeGaps.length ? { knowledgeGaps: turn.knowledgeGaps } : {}),
      ...(seal.carried === 'LOST' && seal.fresh && seal.loss ? { continuity: { carried: false, reason: seal.loss.reason,
        droppedScenario: seal.loss.droppedScenario, droppedPendingClauses: seal.loss.droppedPendingClauses } } : {}),
    };
    const res = NextResponse.json(body);
    res.cookies.set(STATE_COOKIE, sealed ?? '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/ai/chat',
      maxAge: sealed ? Math.floor(RUNTIME_STATE_TTL_MS / 1000) : 0,
    });
    return res;
  } catch (err) {
    // ⚠️ THE DETAIL STAYS ON THIS SIDE. A provider error carries model names and
    // sometimes prompt fragments; a Prisma error carries SQL. The user gets a
    // sentence and the truth that nothing was changed — this route writes no
    // financial data on any path.
    console.error('[ai/chat] turn failed:', err);
    return refuse(SAY.failed, 503);
  }
}

/**
 * An opaque, stable grouping key for one conversation's invocations.
 *
 * ⚠️ TELEMETRY ONLY, AND DERIVED — NOT STORED, NOT A CONVERSATION ROW, AND NOT
 * RESOLVABLE TO A PERSON. A conversation is identified by the question that
 * started it, so every turn of it groups together and a new conversation gets a
 * new key; the digest is what goes in the ledger, never the question.
 */
function conversationKey(userId: string, opening: string): string {
  return `chat:${createHash('sha256').update(`${userId}:${opening}`).digest('hex').slice(0, 16)}`;
}
