/**
 * POST /api/platform/platform-ops/policy-groups/[key]/archive  (POLICY EDITOR)
 *
 * Archive a group: it stops being assignable. Never deletes anything.
 * REFUSED while ANY assignment names the group (reassign in Customer Success
 * first — this route never touches an assignment) and for the default group.
 *
 *   body  { reason: { code, note? } }
 *   200   { key, archivedAt }
 *   400   VALIDATION (already archived, reason) · 404 NOT_FOUND
 *   409   CONFLICT (customers assigned) · NOT_EDITABLE (the default group)
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL"); reason
 * required; ONE POLICY_GROUP_ARCHIVED audit row in the same transaction.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { archivePolicyGroup } from "@/lib/platform/policies/policy-groups-write";
import { actorOf, limitPolicyGroupWrites, reasonOrRefuse, refuseWrite, writeContext } from "@/lib/platform/policies/policy-groups-http";

export const runtime = "nodejs";

export interface ArchivePolicyGroupResponse { key: string; archivedAt: string }

export async function POST(req: NextRequest, routeCtx: { params: Promise<{ key: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitPolicyGroupWrites(auth);
  if (limited) return limited;
  const { key } = await routeCtx.params;
  const ctx = await writeContext(req, auth, "archive", key);
  const r = await reasonOrRefuse(ctx);
  if ("refused" in r) return r.refused;

  const result = await archivePolicyGroup({ key, reason: r.reason, actor: actorOf(ctx) });
  if (!result.ok) return refuseWrite(ctx, result.code, result.error, result.errors);
  return NextResponse.json(result.value satisfies ArchivePolicyGroupResponse);
}
