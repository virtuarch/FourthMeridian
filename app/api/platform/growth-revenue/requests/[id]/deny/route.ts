/**
 * POST /api/platform/growth-revenue/requests/[id]/deny  (Wave 1 S3)
 *
 * Deny a beta-access request = status flip + audit only. NO email: silent
 * denial is the norm for beta queues (source plan §7.4), and the public
 * access-request response never discloses status anyway, so a courtesy email
 * would be the only thing that could leak a decision.
 *
 * Denying also revokes any outstanding invite (nulls the token/expiry) so a
 * previously-approved-then-denied request can no longer be redeemed.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { BetaAccessRequestStatus } from "@prisma/client";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const { id } = await ctx.params;

  const request = await db.betaAccessRequest.findUnique({
    where:  { id },
    select: { id: true, email: true, status: true },
  });
  if (!request) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }
  // A redeemed invite already produced an account — denying it is meaningless.
  if (request.status === BetaAccessRequestStatus.REDEEMED) {
    return NextResponse.json({ error: "This request has already been redeemed." }, { status: 409 });
  }

  await db.betaAccessRequest.update({
    where: { id },
    data: {
      status:          BetaAccessRequestStatus.DENIED,
      decidedAt:       new Date(),
      decidedById:     auth.user.id,
      inviteTokenHash: null, // revoke any outstanding invite
      inviteExpiresAt: null,
    },
  });

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.BETA_ACCESS_DENIED,
      metadata:           { betaRequestId: id, email: request.email },
    },
  });

  return NextResponse.json({ success: true });
}
