/**
 * POST /api/platform/platform-ops/policy-groups/[key]/default  (POLICY EDITOR)
 *
 * Make this group the DEFAULT — the group NEW registrations receive (and the
 * Beta reconciliation assigns). It NEVER changes an existing assignment: no
 * customer moves. Refused for an archived or invalid group.
 *
 *   body  { expectedDefaultKey, reason: { code, note? } }
 *   200   { key, previousDefault }
 *   400   VALIDATION (already default, invalid definition, reason) · 404 NOT_FOUND
 *   409   CONFLICT (the default moved since it was read) · NOT_EDITABLE (archived)
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL"); reason
 * required; ONE POLICY_GROUP_DEFAULT_CHANGED audit row in the same transaction.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { setDefaultPolicyGroup } from "@/lib/platform/policies/policy-groups-write";
import { actorOf, limitPolicyGroupWrites, reasonOrRefuse, refuseWrite, writeContext } from "@/lib/platform/policies/policy-groups-http";

export const runtime = "nodejs";

export interface SetDefaultPolicyGroupResponse { key: string; previousDefault: string }

export async function POST(req: NextRequest, routeCtx: { params: Promise<{ key: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitPolicyGroupWrites(auth);
  if (limited) return limited;
  const { key } = await routeCtx.params;
  const ctx = await writeContext(req, auth, "default", key);
  const r = await reasonOrRefuse(ctx);
  if ("refused" in r) return r.refused;
  const expectedDefaultKey = ctx.body!.expectedDefaultKey;
  if (typeof expectedDefaultKey !== "string" || expectedDefaultKey.length === 0) {
    return refuseWrite(ctx, "VALIDATION", "expectedDefaultKey is required: the default you saw.");
  }

  const result = await setDefaultPolicyGroup({ key, expectedDefaultKey, reason: r.reason, actor: actorOf(ctx) });
  if (!result.ok) return refuseWrite(ctx, result.code, result.error, result.errors);
  return NextResponse.json(result.value satisfies SetDefaultPolicyGroupResponse);
}
