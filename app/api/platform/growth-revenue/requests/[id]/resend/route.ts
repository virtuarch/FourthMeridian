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
import { auditEmailHash, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { BetaAccessRequestStatus } from "@prisma/client";

export const runtime = "nodejs";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Which copy the re-sent email uses. "direct" ONLY on positive evidence that the
 * row came from an operator's direct invite with no request behind it:
 *   - a BETA_INVITATION_CREATED audit row targets this request, AND
 *   - no BETA_ACCESS_APPROVED audit row does (it was never approved from the queue), AND
 *   - no BetaAccessRequestEvent exists for the email (no form submission recorded).
 * Anything else — including rows whose audit history is gone, and requests that
 * predate submission events (2026-10-07) — is "request", the historical copy.
 */
async function inviteOrigin(id: string, email: string): Promise<"request" | "direct"> {
  const byRequest = (action: string) => ({ action, metadata: { path: ["betaRequestId"], equals: id } });
  const [created, approved, submissions] = await Promise.all([
    db.auditLog.findFirst({ where: byRequest(AuditAction.BETA_INVITATION_CREATED), select: { id: true } }),
    db.auditLog.findFirst({ where: byRequest(AuditAction.BETA_ACCESS_APPROVED), select: { id: true } }),
    db.betaAccessRequestEvent.count({ where: { email } }),
  ]);
  return created && !approved && submissions === 0 ? "direct" : "request";
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
  const expiry = new Date(now.getTime() + INVITE_TTL_MS);
  await db.betaAccessRequest.update({
    where: { id },
    data: {
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: expiry,
      invitedAt:       now,
    },
  });

  const inviteUrl = buildBetaInviteUrl(env.NEXT_PUBLIC_APP_URL, rawToken);
  const origin = await inviteOrigin(id, request.email);
  // The email states the REAL expiry just written to the row (issuedAt/expiresAt).
  const emailResult = await sendEmail("beta-invite", request.email, { inviteUrl, issuedAt: now, expiresAt: expiry, origin });
  if (emailResult.status === "error") {
    console.error("[beta-resend] invite email failed to send:", emailResult.error);
  }

  // SEC-PLAT-2 — through the operator-action envelope (actor, target, result);
  // the legacy metadata keys ride in `detail` so existing readers keep working.
  await recordOperatorAction(db, {
    actor:  operatorActorFrom(auth, "GROWTH_REVENUE"),
    action: AuditAction.BETA_INVITATION_RESENT,
    target: { kind: "BETA_REQUEST", id },
    result: "SUCCESS",
    detail: { betaRequestId: id, emailHash: auditEmailHash(request.email), emailStatus: emailResult.status },
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json({ success: true, emailStatus: emailResult.status });
}
