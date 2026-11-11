/**
 * /api/platform/ai/conversations  (Platform AI conversations — B11, OFF by default)
 *
 *   GET   the operator's live conversations (derived labels; rows filtered by ONE directory read)
 *   POST  { clientRequestId, question } — create = the first question; the turn runs
 *         (outside any transaction) and is settled before the response
 *
 * Design: docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §3, §10. The logic is
 * lib/platform/intelligence/ai/conversations/handlers.ts; the data module is
 * …/conversations/store.ts (withTenantDb only).
 *
 * GATE CHAIN (inline, in this order):
 *   1. PLATFORM_AI_ENABLED && PLATFORM_AI_CONVERSATIONS_ENABLED, else 404 NOT_AVAILABLE (nothing else runs)
 *   2. a session                                                    → 401
 *   3. ≥ 1 ACTIVE grant with a Platform Space, then the FRESH guard on the
 *      operator's first area; a break-glass SYSTEM_ADMIN (no grant)  → 403
 *   4. POST only: the #352 per-operator limiter                     → 429
 *   then the handler: POST — the new conversation's area; GET — the rows of areas
 *   the SAME directory read reaches (no per-area guard, so no per-area denial rows).
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
  NOT_AVAILABLE_BODY, grantedAreasFrom, handleCreateConversation, handleListConversations, type ConversationHttp,
} from "@/lib/platform/intelligence/ai/conversations/handlers";
import * as store from "@/lib/platform/intelligence/ai/conversations/store";
import { conversationAreaAccess, conversationHeldAccess } from "./area-access";
import { isSubjectResolutionEnabled, platformAiSubjectFlags } from "@/lib/platform/intelligence/ai/authz/subject.server";
import { platformAiPickerGuard } from "@/lib/platform/intelligence/ai/authz/people.server";
import { runConversationTurnForRoute } from "./turn-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const respond = (r: ConversationHttp) => NextResponse.json(r.body, { status: r.status, headers: { ...NO_STORE, ...(r.headers ?? {}) } });
const FORBIDDEN = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
const INTERNAL = (route: string, err: unknown) => {
  console.error(`[platform-ai-conversations] ${route} failed (${err instanceof Error ? err.name : "error"})`);
  return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500, headers: NO_STORE });
};
const deps = () => ({ areaAccess: conversationAreaAccess, store, now: () => new Date() });

export async function GET() {
  // 1. The flags: OFF ⇒ nothing else runs.
  if (!env.isPlatformAiConversationsEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  // 2–3. The viewer, before any lookup.
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  // ONE directory read: it picks the gate's area AND filters the rows (S2 NOTED on
  // #424 — no per-area fresh guard here, so no per-area denial audit rows).
  const directory = await loadPlatformDirectory(user.id);
  const area = platformAiAreaFor(directory);
  if (!area) return FORBIDDEN();
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;
  if (!auth.grant) return FORBIDDEN();
  try {
    return respond(await handleListConversations({ operatorId: auth.user.id, area: auth.grant.area }, grantedAreasFrom(directory), { store }));
  } catch (e) {
    return INTERNAL("list", e);
  }
}

export async function POST(req: NextRequest) {
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
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-conversation-create");
  if (limited) return limited;

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  try {
    return respond(await handleCreateConversation({ operatorId: auth.user.id, area: auth.grant.area }, body, {
      ...deps(),
      // P4b — the turn binds every area held NOW (these directory rows), each behind its own fresh guard.
      heldAccess: conversationHeldAccess(rows),
      admission: () => readPaidRequestsAdmission(),
      freeze: () => readGlobalCostFreeze(),
      turns: (id, now) => readPlatformAiTurns(id, now),
      spend: (id, now) => reservePlatformAiSpend(id, now, { model: platformAiModel().model }),
      runTurn: runConversationTurnForRoute,
      // P5 — subject resolution only while the customers pack flag is ON (strict, default OFF).
      subjectsEnabled: isSubjectResolutionEnabled, subjectFlags: platformAiSubjectFlags,
      // S2 09fc G6 — the bare-username guard on every turn's RAW question (before anything is stored).
      guard: (v, raw) => platformAiPickerGuard({ operatorId: v.operatorId, primaryArea: v.area })(raw),
    }));
  } catch (e) {
    return INTERNAL("create", e);
  }
}
