/**
 * /api/platform/platform-ops/policy-groups/[key]/lifecycle  (BETA LIFECYCLE L1)
 *
 *   GET   the group's lifecycle state, cost freeze, member COUNTS and the
 *         append-only transition history.
 *         → 200 PolicyGroupLifecycleResponse | 404 { error }
 *   POST  one lifecycle transition.
 *         body  { action: "pause" | "resume" | "end" | "freeze" | "unfreeze",
 *                 reason: { code, note? }, expectedVersion? }
 *         (resume from ENDED — "reopen" — requires reason.note)
 *         → 200 { key, kind, from, to, lifecycleVersion, transitionId, membersAffected, isDefault }
 *         → 400 VALIDATION (action / reason / note required / expectedVersion)
 *         → 404 NOT_FOUND · 409 CONFLICT (invalid transition, stale expectedVersion)
 *         → 409 NOT_EDITABLE (archived)
 *
 * AUTHORIZATION
 *   GET   requirePlatformAccess("PLATFORM_OPS", "READ")
 *   POST  requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL") — owner
 *         decisions 2026-10-31; operator reason; rate limited; ONE transaction
 *         with the row lock, the transition row and the audit row
 *         (lib/platform/policies/policy-group-lifecycle-write.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { isLifecycleAction } from "@/lib/entitlements/lifecycle";
import { readPolicyGroupLifecycle, type PolicyGroupLifecycleResponse } from "@/lib/platform/policies/policy-group-lifecycle-read";
import { transitionPolicyGroupLifecycle, type LifecycleTransitioned } from "@/lib/platform/policies/policy-group-lifecycle-write";
import { actorOf, limitPolicyGroupWrites, reasonOrRefuse, refuseWrite, writeContext } from "@/lib/platform/policies/policy-groups-http";

export const runtime = "nodejs";

export type { PolicyGroupLifecycleResponse } from "@/lib/platform/policies/policy-group-lifecycle-read";
export type PolicyGroupLifecycleTransitionResponse = LifecycleTransitioned;

type Ctx = { params: Promise<{ key: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  const { key } = await ctx.params;
  const state = await readPolicyGroupLifecycle(key);
  if (!state) return NextResponse.json({ error: "No such policy group." }, { status: 404 });
  return NextResponse.json(state satisfies PolicyGroupLifecycleResponse, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, routeCtx: Ctx) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL");
  if (err) return err;
  const limited = await limitPolicyGroupWrites(auth);
  if (limited) return limited;
  const { key } = await routeCtx.params;
  const ctx = await writeContext(req, auth, "change", key);
  const action = ctx.body?.action;
  if (!isLifecycleAction(action)) return refuseWrite(ctx, "VALIDATION", "action must be one of pause, resume, end, freeze, unfreeze.");
  ctx.verb = action; // refusals past here are recorded under the lifecycle verb
  const r = await reasonOrRefuse(ctx);
  if ("refused" in r) return r.refused;
  const ev = ctx.body!.expectedVersion;
  if (ev !== undefined && !(typeof ev === "number" && Number.isInteger(ev) && ev >= 0)) {
    return refuseWrite(ctx, "VALIDATION", "expectedVersion must be the lifecycle version you reviewed (a whole number ≥ 0).");
  }

  const result = await transitionPolicyGroupLifecycle({
    key, action, ...(ev !== undefined ? { expectedVersion: ev as number } : {}), reason: r.reason, actor: actorOf(ctx),
  });
  if (!result.ok) return refuseWrite(ctx, result.code, result.error, result.errors);
  return NextResponse.json(result.value satisfies PolicyGroupLifecycleTransitionResponse);
}
