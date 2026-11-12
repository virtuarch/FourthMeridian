/**
 * GET  /api/admin/platform-ai-caps  — the Platform AI daily $ caps read model:
 *                                     both blanket values (each with its source),
 *                                     every current operator (SYSTEM_ADMIN users +
 *                                     ACTIVE platform-grant holders) with their
 *                                     override and effective cap, and how many
 *                                     worst-case turns each fits; plus today's
 *                                     ESTIMATED usage (platform totals, by model,
 *                                     by feature, each operator's spend, remaining
 *                                     and state — platform-ai-usage-today.ts).
 * POST /api/admin/platform-ai-caps  — ONE action per request:
 *                                     SET_BLANKET | SET_OVERRIDE | RESET_OVERRIDE.
 *
 * PLATFORM AI CAPS D5 PR4. SYSTEM_ADMIN-only, full stop (S2 09fb C1): the caps are
 * a spend guardrail, so no platform grant can change them. The guard stack follows
 * app/api/admin/platform-grants:
 *   1. requireSystemAdmin() for GET; requireFreshSystemAdmin() for POST (live
 *      revocation re-check).
 *   2. limitByUser(admin.id, "platform-ai-caps", …) — per-operator rate limit.
 *   3. Every rule — distinct actions, validation, eligibility, the platform-cap
 *      bound, concurrency, the transactional reason-required audit, the refusal
 *      record — lives in lib/platform/ai/platform-ai-caps-admin.ts.
 *
 *   200  { result, model }                     applied (or a no-op: changed=false)
 *   400  { error, code }                       VALIDATION | NOT_ELIGIBLE | PLATFORM_CAP_NOT_SET | PLATFORM_CAP_INVALID | ABOVE_PLATFORM_CAP
 *   403  { error, code: "FORBIDDEN" }          not a System Admin (defence in depth)
 *   404  { error, code: "NOT_FOUND" }          a clear / reset with nothing set
 *   409  { error, code: "CONFLICT" }           the row moved; nothing written
 *
 * ⚠️ THE CAPS CANNOT ACTIVATE PLATFORM AI: PLATFORM_AI_ENABLED is judged first on
 * every Platform AI route; nothing here reads or writes it. No provider call.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdmin, requireFreshSystemAdmin } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { platformAiModel } from "@/lib/platform/intelligence/ai/ledger";
import {
  applyPlatformAiCapsAction, loadPlatformAiCapsReadModel, type PlatformAiCapsRefusalCode,
} from "@/lib/platform/ai/platform-ai-caps-admin";
import { withPlatformAiUsageToday } from "@/lib/platform/ai/platform-ai-usage-today";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const STATUS: Record<PlatformAiCapsRefusalCode, number> = {
  VALIDATION: 400, NOT_ELIGIBLE: 400, PLATFORM_CAP_NOT_SET: 400, PLATFORM_CAP_INVALID: 400, ABOVE_PLATFORM_CAP: 400,
  FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
};

export async function GET() {
  const [, err] = await requireSystemAdmin();
  if (err) return err;
  const model = await withPlatformAiUsageToday(await loadPlatformAiCapsReadModel(platformAiModel().model));
  return NextResponse.json(model, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const [admin, err] = await requireFreshSystemAdmin();
  if (err) return err;
  const limited = await limitByUser(admin.id, "platform-ai-caps", { limit: 20, windowSec: 60 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const result = await applyPlatformAiCapsAction(body, {
    id: admin.id, role: admin.role, ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent"),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason, code: result.code }, { status: STATUS[result.code], headers: NO_STORE });
  }
  const model = await withPlatformAiUsageToday(await loadPlatformAiCapsReadModel(platformAiModel().model));
  return NextResponse.json({ result, model }, { headers: NO_STORE });
}
