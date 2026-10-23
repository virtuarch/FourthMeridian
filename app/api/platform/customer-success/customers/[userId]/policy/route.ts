/**
 * POST /api/platform/customer-success/customers/[userId]/policy  (P1)
 *
 * Assign a customer's Policy Group and/or overlay, and/or (AI COST CONTROLS) set or
 * remove their per-customer daily AI allowance override. Body:
 *   { policyGroup?: string, overlay?: string | null,
 *     aiDailyUsdAllowanceOverride?: number | null,   // null = remove; integer 1 … ceiling; above ⇒ 400
 *     reason: { code, note? } }
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE") — the
 * fresh (live-revocation-checked) variant every platform mutation uses. The
 * assignment service writes the operator-action audit row in the SAME
 * transaction; a missing or unsafe reason is a 400 and nothing changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { AssignmentRefusedError, assignCustomerPolicy } from "@/lib/platform/customer/assign";
import { projectPolicy, type CustomerPolicyView } from "@/lib/platform/customer/customer-core";

export const runtime = "nodejs";

export interface AssignPolicyResponse { success: true; policy: CustomerPolicyView }

export async function POST(req: NextRequest, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE");
  if (err) return err;
  const { userId } = await ctx.params;
  const body = await req.json().catch(() => ({})) as { policyGroup?: unknown; overlay?: unknown; aiDailyUsdAllowanceOverride?: unknown; reason?: unknown };
  if (body.policyGroup !== undefined && typeof body.policyGroup !== "string") return NextResponse.json({ error: "policyGroup must be a string." }, { status: 400 });
  if (body.overlay !== undefined && body.overlay !== null && typeof body.overlay !== "string") return NextResponse.json({ error: "overlay must be a string or null." }, { status: 400 });
  if (body.aiDailyUsdAllowanceOverride !== undefined && body.aiDailyUsdAllowanceOverride !== null && typeof body.aiDailyUsdAllowanceOverride !== "number") {
    return NextResponse.json({ error: "aiDailyUsdAllowanceOverride must be a whole number of dollars or null." }, { status: 400 });
  }
  const meta = getRequestMeta(req);
  try {
    const reason = parseOperatorReason(body.reason);
    const effective = await assignCustomerPolicy({
      userId,
      ...(body.policyGroup !== undefined ? { policyGroup: body.policyGroup as string } : {}),
      ...(body.overlay !== undefined ? { overlay: body.overlay as string | null } : {}),
      ...(body.aiDailyUsdAllowanceOverride !== undefined ? { aiDailyUsdAllowanceOverride: body.aiDailyUsdAllowanceOverride as number | null } : {}),
      reason,
      actor: { userId: auth.user.id, via: auth.grant ? "PLATFORM_GRANT" : "SYSTEM_ADMIN", area: "CUSTOMER_SUCCESS", ipAddress: meta.ip, userAgent: meta.userAgent },
    });
    return NextResponse.json({ success: true, policy: projectPolicy(effective) } satisfies AssignPolicyResponse);
  } catch (e) {
    if (e instanceof OperatorActionValidationError || e instanceof AssignmentRefusedError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
