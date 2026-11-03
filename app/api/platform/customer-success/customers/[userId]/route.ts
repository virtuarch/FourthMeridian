/**
 * GET /api/platform/customer-success/customers/[userId]  (P1 — customer spine, detail)
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ"). One customer:
 * identity, cohorts, policy + effective entitlements with provenance, beta
 * lifecycle, Spaces, activity, connections + health, incidents, AI usage
 * (estimate), operator actions, and the safe actions available.
 */

import { NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { getCustomerDetail, type CustomerDetail } from "@/lib/platform/customer/customer-detail";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";

export const runtime = "nodejs";

export type CustomerDetailResponse = CustomerDetail;

export async function GET(req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  const { userId } = await ctx.params;
  // PB-1 Phase 2 — the incident tier follows THIS guard result (never a parameter).
  const incidentToken = incidentAudienceFor(auth);
  if (!incidentToken || incidentToken.audience !== "CUSTOMER_SUCCESS") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const detail = await getCustomerDetail(userId, incidentToken);
  if (!detail) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  // SEC-PLAT-3 (owner ruling P-4) — this is the authorized, AUDITED identity
  // view: the read is recorded BEFORE the profile leaves the server, and a
  // failed audit write refuses the view (fail closed) rather than serving it
  // unaudited. Facts only: operator, customer, surface — never profile content.
  try {
    await recordOperatorAction(systemDb, {
      actor:  operatorActorFrom(auth, "CUSTOMER_SUCCESS"),
      action: AuditAction.CUSTOMER_PROFILE_VIEWED,
      target: { kind: "USER", id: userId },
      result: "SUCCESS",
      detail: { surface: "customer-detail" },
      ipAddress: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
  } catch (e) {
    console.error("[cs-customer-detail] profile-access audit failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "This profile can't be shown right now because access could not be recorded." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(detail satisfies CustomerDetailResponse, { headers: { "Cache-Control": "no-store" } });
}
