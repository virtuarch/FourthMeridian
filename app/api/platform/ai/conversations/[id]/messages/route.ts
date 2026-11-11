/**
 * /api/platform/ai/conversations/[id]/messages  (Platform AI conversations — B11, OFF by default)
 *
 *   POST  { clientRequestId, question } — the next question of a live conversation:
 *         stored (transaction 1), answered (the turn, outside any transaction),
 *         settled (transaction 2) → 200 { userMessage, assistantMessage }
 *
 * GATE CHAIN: see ../../route.ts (flags → session → viewer pre-check + the FRESH
 * guard on the first area → the #352 limiter). Then the handler
 * (handleAppendMessage): the conversation's OWN area FRESH (a refusal, including a
 * grant revoked between turns, is the ONE 404 and no turn runs); a replay of a
 * known clientRequestId (no model, no daily turn); v0's kill switch → freeze →
 * daily cap; one in-flight turn per conversation (409 TURN_IN_FLIGHT); the
 * 40-message cap (409 CONVERSATION_FULL). Pre-model refusals store nothing.
 * P4b: the turn then binds the conversation's own area AND every other area the
 * operator holds now (these directory rows), each behind its own fresh guard
 * (area-access.ts conversationHeldAccess); the boundary rechecks per tool call.
 *
 * NO CONTENT IN LOGS: errors are reported by code; no request body, question,
 * answer, label or message id reaches the console or Sentry.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { readPaidRequestsAdmission } from "@/lib/platform/ai/paid-requests-admission";
import { readGlobalCostFreeze } from "@/lib/platform/cost-freeze";
import { readPlatformAiTurns } from "@/lib/platform/ai/platform-ai-turns";
import { reservePlatformAiSpend } from "@/lib/platform/ai/platform-ai-spend";
import { platformAiModel } from "@/lib/platform/intelligence/ai/ledger";
import { platformAiAreaFor } from "@/lib/platform/intelligence/ai/core";
import {
  NOT_AVAILABLE_BODY, handleAppendMessage, type ConversationHttp,
} from "@/lib/platform/intelligence/ai/conversations/handlers";
import * as store from "@/lib/platform/intelligence/ai/conversations/store";
import { conversationAreaAccess, conversationHeldAccess } from "../../area-access";
import { isSubjectResolutionEnabled, platformAiSubjectFlags } from "@/lib/platform/intelligence/ai/authz/subject.server";
import { platformAiPickerGuard } from "@/lib/platform/intelligence/ai/authz/people.server";
import { runConversationTurnForRoute } from "../../turn-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const respond = (r: ConversationHttp) => NextResponse.json(r.body, { status: r.status, headers: { ...NO_STORE, ...(r.headers ?? {}) } });
const FORBIDDEN = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
const INTERNAL = (route: string, err: unknown) => {
  console.error(`[platform-ai-conversations] ${route} failed (${err instanceof Error ? err.name : "error"})`);
  return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500, headers: NO_STORE });
};

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  // 1. The flags: OFF ⇒ nothing else runs.
  if (!env.isPlatformAiConversationsEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  // 2–3. The viewer, before any lookup.
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  const rows = await loadPlatformDirectory(user.id);
  const area = platformAiAreaFor(rows);
  if (!area) return FORBIDDEN();
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;
  if (!auth.grant) return FORBIDDEN();
  // 4. #352 — the per-operator mutation limiter.
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-message");
  if (limited) return limited;
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  try {
    return respond(await handleAppendMessage({ operatorId: auth.user.id, area: auth.grant.area }, id, body, {
      areaAccess: conversationAreaAccess, store, now: () => new Date(),
      // P4b — the turn binds every area held NOW (these directory rows), each behind its own fresh guard.
      heldAccess: conversationHeldAccess(rows),
      admission: () => readPaidRequestsAdmission(),
      freeze: () => readGlobalCostFreeze(),
      turns: (uid, now) => readPlatformAiTurns(uid, now),
      spend: (uid, now) => reservePlatformAiSpend(uid, now, { model: platformAiModel().model }),
      runTurn: runConversationTurnForRoute,
      // P5 — subject resolution only while the customers pack flag is ON (strict, default OFF).
      subjectsEnabled: isSubjectResolutionEnabled, subjectFlags: platformAiSubjectFlags,
      // S2 09fc G6 — the bare-username guard on every turn's RAW question (before anything is stored).
      guard: (v, raw) => platformAiPickerGuard({ operatorId: v.operatorId, primaryArea: v.area })(raw),
    }));
  } catch (e) {
    return INTERNAL("message", e);
  }
}
