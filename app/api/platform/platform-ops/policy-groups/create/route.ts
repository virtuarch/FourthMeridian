/**
 * POST /api/platform/platform-ops/policy-groups/create  (POLICY EDITOR)
 *
 * Create a customer Policy Group — blank from the DEFAULT group's values, or a
 * CLONE of an existing group's current version — optionally with edited values.
 *
 *   body  { key, label, description?, from: "DEFAULT" | <group key>, values?, reason: { code, note? } }
 *   201   { key, version: 1, changes, customersAffected: 0 }
 *   400   { error, code: "VALIDATION", errors? }   bad key / label / values / reason
 *   404   { error, code: "NOT_FOUND" }             the source group does not exist
 *   409   { error, code: "CONFLICT" }              the key already exists
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — owner
 * ruling: CONTROL to create, edit, clone, archive or otherwise modify customer
 * policy groups. Reason required; ONE POLICY_GROUP_CREATED audit row in the
 * same transaction (lib/platform/policies/policy-groups-write.ts). Refusals
 * after the grant are recorded (PLATFORM_CONTROL_REFUSED, never the note).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { createPolicyGroup, type PolicyGroupWritten } from "@/lib/platform/policies/policy-groups-write";
import { actorOf, limitPolicyGroupWrites, reasonOrRefuse, refuseWrite, writeContext } from "@/lib/platform/policies/policy-groups-http";

export const runtime = "nodejs";

export type CreatePolicyGroupResponse = PolicyGroupWritten;

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitPolicyGroupWrites(auth);
  if (limited) return limited;
  const ctx0 = await writeContext(req, auth, "create", null);
  const ctx = { ...ctx0, targetKey: typeof ctx0.body?.key === "string" ? ctx0.body.key : null };
  const r = await reasonOrRefuse(ctx);
  if ("refused" in r) return r.refused;
  const from = ctx.body!.from;
  if (typeof from !== "string" || from.length === 0) return refuseWrite(ctx, "VALIDATION", 'from is required: "DEFAULT" or the key of the group to clone.');

  const result = await createPolicyGroup({
    key: ctx.body!.key, label: ctx.body!.label, description: ctx.body!.description, from,
    ...(ctx.body!.values !== undefined ? { values: ctx.body!.values } : {}),
    reason: r.reason, actor: actorOf(ctx),
  });
  if (!result.ok) return refuseWrite(ctx, result.code, result.error, result.errors);
  return NextResponse.json(result.value satisfies CreatePolicyGroupResponse, { status: 201 });
}
