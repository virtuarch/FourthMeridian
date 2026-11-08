/**
 * /api/platform/ai/memory/confirm — POST { token, ttl, note? }: the confirm card  (Platform AI operational memory — Preview only, OFF by default)
 *
 * GATE CHAIN, in order: (1) isMemoryEffective, else 404 before anything; (2) the
 * session, ≥ 1 ACTIVE grant, the FRESH guard on the first area; (3) the #352
 * limiter. Then the handler (lib/platform/intelligence/ai/memory/handlers.ts).
 * NO CONTENT IN LOGS: errors by code only — never a note, token or ref.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { platformAiAreaFor } from "@/lib/platform/intelligence/ai/core";
import { NOT_AVAILABLE_BODY } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { isMemoryEffective } from "@/lib/platform/intelligence/ai/memory/gate";
import { handleConfirm, type MemoryHttp } from "@/lib/platform/intelligence/ai/memory/handlers";
import { memoryDeps } from "../deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const respond = (r: MemoryHttp) => r.body === null ? new NextResponse(null, { status: r.status, headers: NO_STORE }) : NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
const FORBIDDEN = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
const INTERNAL = (err: unknown) => {
  console.error(`[platform-ai-memory] POST failed (${err instanceof Error ? err.name : "error"})`);
  return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500, headers: NO_STORE });
};

export async function POST(req: NextRequest) {
  if (!isMemoryEffective(env)) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  const [user, uerr] = await requireUser();
  if (uerr) return uerr;
  const area = platformAiAreaFor(await loadPlatformDirectory(user.id));
  if (!area) return FORBIDDEN();
  const [auth, err] = await requireFreshPlatformAccess(area, "READ");
  if (err) return err;
  if (!auth.grant) return FORBIDDEN();
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-memory-write");
  if (limited) return limited;
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  try { return respond(await handleConfirm(auth.user.id, body, memoryDeps(auth.user.id))); }
  catch (e) { return INTERNAL(e); }
}
