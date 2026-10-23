/**
 * /api/platform/platform-ops/job-cadence  (P1 HUMAN OPERABILITY — execution cadence)
 *
 *   GET     the execution-cadence read model: every registered job with its
 *           cadence in force, where it came from, its bounds, last run and next
 *           due; plus how often the platform is woken.
 *   PATCH   change an editable job's cadence   { job, hours, expectedUpdatedAt, reason }
 *   DELETE  reset it to the default            { job, expectedUpdatedAt, reason }
 *
 * AUTHORIZATION
 *   GET            requirePlatformAccess("PLATFORM_OPS", "READ")
 *   PATCH, DELETE  requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — the same
 *                  rank the refresh-cadence policies require. READ and WRITE
 *                  holders receive 403.
 *
 * REASON IS REQUIRED. A cadence change is a consequential platform action, so
 * the body carries a structured { code, note? } (lib/audit.ts) and the service
 * refuses to commit without it. Every rule — bounds, concurrency, the
 * transactional audit — lives in lib/platform/policies/job-cadence.ts; this
 * route maps the outcome to a status: 200 applied · 400 VALIDATION / NOT_EDITABLE
 * / bad reason · 409 CONFLICT (the canonical current model rides along).
 *
 * ⚠️ NO JOB RUNS BECAUSE OF A CALL HERE. A cadence change changes cadence; the
 * dispatcher applies it at its next wake.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import {
  loadJobCadenceReadModel, resetJobCadence, updateJobCadence,
  type JobCadenceMutationResult, type JobCadenceReadModel,
} from "@/lib/platform/policies/job-cadence";

export const runtime = "nodejs";

export type JobCadenceResponse = JobCadenceReadModel;

export interface JobCadenceRefusal {
  error: string;
  code: "VALIDATION" | "CONFLICT" | "NOT_EDITABLE";
  model: JobCadenceReadModel;
}

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json((await loadJobCadenceReadModel()) satisfies JobCadenceResponse);
}

function respond(result: JobCadenceMutationResult) {
  if (result.ok) return NextResponse.json(result.model satisfies JobCadenceResponse);
  const status = result.code === "CONFLICT" ? 409 : 400;
  return NextResponse.json({ error: result.reason, code: result.code, model: result.model } satisfies JobCadenceRefusal, { status });
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

export async function PATCH(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-policy", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const body = await readBody(req);
  if (!body || typeof body.job !== "string") return NextResponse.json({ error: "job is required." }, { status: 400 });
  if (typeof body.hours !== "number" && typeof body.hours !== "string") return NextResponse.json({ error: "hours is required." }, { status: 400 });
  if (!("expectedUpdatedAt" in body) || (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== "string")) {
    return NextResponse.json({ error: "expectedUpdatedAt must be the observed override version (ISO) or null." }, { status: 400 });
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400 }); }

  return respond(await updateJobCadence({
    job: body.job, hours: body.hours, expectedUpdatedAt: body.expectedUpdatedAt as string | null, reason,
    actor: { id: auth.user.id, ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") },
  }));
}

export async function DELETE(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitByUser(auth.user.id, "platform-policy", { limit: 30, windowSec: 60 });
  if (limited) return limited;

  const body = await readBody(req);
  if (!body || typeof body.job !== "string") return NextResponse.json({ error: "job is required." }, { status: 400 });
  if (typeof body.expectedUpdatedAt !== "string") {
    return NextResponse.json({ error: "expectedUpdatedAt (the observed override version, ISO) is required to reset." }, { status: 400 });
  }
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return NextResponse.json({ error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }, { status: 400 }); }

  return respond(await resetJobCadence({
    job: body.job, expectedUpdatedAt: body.expectedUpdatedAt, reason,
    actor: { id: auth.user.id, ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") },
  }));
}
