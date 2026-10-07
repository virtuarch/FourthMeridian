/**
 * POST /api/platform/customer-success/customers/[userId]/cohort  (P1)
 *
 * Add a customer to a rollout cohort. Body: { cohort: string, reason: { code, note? } }.
 * Cohorts are append-only identity; adding an existing one is reported as such.
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE").
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { OperatorActionValidationError, parseOperatorReason } from "@/lib/audit";
import { AssignmentRefusedError, assignCustomerCohort, type AssignCohortResult } from "@/lib/platform/customer/assign";

export const runtime = "nodejs";

export interface AssignCohortResponse { success: true; result: AssignCohortResult }

export async function POST(req: NextRequest, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE");
  if (err) return err;
  const { userId } = await ctx.params;
  const body = await req.json().catch(() => ({})) as { cohort?: unknown; reason?: unknown };
  if (typeof body.cohort !== "string") return NextResponse.json({ error: "cohort must be a string." }, { status: 400 });
  const meta = getRequestMeta(req);
  try {
    const reason = parseOperatorReason(body.reason);
    const result = await assignCustomerCohort({
      userId, cohort: body.cohort, reason,
      actor: { userId: auth.user.id, via: auth.grant ? "PLATFORM_GRANT" : "SYSTEM_ADMIN", area: "CUSTOMER_SUCCESS", ipAddress: meta.ip, userAgent: meta.userAgent },
    });
    return NextResponse.json({ success: true, result } satisfies AssignCohortResponse);
  } catch (e) {
    if (e instanceof OperatorActionValidationError || e instanceof AssignmentRefusedError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
