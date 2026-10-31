/**
 * POST /api/platform/growth-revenue/requests/[id]/approve  (Wave 1 S3)
 *
 * Approve a beta-access request = mint a single-use invite + email it, in one
 * step. IDEMPOTENT: only the request that moves PENDING/DENIED → APPROVED mints
 * and e-mails; a repeat or a concurrent second click on an APPROVED row returns
 * 200 { alreadyApproved: true } and sends nothing (I4). Re-sending is the
 * separate /resend route.
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
import { auditEmailHash, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { getClientIp } from "@/lib/api";
import { BetaAccessRequestStatus } from "@prisma/client";

export const runtime = "nodejs";

// 14-day invite TTL (source plan §7.3 — beta queues move slowly).
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
  // A redeemed invite already produced an account — nothing left to approve.
  if (request.status === BetaAccessRequestStatus.REDEEMED) {
    return NextResponse.json({ error: "This request has already been redeemed." }, { status: 409 });
  }

  // I4 (A7, 2026-10-22) — approve is a FIRST decision, idempotent under a double
  // click. It used to rotate the token and re-send on an already-APPROVED row, so
  // two concurrent clicks both returned 200, two invite e-mails went out and the
  // first link died with the rotation. Re-sending is the separate /resend route
  // (BETA_INVITATION_RESENT); approve now transitions only PENDING/DENIED.
  if (request.status === BetaAccessRequestStatus.APPROVED) {
    return NextResponse.json({ success: true, alreadyApproved: true, emailStatus: "skipped" });
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiry = new Date(now.getTime() + INVITE_TTL_MS);

  // IDEMP-011 + I4: the checks above are reads. The status predicate makes the
  // write conditional and the count says which side of a race we are on: only
  // the request that moves PENDING/DENIED → APPROVED mints a token and e-mails.
  const { count } = await db.betaAccessRequest.updateMany({
    where: { id, status: { in: [BetaAccessRequestStatus.PENDING, BetaAccessRequestStatus.DENIED] } },
    data: {
      status:          BetaAccessRequestStatus.APPROVED,
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: expiry,
      invitedAt:       now,
      decidedAt:       now,
      decidedById:     auth.user.id,
    },
  });
  if (count !== 1) {
    // Lost the race: say what the winner left behind, send nothing.
    const now2 = await db.betaAccessRequest.findUnique({ where: { id }, select: { status: true } });
    if (now2?.status === BetaAccessRequestStatus.APPROVED) {
      return NextResponse.json({ success: true, alreadyApproved: true, emailStatus: "skipped" });
    }
    return NextResponse.json({ error: "This request has already been redeemed." }, { status: 409 });
  }

  // Absolute link from the trusted env base (never a request Host header).
  const inviteUrl = buildBetaInviteUrl(env.NEXT_PUBLIC_APP_URL, rawToken);

  // Non-throwing: a delivery failure is recorded (emailStatus) but never fails
  // the approval — the invite exists and can be resent.
  // The email states the REAL expiry just written to the row (issuedAt/expiresAt).
  const emailResult = await sendEmail("beta-invite", request.email, { inviteUrl, issuedAt: now, expiresAt: expiry, origin: "request" });
  if (emailResult.status === "error") {
    console.error("[beta-approve] invite email failed to send:", emailResult.error);
  }

  // SEC-PLAT-2 — through the operator-action envelope (actor, target, result);
  // the legacy metadata keys ride in `detail` so existing readers keep working.
  await recordOperatorAction(db, {
    actor:  operatorActorFrom(auth, "GROWTH_REVENUE"),
    action: AuditAction.BETA_ACCESS_APPROVED,
    target: { kind: "BETA_REQUEST", id },
    result: "SUCCESS",
    detail: { betaRequestId: id, emailHash: auditEmailHash(request.email), emailStatus: emailResult.status },
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json({ success: true, emailStatus: emailResult.status });
}
