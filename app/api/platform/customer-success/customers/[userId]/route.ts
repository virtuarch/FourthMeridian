/**
 * GET /api/platform/customer-success/customers/[userId]  (P1 — customer spine, detail)
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). One customer:
 * identity, cohorts, policy + effective entitlements with provenance, beta
 * lifecycle, Spaces, activity, connections + health, incidents, AI usage
 * (estimate), operator actions, and the safe actions available.
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getCustomerDetail, type CustomerDetail } from "@/lib/platform/customer/customer-detail";

export const runtime = "nodejs";

export type CustomerDetailResponse = CustomerDetail;

export async function GET(_req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const { userId } = await ctx.params;
  const detail = await getCustomerDetail(userId);
  if (!detail) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json(detail satisfies CustomerDetailResponse);
}
