/**
 * POST /api/platform/growth-revenue/requests/[id]/extend  (PR B · audited extend)
 *
 * Move an issued invitation's expiry to now + `validityDays` (1–30) WITHOUT
 * rotating its token: the link already emailed keeps working, and no email is
 * sent. The explicit workflow the owner requires for changing an invitation
 * that was already issued (changing the validity setting never does).
 *
 *   body { validityDays, reason }
 *   - APPROVED only (409 NOT_APPROVED otherwise);
 *   - conditional on the status, token hash and expiry read, so a concurrent
 *     resend / revoke / extend makes this 409 CONFLICT and write nothing;
 *   - BETA_INVITATION_EXTENDED (reason required) with before/after expiry, in
 *     the same transaction as the write.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 */

import { NextRequest, NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { extendBetaInvitation } from "@/lib/platform/growth/invitation-issue";
import { parseRequiredReason } from "@/lib/platform/growth/invitation-http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { validityDays?: unknown; reason?: unknown };
  const reason = parseRequiredReason(body.reason);
  if (!reason.ok) return reason.response;

  const r = await extendBetaInvitation({
    client: systemDb,
    actor: operatorActorFrom(auth, "GROWTH_REVENUE"),
    requestId: id,
    validityDays: body.validityDays,
    reason: reason.reason,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status });
  return NextResponse.json({ success: true, validityDays: r.validityDays, expiresAt: r.expiresAt.toISOString() });
}
