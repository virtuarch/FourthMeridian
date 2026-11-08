/**
 * /api/platform/ai/memory  (Platform AI operational memory — Preview only, OFF by default)
 *
 *   GET     the operator's memory across HELD areas only, re-checked live (the panel)
 *   DELETE  "Delete all my memory" — the soft-delete definer, every own row in held areas
 *
 * GATE CHAIN, in order: (1) isMemoryEffective, else 404 before anything; (2) the
 * session, ≥ 1 ACTIVE grant, the FRESH guard on the first area; (3) DELETE: the
 * #352 limiter. NO CONTENT IN LOGS: errors by code only.
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { limitByUser } from "@/lib/rate-limit";
import { MEMORY_READ_LIMIT, PLATFORM_AI_MEMORY_READ_ROUTE } from "@/lib/platform/intelligence/ai/memory/constants";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { platformAiAreaFor } from "@/lib/platform/intelligence/ai/core";
import { NOT_AVAILABLE_BODY } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { isMemoryEffective } from "@/lib/platform/intelligence/ai/memory/gate";
import { handleDeleteAll, handleListMemory, type MemoryHttp } from "@/lib/platform/intelligence/ai/memory/handlers";
import { memoryDeps } from "./deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const respond = (r: MemoryHttp) => r.body === null ? new NextResponse(null, { status: r.status, headers: NO_STORE }) : NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
const FORBIDDEN = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
const INTERNAL = (route: string, err: unknown) => {
  console.error(`[platform-ai-memory] ${route} failed (${err instanceof Error ? err.name : "error"})`);
  return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500, headers: NO_STORE });
};

export async function GET(req: Request) {
  if (!isMemoryEffective(env)) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  const area = platformAiAreaFor(await loadPlatformDirectory(user.id));
  if (!area) return FORBIDDEN();
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;
  if (!auth.grant) return FORBIDDEN();
  // S2 C5: the per-operator read limiter (every read re-checks records live).
  const readLimited = await limitByUser(auth.user.id, PLATFORM_AI_MEMORY_READ_ROUTE, MEMORY_READ_LIMIT);
  if (readLimited) return readLimited;
  // ?probe=1 — the Remember buttons' one check that memory is effective (after every gate; reads no fact).
  if (new URL(req.url).searchParams.get("probe") === "1") return NextResponse.json({ enabled: true }, { status: 200, headers: NO_STORE });
  try { return respond(await handleListMemory(auth.user.id, memoryDeps(auth.user.id))); }
  catch (e) { return INTERNAL("list", e); }
}

export async function DELETE() {
  if (!isMemoryEffective(env)) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  const area = platformAiAreaFor(await loadPlatformDirectory(user.id));
  if (!area) return FORBIDDEN();
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;
  if (!auth.grant) return FORBIDDEN();
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-memory-delete");
  if (limited) return limited;
  try { return respond(await handleDeleteAll(auth.user.id, memoryDeps(auth.user.id))); }
  catch (e) { return INTERNAL("delete-all", e); }
}
