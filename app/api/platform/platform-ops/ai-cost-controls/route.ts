/**
 * /api/platform/platform-ops/ai-cost-controls  (AI COST CONTROLS)
 *
 *   GET     the read model (AiCostControlsReadModel): the seven controls with
 *           value / origin / version / writer, the allowance's effective default
 *           and override list, each alert's status, the kill switch's customer
 *           sentence, and the caching posture.
 *   PATCH   { changes: AiCostControlChange[], reason: { code, note? } } — ONE
 *           transaction, all-or-nothing, one audit row per change; the result
 *           is the reloaded read model.
 *
 * AUTHORIZATION
 *   GET     requirePlatformAccess("PLATFORM_OPS", "READ")
 *   PATCH   requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — the same
 *           rank as the refresh-cadence and job-cadence editors. READ and WRITE
 *           holders receive 403. Paced like the policies route.
 *
 * CLOSED CONTRACT. The body names a CONTROL (cost-controls.types.ts), never a
 * setting key. Every rule — validation, concurrency, the transactional audit —
 * lives in lib/platform/ai/cost-controls.ts; this route maps outcomes:
 *
 *   200  { …read model }                                  applied
 *   400  { error }                                        malformed body / reason
 *   400  { error, code: "VALIDATION", control?, model }   a value refused
 *   404  { error, code: "NOT_FOUND",  control,  model }   a reset with no row
 *   409  { error, code: "CONFLICT",   control,  model }   a row moved; nothing written
 *
 * ⚠️ NO PROVIDER CALL, NO JOB, NO AI CALL — on read or on write.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { applyAiCostControlChanges, loadAiCostControlsReadModel, type AiCostControlsMutationResult } from "@/lib/platform/ai/cost-controls";
import { AI_COST_CONTROL_KEYS, type AiCostControlsReadModel, type AiCostControlsRefusal } from "@/lib/platform/ai/cost-controls.types";
import { recordControlRefusal } from "@/lib/platform/control-refusal";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export type AiCostControlsResponse = AiCostControlsReadModel;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const model = await loadAiCostControlsReadModel();
  return NextResponse.json(model satisfies AiCostControlsResponse, { headers: NO_STORE });
}

function respond(result: AiCostControlsMutationResult) {
  if (result.ok) return NextResponse.json(result.model satisfies AiCostControlsResponse, { headers: NO_STORE });
  const status = result.code === "CONFLICT" ? 409 : result.code === "NOT_FOUND" ? 404 : 400;
  const body: AiCostControlsRefusal = { error: result.reason, code: result.code, ...(result.control ? { control: result.control } : {}), model: result.model };
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function PATCH(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-policy-ai-cost-controls", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const meta = { ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") };
  const body = await req.json().catch(() => null) as { changes?: unknown; reason?: unknown } | null;
  const reasonCode = body?.reason && typeof body.reason === "object" ? (body.reason as { code?: unknown }).code : undefined;
  // SEC-PLAT-2 — every refusal past the grant check is recorded. The target is a
  // known control id only (the refusal's own `control`, else the first change's
  // when it names a known control); never a submitted value.
  const firstControl = Array.isArray(body?.changes) ? (body!.changes[0] as { control?: unknown } | undefined)?.control : undefined;
  const knownControl = (c: unknown): string | null =>
    typeof c === "string" && (AI_COST_CONTROL_KEYS as readonly string[]).includes(c) ? c : null;
  const refuse = async (res: NextResponse, code: "VALIDATION" | "CONFLICT" | "NOT_FOUND", control?: unknown) => {
    await recordControlRefusal(auth, {
      control: "ai-cost-controls", verb: "change", code,
      targetKey: knownControl(control) ?? knownControl(firstControl), reasonCode,
    }, meta);
    return res;
  };

  if (!body || typeof body !== "object" || !Array.isArray(body.changes)) {
    return refuse(NextResponse.json({ error: "changes must be an array of { control, value, expectedUpdatedAt }." }, { status: 400, headers: NO_STORE }), "VALIDATION");
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return refuse(NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400, headers: NO_STORE }), "VALIDATION"); }

  const result = await applyAiCostControlChanges({
    changes: body.changes,
    reason,
    actor: { id: auth.user.id, ...meta },
  });
  return result.ok ? respond(result) : refuse(respond(result), result.code, result.control);
}
