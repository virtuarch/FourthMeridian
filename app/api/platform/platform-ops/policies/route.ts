/**
 * /api/platform/platform-ops/policies
 *
 *   GET     the Policies read model — for each financial-refresh source kind
 *           (BANK, WALLET): what is CONFIGURED, what is EFFECTIVE, what the
 *           deployed scheduler can HONOUR, what the latest sweep ACTUALLY ran
 *           under. Composed at read time; no second store.
 *   PATCH   change one cadence          { sourceKind, cadence, expectedUpdatedAt, reason }
 *   DELETE  reset one cadence to default { sourceKind, expectedUpdatedAt, reason }
 *
 * REASON IS REQUIRED (UX-P1 D7). A refresh-cadence change is a consequential
 * platform action, so the body carries a structured { code, note? }
 * (lib/audit.ts OPERATOR_REASON_CODES, note ≤ 280 chars and scrubbed) and the
 * service refuses to commit without it: 400 with the parser's sentence when it
 * is missing or malformed. The reason CODE reaches the operator feeds; the note
 * stays in the audit row.
 *
 * AUTHORIZATION
 *   GET            requirePlatformAccess("PLATFORM_OPS", "READ")
 *   PATCH, DELETE  requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")
 *                  — the first CONTROL consumer (control-plane-policy,
 *                  lib/platform/capability-classification.ts). READ and WRITE
 *                  holders receive 403: CONTROL is a rank above WRITE and is
 *                  granted deliberately. Fresh auth, like every platform mutation.
 *
 * CLOSED CONTRACT. The body names a source kind, never a setting key: only the
 * two refresh cadences are reachable, whatever else the descriptor registry
 * knows. Every rule — validation, honourability, concurrency, the transactional
 * audit — lives in lib/platform/policies/mutate.ts; this route only maps the
 * service's outcome to a status:
 *
 *   200  { …read model }                       applied (or reset)
 *   400  { error }                             the body is malformed or the
 *                                              reason is missing / unsafe
 *   400  { error, code: "VALIDATION", model }  the descriptor or the deployed
 *                                              scheduler refused the value
 *   409  { error, code: "CONFLICT", model }    the policy changed since the
 *                                              caller observed it; nothing
 *                                              written; `model` is current
 *
 * ⚠️ NO PROVIDER CALL, NO JOB, NO AI CALL — on read or on write. A policy change
 * changes policy; existing consumers observe it on their next read.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { recordControlRefusal } from "@/lib/platform/control-refusal";
import { loadRefreshPoliciesReadModel, type RefreshPoliciesReadModel } from "@/lib/platform/policies/refresh-policies";
import {
  isEditableSourceKind, resetRefreshCadence, updateRefreshCadence, type PolicyMutationResult,
} from "@/lib/platform/policies/mutate";

export const runtime = "nodejs";

export type PlatformPoliciesResponse = RefreshPoliciesReadModel;

/** The refusal shape: what went wrong, and the canonical state to show instead. */
export interface PlatformPoliciesRefusal {
  error: string;
  code: "VALIDATION" | "CONFLICT" | "NOT_FOUND";
  model: RefreshPoliciesReadModel;
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const model = await loadRefreshPoliciesReadModel();
  return NextResponse.json(model satisfies PlatformPoliciesResponse);
}

function respond(result: PolicyMutationResult) {
  if (result.ok) return NextResponse.json(result.model satisfies PlatformPoliciesResponse);
  const status = result.code === "CONFLICT" ? 409 : result.code === "NOT_FOUND" ? 404 : 400;
  return NextResponse.json(
    { error: result.reason, code: result.code, model: result.model } satisfies PlatformPoliciesRefusal,
    { status },
  );
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

/** SEC-PLAT-2 — the reason CODE a body carried, for the refusal record (never the note). */
function reasonCodeOf(body: Record<string, unknown> | null): unknown {
  const r = body?.reason;
  return r && typeof r === "object" ? (r as { code?: unknown }).code : undefined;
}

export async function PATCH(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-policy", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const meta = { ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") };
  const body = await readBody(req);
  const sourceKind = body && isEditableSourceKind(body.sourceKind) ? body.sourceKind : null;
  // SEC-PLAT-2 — every refusal past the grant check is recorded (control, verb,
  // closed-vocabulary target, refusal code, reason code; never a submitted value).
  const refuse = async (res: NextResponse, code: "VALIDATION" | "CONFLICT" | "NOT_FOUND") => {
    await recordControlRefusal(auth, { control: "refresh-cadence", verb: "change", code, targetKey: sourceKind, reasonCode: reasonCodeOf(body) }, meta);
    return res;
  };

  if (!body || !sourceKind) {
    return refuse(NextResponse.json({ error: "sourceKind must be BANK or WALLET." }, { status: 400 }), "VALIDATION");
  }
  if (typeof body.cadence !== "string") {
    return refuse(NextResponse.json({ error: "cadence is required." }, { status: 400 }), "VALIDATION");
  }
  if (!("expectedUpdatedAt" in body) || (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== "string")) {
    return refuse(NextResponse.json({ error: "expectedUpdatedAt must be the observed override version (ISO) or null." }, { status: 400 }), "VALIDATION");
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return refuse(NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400 }), "VALIDATION"); }

  const result = await updateRefreshCadence({
    sourceKind,
    cadence: body.cadence,
    expectedUpdatedAt: body.expectedUpdatedAt as string | null,
    reason,
    actor: { id: auth.user.id, ...meta },
  });
  return result.ok ? respond(result) : refuse(respond(result), result.code);
}

export async function DELETE(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-policy", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const meta = { ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") };
  const body = await readBody(req);
  const sourceKind = body && isEditableSourceKind(body.sourceKind) ? body.sourceKind : null;
  const refuse = async (res: NextResponse, code: "VALIDATION" | "CONFLICT" | "NOT_FOUND") => {
    await recordControlRefusal(auth, { control: "refresh-cadence", verb: "reset", code, targetKey: sourceKind, reasonCode: reasonCodeOf(body) }, meta);
    return res;
  };

  if (!body || !sourceKind) {
    return refuse(NextResponse.json({ error: "sourceKind must be BANK or WALLET." }, { status: 400 }), "VALIDATION");
  }
  if (typeof body.expectedUpdatedAt !== "string") {
    return refuse(NextResponse.json({ error: "expectedUpdatedAt (the observed override version, ISO) is required to reset." }, { status: 400 }), "VALIDATION");
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return refuse(NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400 }), "VALIDATION"); }

  const result = await resetRefreshCadence({
    sourceKind,
    expectedUpdatedAt: body.expectedUpdatedAt,
    reason,
    actor: { id: auth.user.id, ...meta },
  });
  return result.ok ? respond(result) : refuse(respond(result), result.code);
}
