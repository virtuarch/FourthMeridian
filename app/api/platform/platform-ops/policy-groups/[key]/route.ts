/**
 * /api/platform/platform-ops/policy-groups/[key]  (POLICY EDITOR)
 *
 *   GET    one group for the editor: current definition, immutable version
 *          history, customer COUNTS (incl. overlay / allowance buckets), the
 *          effective preview (plain and with Founder) and the estimated AI
 *          spend ceiling. Counts only, never a customer identity.
 *          → 200 PolicyGroupDetailResponse | 404 { error }
 *   PATCH  edit — a NEW immutable version.
 *          body  { expectedVersion, values, label?, description?, reason: { code, note? } }
 *          → 200 { key, version, changes, customersAffected }
 *          → 400 VALIDATION (values / label / reason / nothing changed)
 *          → 404 NOT_FOUND · 409 CONFLICT (stale expectedVersion) · 409 NOT_EDITABLE (archived)
 *
 * AUTHORIZATION
 *   GET    requirePlatformAccess("PLATFORM_OPS", "READ")
 *   PATCH  requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — owner ruling:
 *          CONTROL + reason + audit for every policy-group modification.
 * Every rule lives in lib/platform/policies/policy-groups-write.ts (one
 * transaction, one POLICY_GROUP_UPDATED audit row).
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { readPolicyGroupDetail, type PolicyGroupDetailResponse } from "@/lib/platform/policies/policy-group-detail";
import { updatePolicyGroup, type PolicyGroupWritten } from "@/lib/platform/policies/policy-groups-write";
import { actorOf, limitPolicyGroupWrites, positiveInt, reasonOrRefuse, refuseWrite, writeContext } from "@/lib/platform/policies/policy-groups-http";

export const runtime = "nodejs";

export type { PolicyGroupDetailResponse } from "@/lib/platform/policies/policy-group-detail";
export type UpdatePolicyGroupResponse = PolicyGroupWritten;

type Ctx = { params: Promise<{ key: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const { key } = await ctx.params;
  const detail = await readPolicyGroupDetail(key);
  if (!detail) return NextResponse.json({ error: "No such policy group." }, { status: 404 });
  return NextResponse.json(detail satisfies PolicyGroupDetailResponse);
}

export async function PATCH(req: NextRequest, routeCtx: Ctx) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitPolicyGroupWrites(auth);
  if (limited) return limited;
  const { key } = await routeCtx.params;
  const ctx = await writeContext(req, auth, "change", key);
  const r = await reasonOrRefuse(ctx);
  if ("refused" in r) return r.refused;
  const expectedVersion = positiveInt(ctx.body!.expectedVersion);
  if (expectedVersion === null) return refuseWrite(ctx, "VALIDATION", "expectedVersion is required: the version you reviewed.");
  if (ctx.body!.values === undefined) return refuseWrite(ctx, "VALIDATION", "values is required: every entitlement.");

  const result = await updatePolicyGroup({
    key, expectedVersion, values: ctx.body!.values,
    ...(ctx.body!.label !== undefined ? { label: ctx.body!.label } : {}),
    ...(ctx.body!.description !== undefined ? { description: ctx.body!.description } : {}),
    reason: r.reason, actor: actorOf(ctx),
  });
  if (!result.ok) return refuseWrite(ctx, result.code, result.error, result.errors);
  return NextResponse.json(result.value satisfies UpdatePolicyGroupResponse);
}
