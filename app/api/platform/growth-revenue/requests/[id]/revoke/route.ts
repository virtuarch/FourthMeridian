/**
 * POST /api/platform/growth-revenue/requests/[id]/revoke  (PO-3B · B1-C)
 *
 * Revoke an already-issued invitation: null the single-use token so it can no
 * longer be redeemed, and move the request to DENIED. Revocation touches ONLY
 * the invitation — it does not delete the user (there is none yet — the invite is
 * pre-account) and does not remove any existing access. If the invite was already
 * redeemed, an account exists and there is nothing to revoke (409).
 *
 * Distinct from deny (which decides a PENDING request) so the trail reads
 * honestly: BETA_INVITATION_REVOKED. Because invitedAt is already set, the
 * PO-3A invitation-lifecycle count (revoked = DENIED ∧ invitedAt != null) picks
 * it up as a revoked invitation, not a plain denial.
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
  if (request.status === BetaAccessRequestStatus.REDEEMED) {
    return NextResponse.json(
      { error: "This invitation was already redeemed — an account exists; there is nothing to revoke." },
      { status: 409 },
    );
  }

  // Null the token + expiry (kills the invite), flip to DENIED. Users/access untouched.
  await db.betaAccessRequest.update({
    where: { id },
    data: {
      status:          BetaAccessRequestStatus.DENIED,
      inviteTokenHash: null,
      inviteExpiresAt: null,
      decidedAt:       new Date(),
      decidedById:     auth.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.BETA_INVITATION_REVOKED,
      metadata:           { betaRequestId: id, email: request.email },
    },
  });

  return NextResponse.json({ success: true });
}
