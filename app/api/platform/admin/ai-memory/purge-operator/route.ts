/**
 * /api/platform/admin/ai-memory/purge-operator  (Platform AI operational memory — System Admin, design v2 D11)
 *
 *   POST { userId } — run fm_purge_platform_ai_memory_for_operator(userId) as fm_system:
 *        the SAME rules as the retention purge (expired, deleted, invalidated > 1 day,
 *        no ACTIVE grant), for ONE operator — used after offboarding / a revoked area.
 *        200 { facts } — COUNTS ONLY. One OPERATOR_PURGED audit row: the target
 *        operator id and the count, nothing else.
 *
 * GATE CHAIN, in order: (1) PLATFORM_AI_MEMORY_PURGE_ENABLED (the purge keeps working
 * after memory is off), else 404; (2) the FRESH guard at CONTROL on Security Ops;
 * (3) SYSTEM_ADMIN only; (4) step-up: the admin's TOTP must be enrolled (no session
 * without a second factor may purge); (5) the #352 limiter; (6) body = one cuid.
 */

import { NextResponse, type NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { operatorHasTotp } from "@/lib/platform/directory.server";
import { env } from "@/lib/env";
import { auditInsert, buildOperatorActionData } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import { NOT_AVAILABLE_BODY } from "@/lib/platform/intelligence/ai/conversations/handlers";
import { PLATFORM_AI_MEMORY_PURGE_OPERATOR_SQL, parseMemoryPurgeRow } from "@/lib/platform/intelligence/ai/memory/purge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const FORBIDDEN = () => NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
const USER_ID = /^c[a-z0-9]{20,40}$/;

export async function POST(req: NextRequest) {
  if (!env.isPlatformAiMemoryPurgeEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404, headers: NO_STORE });
  const [auth, err] = await requireFreshPlatformAccess("SECURITY_OPS", "CONTROL");
  if (err) return err;
  if (auth.user.role !== UserRole.SYSTEM_ADMIN) return FORBIDDEN();
  if (!(await operatorHasTotp(auth.user.id))) return NextResponse.json({ error: "Two-factor authentication is required.", code: "STEP_UP_REQUIRED" }, { status: 403, headers: NO_STORE });
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-memory-admin-purge");
  if (limited) return limited;
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const userId = typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).join() === "userId" ? (body as { userId: unknown }).userId : null;
  if (typeof userId !== "string" || !USER_ID.test(userId)) return NextResponse.json({ error: "Send { userId }.", code: "VALIDATION" }, { status: 400, headers: NO_STORE });
  try {
    const { systemDb } = await import("@/lib/db");
    const facts = parseMemoryPurgeRow(await systemDb.$queryRawUnsafe(PLATFORM_AI_MEMORY_PURGE_OPERATOR_SQL, userId));
    await auditInsert(systemDb, buildOperatorActionData({
      actor: { userId: auth.user.id, via: "SYSTEM_ADMIN" },
      action: AuditAction.PLATFORM_AI_MEMORY_OPERATOR_PURGED,
      target: { kind: "USER", id: userId },
      result: "SUCCESS",
      detail: { count: facts },
    })).write;
    return NextResponse.json({ facts }, { status: 200, headers: NO_STORE });
  } catch (e) {
    console.error(`[platform-ai-memory] purge-operator failed (${e instanceof Error ? e.name : "error"})`);
    return NextResponse.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500, headers: NO_STORE });
  }
}
