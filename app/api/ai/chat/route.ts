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
 *
 * ── Telemetry identity (OPERATIONALIZATION P0, 2026-10-07) ──────────────────
 * The same sealed carrier holds a random `conversationId`, minted on the first
 * turn, so the AI cost ledger (AiInvocation) can group a conversation's
 * invocations under a key two conversations never share. It replaced a digest
 * of (userId + opening message), which gave every chat that opened with the
 * same words the same key. Together with the signed-in user id and the Space
 * id it is operator-only attribution (owner ruling 2026-10-07): written by
 * fm_system, never read by the model, never a Conversations tool input.
 */

import { NextRequest, NextResponse } from 'next/server';
import { CHAT_REFUSAL_SAY } from '@/lib/ai/conversation/refusal-sentences';
import { randomUUID }                from 'crypto';
import { requireUser }               from '@/lib/session';
import { paceAiRequest }             from '@/lib/ai/pacing';
import { entitlementsForUser, refuseIfDisabled, countLimit } from '@/lib/entitlements/consume';
import { dailyAiAllowanceFor, allowanceRefusal } from '@/lib/ai/allowance';
import { readPaidRequestsAdmission, paidRequestsPausedResponse } from '@/lib/platform/ai/paid-requests-admission';
import { UnpricedModelError, AiPausedError, isUnpricedModelFailure, isAiPausedFailure } from '@/lib/ai/provider';
import { openTurnDeadline, isTurnTimeoutFailure, CHAT_TURN_BUDGET_MS } from '@/lib/ai/turn-deadline';
import { resolveSpaceContext }       from '@/lib/space';
import { db }                        from '@/lib/db';
import { aiPhaseRunner }             from '@/lib/ai/tenant-phase';
import { applyPossessiveConvention } from '@/lib/format';
import { todayUTCISO }               from '@/lib/time/clock';
import '@/lib/ai/assemblers';
import { runStatelessTurn } from '@/lib/ai/conversation/engine';
import { readChatRequest, type ChatRequestRefusal } from '@/lib/ai/conversation/request';
import { withTenantDb }              from '@/lib/db/tenant-context';
import { recordAiTurnFailed, type AiTurnFailureReason } from '@/lib/analytics/product-events';
import type { AiChatResponse } from '@/types';
import {
  sealRuntimeStateWithReport, openRuntimeState, conversationTail, RUNTIME_STATE_TTL_MS,
} from '@/lib/ai/conversation/runtime-state';

export const preferredRegion = 'sin1';
export const runtime         = 'nodejs';
/**
 * A tool loop is several model calls; the dogfood's slowest turn ran ~70s.
 * SEC-AI-003 — a LITERAL (Next.js reads it statically), mirrored by
 * `CHAT_ROUTE_MAX_DURATION_S` in lib/ai/turn-deadline.ts; a test pins the two
 * equal. The turn runs inside this minus a safety margin, so the reservation's
 * `finally` below runs before the platform can kill the lambda.
 */
export const maxDuration     = 300;

/** The sealed continuity carrier. HttpOnly: the page has no business reading it. */
const STATE_COOKIE = 'fm_ai_state';

/** Sentences the user sees. Plain, specific, and never a stack trace. One list (refusal-sentences.ts), shared with the history safeguard. */
const SAY = CHAT_REFUSAL_SAY;

const refuse = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

/** What each refusal says and answers with. One place, so no path invents a status. */
const REFUSAL: Record<ChatRequestRefusal, { say: string; status: number }> = {
  MALFORMED: { say: SAY.malformed, status: 400 },
  EMPTY:     { say: SAY.empty,     status: 400 },
  TOO_LONG:  { say: SAY.tooLong,   status: 413 },
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  // SEC-AI-003 — the turn's clock starts when the request arrives, not when the
  // model is first called; what the gates below spend comes out of the budget.
  const arrivedAt = Date.now();
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  // ⚠️ HARDENING — TWO WINDOWS, AND NOBODY IS EXEMPT FROM THE SECOND. A turn costs up
  // to MAX_TOOL_ROUNDTRIPS model calls over a prompt of up to MAX_TRANSCRIPT_BYTES,
  // plus up to MAX_TOOL_CALLS_PER_TURN tool phases and one guidance label. The
  // surface sends one question at a time and a turn takes 5–70 s, so a person
  // cannot approach 10 a minute; the hour window bounds a script — or a stolen
  // admin session — that can.
  //
  // P1 — BOTH WINDOWS ARE THE CUSTOMER'S EFFECTIVE ENTITLEMENT, NOT A LITERAL AND
  // NOT A ROLE. `aiTurnsPerMinute` is the plan's pacing (the founder overlay
  // raises it, to its ceiling); `aiTurnsPerHour` is resolved under a platform
  // CEILING of 60 that no Policy Group or overlay can exceed, so this window
  // still bounds a stolen session exactly as before. The old
  // `role !== 'SYSTEM_ADMIN'` exemption exempted nobody who can reach this
  // route (the proxy keeps SYSTEM_ADMIN off /dashboard) and is gone. Whether the
  // surface is available at all is the `conversations` dimension — a refusal
  // here costs no model call.
  //
  // SEC-AI-004 — BOTH WINDOWS FAIL CLOSED (lib/ai/pacing.ts): a limiter store the
  // route cannot consult refuses with a retryable 503, as the allowance below
  // does, rather than silently waving a paid call through.
  const entitlements = await entitlementsForUser(user.id);
  const disabled = refuseIfDisabled(entitlements, 'conversations', 'Conversations');
  if (disabled) return disabled;
  {
    const limited = await paceAiRequest(user.id, 'ai-chat', { limit: countLimit(entitlements, 'aiTurnsPerMinute'), windowSec: 60 }, 'Conversations');
    if (limited) return limited;
  }
  {
    const limited = await paceAiRequest(user.id, 'ai-chat-hour', { limit: countLimit(entitlements, 'aiTurnsPerHour'), windowSec: 3600 }, 'Conversations');
    if (limited) return limited;
  }
  // AI COST CONTROLS — THE KILL SWITCH OR MAINTENANCE, BEFORE THE ALLOWANCE. Two
  // PlatformSetting rows (`ai_paid_requests_paused`, `maintenance_mode`; either on
  // refuses; absent ⇒ off, unreadable ⇒ paused) judged
  // after authentication, entitlement and pacing so a paused platform costs no
  // lock and no ledger read. 503 `{ error, code: "AI_PAUSED" }`, no-store. No
  // override lifts it; the provider chokepoint judges it again for harness
  // traffic and for a pause that lands mid-turn.
  {
    const admission = await readPaidRequestsAdmission();
    if (admission.paused) {
      // Reason code only — never the prompt, the user, or any figure.
      console.warn('[ai/chat] refused before the provider: paid AI paused (' + (admission.cause ?? admission.state) + ')');
      return paidRequestsPausedResponse();
    }
  }
  // BETA C7 — THE DAILY ALLOWANCE, AFTER THE PACING WINDOWS AND BEFORE ANY MODEL
  // WORK. `aiDailyUsdAllowance` is the customer's estimated-dollar bound per UTC
  // day across Conversations and the Daily Brief, priced by the rate card over
  // the invocation ledger (read on fm_system — the ledger is revoked from the
  // tenant role). Refused at or over the line with `{ error, code: "AI_ALLOWANCE",
  // spentUsd, allowanceUsd }`; refused outright (fail closed) when any of today's
  // invocations could not be priced, because an unknown spend is never "under".
  // AI COST CONTROLS — the decision is taken under a per-customer lock together
  // with the in-flight count and RESERVES this turn; the reservation is released
  // in the `finally` below whatever the turn did (lib/platform/ai/allowance-reservation.ts).
  const allowance = await dailyAiAllowanceFor(user.id, entitlements);
  {
    const refused = allowanceRefusal(allowance, 'Conversations');
    if (refused) return refused;
  }
  // SEC-AI-003 — THE TURN'S DEADLINE: route `maxDuration` minus a safety margin,
  // less what the gates above already spent. Every provider call this turn makes
  // (the answer hops and the guidance label) carries its signal; no retry is
  // taken past it; it is released in the `finally` with the reservation.
  const deadline = openTurnDeadline({ budgetMs: CHAT_TURN_BUDGET_MS - (Date.now() - arrivedAt) });
  // S2-(a) — AI_TURN_FAILED {surface, reason}: an accepted turn that ended
  // without an answer. The typed reason only — never the prompt, the reply, the
  // model or the Space. Fails soft: the writer resolves false and the tenant
  // phase is caught, so the user's refusal sentence is unchanged either way.
  const turnFailed = (reason: AiTurnFailureReason): Promise<unknown> =>
    withTenantDb(user.id, (tx) => recordAiTurnFailed(tx, { userId: user.id, surface: 'chat', reason })).catch(() => false);
  try {
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
      await turnFailed('failed');
      return refuse(SAY.failed, 503);
    }
    if (parsed.spaceId !== null && spaceCtx.spaceId !== parsed.spaceId) {
      return refuse(SAY.forbidden, 403);
    }

    // ── The turn ───────────────────────────────────────────────────────────────
    try {
      // ⚠️ RLS-AI-S11 — THE FLIP. One runner, bound to the authenticated session's
      // user id and nothing else: `requireUser()` produced it, and there is no tool
      // argument, JSON-schema field, header, request body or cookie through which a
      // model or a browser could reach this parameter.
      const phase = aiPhaseRunner(user.id);

      // The agent id is a Space-granular read (`AiAgent`), so it belongs inside the
      // tenant authority like everything else this route reads. It is its OWN short
      // phase rather than part of the prologue because it is an INPUT to opening the
      // transcript — the prologue needs it before it starts.
      const agent = await phase.run('ai_agent', (tx) => tx.aiAgent.findUnique({
        where: { spaceId: spaceCtx.spaceId }, select: { id: true } }));

      // ⚠️ THE SEAL IS OPENED AGAINST THIS REQUEST, NOT MERELY DECRYPTED. User,
      // Space and the tail of the transcript that was actually posted all have to
      // match the seal, so a cookie from another Space or another conversation is
      // simply absent state.
      const binding = { userId: user.id, spaceId: spaceCtx.spaceId,
        tail: conversationTail(history) };
      const carried = openRuntimeState(req.cookies.get(STATE_COOKIE)?.value, binding);
      // A seal that did not open — a new chat, another Space, an older version —
      // means a new conversation, and a new conversation gets a new identity.
      const conversationId = carried?.conversationId ?? randomUUID();

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
        // HARDENING — what the previous answer rested on, for "how did you calculate that?".
        provenance: carried?.provenance ?? null,
        asOfISO: todayUTCISO(),
        // ⚠️ RLS-AI-S11 — THE AUTHORITY HAS MOVED, AND THESE TWO FIELDS ARE NOW THE
        // FALLBACK RATHER THAN THE ANSWER.
        //
        // `phase` below is what this surface's reads actually run under: ONE short
        // tenant transaction for the prologue, ONE per tool call, ONE for a durable
        // checkpoint write, each opened with the authenticated user's identity bound
        // by `SET LOCAL`. These two clients remain on the context because
        // `ToolContext` requires them and because a phase client is a TRANSACTION —
        // it cannot be stored on a context that outlives it. With `phase` present,
        // nothing reads them: the dispatcher replaces both per call.
        //
        // ⚠️ WHAT HAD TO BE TRUE BEFORE THIS LINE COULD CHANGE, since the previous
        // slice refused it for a reason that was correct:
        //   · `AssemblerFn` takes a REQUIRED leading `ReadClient` (S6), so the four
        //     context assemblers can no longer hold `db`, and a turn cannot be
        //     SPLIT-AUTHORITY between its orientation and its tools;
        //   · every financial leaf on that graph receives it — including the two
        //     investment seams that defaulted `client ?? db` invisibly (S7) and the
        //     transfer resolver, which had no client parameter at all;
        //   · the absence contract reaches the ENVELOPE OBJECT the model actually
        //     reads, not just the renderer nothing in production called (S8);
        //   · an assembler FAILURE is a distinct, stated evidence state (S9);
        //   · the Space-probe theorem is pinned by a test that re-derives the real
        //     policies from the migration — and that test FALSIFIED the old `Space`
        //     probe on its first run (S10).
        memoryClient: db,
        readClient: db,
        phase,
        correlationId: conversationId,
        surface: 'chat',
        // Operator-only attribution for the AI cost ledger — see the header.
        attribution: { userId: user.id, spaceId: spaceCtx.spaceId, conversationId },
        // FM-AUDIT-019 — the product route is where durable memory is a feature: the
        // signed-in user's own memory, in their own Space. Every other caller of the
        // turn loop (the dogfood / evaluation harnesses) is read-only unless opted in.
        memoryWrites: true,
        deadline,
      });

      if (!turn.answer) {
        // BETA C7 — THE CHOKEPOINT'S REFUSAL ARRIVES HERE, NOT IN THE CATCH BELOW.
        // The turn loop records a provider throw as the turn's error rather than
        // rethrowing it (a provider failure is a result, not a crash), so an
        // unpriceable model surfaces as a turn with no text. It gets its own
        // sentence and status: the customer is not told to rephrase against a gap
        // only the operator can close. The FAILED / UNPRICED_MODEL fact was already
        // written by the chokepoint, attributed to this conversation.
        if (isUnpricedModelFailure(turn.record.error)) {
          console.error('[ai/chat] turn refused (unpriceable model) —', turn.record.error);
          await turnFailed('unpriced');
          return refuse(SAY.unpriced, 503);
        }
        // AI COST CONTROLS — the kill switch landed mid-turn (the route judged it
        // before the turn; the chokepoint judges it per model call). Same body as
        // the route's own refusal.
        if (isAiPausedFailure(turn.record.error)) {
          console.error('[ai/chat] turn refused (paid AI requests paused) —', turn.record.error);
          await turnFailed('paused');
          return paidRequestsPausedResponse();
        }
        // SEC-AI-003 — the turn ran out of its budget. The provider was abandoned
        // (a zero-token TIMEOUT fact is on the ledger) and the reservation is
        // released below; the user is told to narrow the question.
        if (isTurnTimeoutFailure(turn.record.error)) {
          console.error('[ai/chat] turn abandoned at its deadline —', turn.record.error);
          await turnFailed('timedOut');
          return refuse(SAY.timedOut, 504);
        }
        // The turn record holds why (budget exhausted, finish_reason, round-trip
        // ceiling). That reason is for the server's log; the user gets a sentence.
        console.error('[ai/chat] turn produced no text:', turn.record.error);
        await turnFailed('silent');
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
      // The product's possessive convention ("Chris'", lib/format.ts), applied to
      // the model's prose once, here — the seal's tail and the body must carry the
      // SAME text, because the client echoes this reply back as history.
      const answer = applyPossessiveConvention(turn.answer);
      const seal = sealRuntimeStateWithReport(
        { scenario: turn.scenario, pending: turn.pending, continuity: turn.continuity, provenance: turn.provenance,
          conversationId }, {
        ...binding, tail: conversationTail([...history, { role: 'assistant', content: answer }]),
      });
      const sealed = seal.sealed;
      const body: AiChatResponse = {
        message: answer,
        // The answer's guidance label (lib/ai/conversation/guidance.ts). Omitted
        // when it could not be produced; the surface inherits rather than drops.
        ...(turn.guidance ? { guidance: turn.guidance } : {}),
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
      // BETA C7 — a chokepoint refusal thrown OUTSIDE the turn loop (the loop
      // itself records one as the turn's error — handled above). Same sentence.
      if (err instanceof UnpricedModelError) { await turnFailed('unpriced'); return refuse(SAY.unpriced, 503); }
      if (err instanceof AiPausedError) { await turnFailed('paused'); return paidRequestsPausedResponse(); }
      await turnFailed('failed');
      return refuse(SAY.failed, 503);
    }
  } finally {
    // SEC-AI-003 — the clock is released with the reservation, on every path.
    deadline.dispose();
    await allowance.release();
  }
}
