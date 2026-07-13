/**
 * POST /api/platform/growth-revenue/requests/[id]/approve  (Wave 1 S3)
 *
 * Approve a beta-access request = mint a single-use invite + email it, in one
 * step. Also serves RESEND: calling it again on an already-APPROVED request
 * rotates the token in place and re-sends (updating invitedAt), which is the
 * product rule (one outstanding invite per request — no token table).
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE") — the
 * fresh (live-revocation-checked) variant, required for every platform mutation
 * (lib/platform/authorize.ts:131).
 *
 * TOKEN: crypto.randomBytes(32), SHA-256-hashed at rest (the password-reset
 * pattern), 14-day expiry. Only the hash is persisted; the raw token lives only
 * in the outbound invite URL. The invite is email-bound at redemption time by
 * the register route.
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

// 14-day invite TTL (source plan §7.3 — beta queues move slowly).
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
  // A redeemed invite already produced an account — nothing left to approve.
  if (request.status === BetaAccessRequestStatus.REDEEMED) {
    return NextResponse.json({ error: "This request has already been redeemed." }, { status: 409 });
  }

  // Mint / rotate the invite token (rotation covers resend on an APPROVED row).
  const rawToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiry = new Date(now.getTime() + INVITE_TTL_MS);

  await db.betaAccessRequest.update({
    where: { id },
    data: {
      status:          BetaAccessRequestStatus.APPROVED,
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: expiry,
      invitedAt:       now,
      decidedAt:       now,
      decidedById:     auth.user.id,
    },
  });

  // Absolute link from the trusted env base (never a request Host header).
  const inviteUrl = buildBetaInviteUrl(env.NEXT_PUBLIC_APP_URL, rawToken);

  // Non-throwing: a delivery failure is recorded (emailStatus) but never fails
  // the approval — the invite exists and can be resent.
  const emailResult = await sendEmail("beta-invite", request.email, { inviteUrl });
  if (emailResult.status === "error") {
    console.error("[beta-approve] invite email failed to send:", emailResult.error);
  }

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.BETA_ACCESS_APPROVED,
      metadata:           { betaRequestId: id, email: request.email, emailStatus: emailResult.status },
    },
  });

  return NextResponse.json({ success: true, emailStatus: emailResult.status });
}
