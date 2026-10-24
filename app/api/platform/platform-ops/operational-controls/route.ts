/**
 * /api/platform/platform-ops/operational-controls  (PLATFORM OPS — Operational Controls)
 *
 *   GET     the read model (OperationalControlsReadModel): maintenance mode's
 *           state (Enabled / Disabled / Not configured / unreadable), version,
 *           writer and the work it blocks; the AI kill switch and ingestion
 *           pause read-only; the deployment environment.
 *   PATCH   { action: "ENABLE" | "DISABLE" | "RESET", expectedUpdatedAt, reason: { code, note } }
 *           — ONE transaction, one audit row; the result is the reloaded model.
 *
 * AUTHORIZATION
 *   GET     requirePlatformAccess("PLATFORM_OPS", "READ") — the Policies read rank.
 *   PATCH   requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — a live grant
 *           check on every write; READ and WRITE holders receive 403 (and the
 *           refusal is recorded by the authorizer). Paced on its own bucket so
 *           other policy edits can never exhaust the way out of maintenance.
 *
 * ⚠️ THIS ROUTE NEVER CONSULTS ADMISSION. Maintenance cannot lock the operator
 * out of turning maintenance off.
 *
 * CLOSED CONTRACT. The body names an action, never a setting key. Every rule —
 * validation, concurrency, the transactional audit — lives in
 * lib/platform/policies/operational-controls.ts; this route maps outcomes:
 *
 *   200  { …read model }                       applied (persisted and read back)
 *   400  { error }                             malformed body / reason
 *   400  { error, code: "VALIDATION", model }  an action or version refused
 *   404  { error, code: "NOT_FOUND",  model }  a reset with no row
 *   409  { error, code: "CONFLICT",   model }  the row moved (or already in that state); nothing written
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import {
  applyMaintenanceChange, loadOperationalControlsReadModel, type OperationalControlsMutationResult,
} from "@/lib/platform/policies/operational-controls";
import type { OperationalControlsReadModel, OperationalControlsRefusal } from "@/lib/platform/policies/operational-controls.types";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export type OperationalControlsResponse = OperationalControlsReadModel;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const model = await loadOperationalControlsReadModel();
  return NextResponse.json(model satisfies OperationalControlsResponse, { headers: NO_STORE });
}

function respond(result: OperationalControlsMutationResult) {
  if (result.ok) return NextResponse.json(result.model satisfies OperationalControlsResponse, { headers: NO_STORE });
  const status = result.code === "CONFLICT" ? 409 : result.code === "NOT_FOUND" ? 404 : 400;
  const body: OperationalControlsRefusal = { error: result.reason, code: result.code, model: result.model };
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function PATCH(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-policy-operational-controls", { limit: 20, windowSec: 60 });
  if (limited) return limited;

  const body = await req.json().catch(() => null) as { reason?: unknown } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be { action, expectedUpdatedAt, reason }." }, { status: 400, headers: NO_STORE });
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400, headers: NO_STORE }); }

  const result = await applyMaintenanceChange({
    change: body,
    reason,
    actor: { id: auth.user.id, ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") },
  });
  return respond(result);
}
