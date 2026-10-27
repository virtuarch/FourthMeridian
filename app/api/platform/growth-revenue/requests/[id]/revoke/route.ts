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
import { OperatorActionValidationError, auditEmailHash, parseOperatorReason, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { BetaAccessRequestStatus } from "@prisma/client";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  // SEC-PLAT-2 — a consequential action: the structured reason is parsed FIRST,
  // so a request without one never reaches the database.
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  let reason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

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

  await db.$transaction(async (tx) => {
    // Null the token + expiry (kills the invite), flip to DENIED. Users/access untouched.
    await tx.betaAccessRequest.update({
      where: { id },
      data: {
        status:          BetaAccessRequestStatus.DENIED,
        inviteTokenHash: null,
        inviteExpiresAt: null,
        decidedAt:       new Date(),
        decidedById:     auth.user.id,
      },
    });

    // SEC-PLAT-2 — through the operator-action envelope (actor, target, result, reason);
    // the legacy metadata keys ride in `detail` so existing readers keep working.
    await recordOperatorAction(tx, {
      actor:  operatorActorFrom(auth, "GROWTH_REVENUE"),
      action: AuditAction.BETA_INVITATION_REVOKED,
      target: { kind: "BETA_REQUEST", id },
      reason,
      result: "SUCCESS",
      detail: { betaRequestId: id, emailHash: auditEmailHash(request.email) },
      ipAddress: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
  });

  return NextResponse.json({ success: true });
}
