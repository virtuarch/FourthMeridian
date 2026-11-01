/**
 * POST /api/platform/platform-ops/policy-groups/[key]/rollback  (POLICY EDITOR)
 *
 * Restore an earlier version — as a NEW version whose values (and label /
 * description) equal it. History is append-only: nothing is rewritten.
 *
 *   body  { expectedVersion, toVersion, reason: { code, note? } }
 *   200   { key, version, changes, customersAffected }
 *   400   VALIDATION (toVersion not earlier, not valid under today's ceilings, nothing changed, reason)
 *   404   NOT_FOUND · 409 CONFLICT (stale expectedVersion) · 409 NOT_EDITABLE (archived)
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL"); reason
 * required; ONE POLICY_GROUP_ROLLED_BACK audit row in the same transaction.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { rollbackPolicyGroup, type PolicyGroupWritten } from "@/lib/platform/policies/policy-groups-write";
import { actorOf, limitPolicyGroupWrites, positiveInt, reasonOrRefuse, refuseWrite, writeContext } from "@/lib/platform/policies/policy-groups-http";

export const runtime = "nodejs";

export type RollbackPolicyGroupResponse = PolicyGroupWritten;

export async function POST(req: NextRequest, routeCtx: { params: Promise<{ key: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitPolicyGroupWrites(auth);
  if (limited) return limited;
  const { key } = await routeCtx.params;
  const ctx = await writeContext(req, auth, "rollback", key);
  const r = await reasonOrRefuse(ctx);
  if ("refused" in r) return r.refused;
  const expectedVersion = positiveInt(ctx.body!.expectedVersion);
  const toVersion = positiveInt(ctx.body!.toVersion);
  if (expectedVersion === null || toVersion === null) return refuseWrite(ctx, "VALIDATION", "expectedVersion and toVersion are required.");

  const result = await rollbackPolicyGroup({ key, expectedVersion, toVersion, reason: r.reason, actor: actorOf(ctx) });
  if (!result.ok) return refuseWrite(ctx, result.code, result.error, result.errors);
  return NextResponse.json(result.value satisfies RollbackPolicyGroupResponse);
}
