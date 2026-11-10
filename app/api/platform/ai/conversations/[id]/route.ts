/**
 * /api/platform/ai/conversations/[id]  (Platform AI conversations — B11, OFF by default)
 *
 *   GET     one live conversation and its messages (links re-resolved through
 *           the CURRENT token; every prior answer labelled stale)
 *   DELETE  soft delete (hidden at once; hard-deleted by the purge after the
 *           grace) + the DELETED audit row (no content) → 204
 *
 * GATE CHAIN: see ../route.ts. Not the operator's, soft-deleted, an id of the
 * wrong shape, or the conversation's area refused by its FRESH guard ⇒ ONE
 * 404 { error: "Not found.", code: "NOT_FOUND" }, byte-identical in every case
 * (no existence oracle, S2 B4).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { platformAiAreaFor } from "@/lib/platform/intelligence/ai/core";
import {
  NOT_AVAILABLE_BODY, handleDeleteConversation, handleGetConversation, type ConversationHttp,
} from "@/lib/platform/intelligence/ai/conversations/handlers";
import * as store from "@/lib/platform/intelligence/ai/conversations/store";
import { conversationAreaAccess, conversationHeldAccess } from "../area-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const respond = (r: ConversationHttp) => r.status === 204
  ? new NextResponse(null, { status: 204, headers: NO_STORE })
  : NextResponse.json(r.body, { status: r.status, headers: { ...NO_STORE, ...(r.headers ?? {}) } });
const FORBIDDEN = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
const INTERNAL = (route: string, err: unknown) => {
  console.error(`[platform-ai-conversations] ${route} failed (${err instanceof Error ? err.name : "error"})`);
  return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500, headers: NO_STORE });
};
const deps = () => ({ areaAccess: conversationAreaAccess, store, now: () => new Date() });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
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
  const { id } = await ctx.params;
  try {
    // P4b — answers that read an area not held now (these rows, each fresh-guarded) render "[no longer available]".
    return respond(await handleGetConversation({ operatorId: auth.user.id, area: auth.grant.area }, id, { ...deps(), heldAccess: conversationHeldAccess(rows) }));
  } catch (e) {
    return INTERNAL("get", e);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  // 1. The flags: OFF ⇒ nothing else runs.
  if (!env.isPlatformAiConversationsEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  // 2–3. The viewer, before any lookup.
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  const area = platformAiAreaFor(await loadPlatformDirectory(user.id));
  if (!area) return FORBIDDEN();
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;
  if (!auth.grant) return FORBIDDEN();
  // 4. #352 — the per-operator mutation limiter.
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-conversation-delete");
  if (limited) return limited;
  const { id } = await ctx.params;
  try {
    return respond(await handleDeleteConversation({ operatorId: auth.user.id, area: auth.grant.area }, id, deps()));
  } catch (e) {
    return INTERNAL("delete", e);
  }
}
