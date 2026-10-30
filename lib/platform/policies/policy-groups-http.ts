/**
 * lib/platform/policies/policy-groups-http.ts  (POLICY EDITOR — the routes' shared plumbing)
 *
 * The five CONTROL write routes under app/api/platform/platform-ops/policy-groups/
 * share one body parser, one reason parser and one refusal path, copied from
 * the Beta reconciliation route's shape. The AUTHORIZATION call itself stays in
 * each route (requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")) so the
 * route-guard census and the CONTROL ratchet see it where it runs.
 *
 * Every refusal AFTER the grant check is recorded as PLATFORM_CONTROL_REFUSED
 * (control "policy-groups", the verb, the refusal code, the reason CODE) —
 * never the note, the submitted values or the message.
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/api";
import { limitByUser } from "@/lib/rate-limit";
import { OperatorActionValidationError, parseOperatorReason, type OperatorReason } from "@/lib/audit";
import type { PlatformAuth } from "@/lib/platform/authorize";
import { recordControlRefusal } from "@/lib/platform/control-refusal";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { POLICY_GROUP_KEY_PATTERN } from "@/lib/entitlements/policy-groups";
import type { ControlVerb } from "@/lib/platform/control-refusal.core";
import type { PolicyGroupActor, PolicyGroupRefusalCode } from "./policy-groups-write";

export interface PolicyGroupRefusalBody {
  error: string;
  code?: PolicyGroupRefusalCode;
  errors?: string[];
}

export const POLICY_GROUP_WRITE_LIMIT = { limit: 10, windowSec: 60 } as const;

const STATUS: Record<PolicyGroupRefusalCode, number> = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, NOT_EDITABLE: 409 };

type Auth = Pick<PlatformAuth, "user" | "grant">;

export interface WriteContext {
  auth: Auth;
  verb: ControlVerb;
  /** The group key from the path / body — recorded only when it matches the key pattern. */
  targetKey: string | null;
  body: Record<string, unknown> | null;
  meta: { ipAddress: string | null; userAgent: string | null };
}

/** The per-operator limiter (429 is not recorded as a refusal — see control-refusal.ts). */
export function limitPolicyGroupWrites(auth: Auth): Promise<NextResponse | null> {
  return limitByUser(auth.user.id, "platform-policy-groups", POLICY_GROUP_WRITE_LIMIT);
}

export async function writeContext(req: NextRequest, auth: Auth, verb: ControlVerb, targetKey: string | null): Promise<WriteContext> {
  const raw = await req.json().catch(() => null);
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  return { auth, verb, targetKey, body, meta: { ipAddress: getClientIp(req), userAgent: req.headers.get("user-agent") } };
}

function reasonCodeOf(body: Record<string, unknown> | null): unknown {
  const r = body?.reason;
  return r && typeof r === "object" ? (r as { code?: unknown }).code : undefined;
}

/** Record the refusal (never the note or values) and return its response. */
export async function refuseWrite(ctx: WriteContext, code: PolicyGroupRefusalCode, error: string, errors?: string[]): Promise<NextResponse> {
  const safeKey = ctx.targetKey && POLICY_GROUP_KEY_PATTERN.test(ctx.targetKey) ? ctx.targetKey : null;
  await recordControlRefusal(ctx.auth, { control: "policy-groups", verb: ctx.verb, code, targetKey: safeKey, reasonCode: reasonCodeOf(ctx.body) }, ctx.meta);
  return NextResponse.json({ error, code, ...(errors ? { errors } : {}) } satisfies PolicyGroupRefusalBody, { status: STATUS[code] });
}

/** The structured reason, or a recorded 400. */
export async function reasonOrRefuse(ctx: WriteContext): Promise<{ reason: OperatorReason } | { refused: NextResponse }> {
  if (!ctx.body) return { refused: await refuseWrite(ctx, "VALIDATION", "A JSON body with a reason { code, note? } is required.") };
  try { return { reason: parseOperatorReason(ctx.body.reason) }; }
  catch (e) {
    return { refused: await refuseWrite(ctx, "VALIDATION", e instanceof OperatorActionValidationError ? e.message : "A reason is required.") };
  }
}

/** A required positive integer field, or null. */
export function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

export function actorOf(ctx: WriteContext): PolicyGroupActor {
  return { ...operatorActorFrom(ctx.auth, "PLATFORM_OPS"), ...ctx.meta };
}
