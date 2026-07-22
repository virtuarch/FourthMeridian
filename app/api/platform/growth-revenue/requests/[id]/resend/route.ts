/**
 * POST /api/platform/growth-revenue/requests/[id]/resend  (PO-3B · B1-C)
 *
 * Resend the invitation for an already-APPROVED beta request: rotate the
 * single-use token in place and re-email it. Reuses the SAME invite primitives
 * as approve (hashResetToken + beta-invite template + buildBetaInviteUrl) — NOT a
 * second invite system — preserving email-binding (enforced at redemption),
 * hashing, single-use, and the 14-day expiry.
 *
 * Distinct from approve so the action reads honestly in the audit trail:
 * BETA_INVITATION_RESENT (approve is for a first decision on a PENDING request).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { hashResetToken } from "@/lib/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { buildBetaInviteUrl } from "@/lib/email/beta-invite-url";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { BetaAccessRequestStatus } from "@prisma/client";

export const runtime = "nodejs";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
  // Resend only makes sense for a live (un-redeemed) invitation.
  if (request.status !== BetaAccessRequestStatus.APPROVED) {
    return NextResponse.json(
      { error: "Only an approved, un-redeemed invitation can be resent." },
      { status: 409 },
    );
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  await db.betaAccessRequest.update({
    where: { id },
    data: {
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      invitedAt:       now,
    },
  });

  const inviteUrl = buildBetaInviteUrl(env.NEXT_PUBLIC_APP_URL, rawToken);
  const emailResult = await sendEmail("beta-invite", request.email, { inviteUrl });
  if (emailResult.status === "error") {
    console.error("[beta-resend] invite email failed to send:", emailResult.error);
  }

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.BETA_INVITATION_RESENT,
      metadata:           { betaRequestId: id, email: request.email, emailStatus: emailResult.status },
    },
  });

  return NextResponse.json({ success: true, emailStatus: emailResult.status });
}
