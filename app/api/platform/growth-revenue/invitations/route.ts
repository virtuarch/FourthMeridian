/**
 * POST /api/platform/growth-revenue/invitations  (PO-3C · direct operator invite)
 *
 * Operator-initiated ("cold") invite: issue an email-bound, single-use invitation
 * to an address that never submitted a request. Reuses the SAME invite primitives
 * as approve (hashResetToken + beta-invite template + buildBetaInviteUrl) — no
 * second invite system, no transferable link. Idempotent per email via upsert on
 * the BetaAccessRequest unique email; a live account for that email is rejected
 * (409) since there is nothing to invite.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE").
 * AUDIT: BETA_INVITATION_CREATED { betaRequestId, email, emailStatus, expiresDays }.
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRES_DAYS = 7; // direct invites default to 7 days (mission §4)
const MAX_EXPIRES_DAYS = 30;

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const body = await req.json().catch(() => ({}));
  const rawEmail = (body as { email?: unknown }).email;
  const rawDays  = (body as { expiresDays?: unknown }).expiresDays;

  if (typeof rawEmail !== "string" || !EMAIL_RE.test(rawEmail.trim())) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  const email = rawEmail.toLowerCase().trim();
  const expiresDays = Number.isFinite(rawDays)
    ? Math.min(MAX_EXPIRES_DAYS, Math.max(1, Math.floor(rawDays as number)))
    : DEFAULT_EXPIRES_DAYS;

  // An existing account can't be beta-invited — they already have access.
  const existingUser = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    return NextResponse.json({ error: "That email already has a Fourth Meridian account." }, { status: 409 });
  }
  // Don't re-invite an already-redeemed request (an account was created from it).
  const existing = await db.betaAccessRequest.findUnique({ where: { email }, select: { status: true } });
  if (existing?.status === BetaAccessRequestStatus.REDEEMED) {
    return NextResponse.json({ error: "That invitation was already redeemed." }, { status: 409 });
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiry = new Date(now.getTime() + expiresDays * DAY_MS);

  const request = await db.betaAccessRequest.upsert({
    where:  { email },
    update: {
      status:          BetaAccessRequestStatus.APPROVED,
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: expiry,
      invitedAt:       now,
      decidedAt:       now,
      decidedById:     auth.user.id,
    },
    create: {
      email,
      status:          BetaAccessRequestStatus.APPROVED,
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: expiry,
      invitedAt:       now,
      decidedAt:       now,
      decidedById:     auth.user.id,
    },
    select: { id: true },
  });

  const inviteUrl = buildBetaInviteUrl(env.NEXT_PUBLIC_APP_URL, rawToken);
  const emailResult = await sendEmail("beta-invite", email, { inviteUrl });
  if (emailResult.status === "error") {
    console.error("[beta-invite-direct] invite email failed to send:", emailResult.error);
  }

  await db.auditLog.create({
    data: {
      userId:             auth.user.id,
      performedByAdminId: auth.user.id,
      action:             AuditAction.BETA_INVITATION_CREATED,
      metadata:           { betaRequestId: request.id, email, emailStatus: emailResult.status, expiresDays },
    },
  });

  return NextResponse.json({ success: true, emailStatus: emailResult.status });
}
