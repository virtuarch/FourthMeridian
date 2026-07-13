/**
 * POST /api/auth/forgot-password
 *
 * Generates a password-reset token, stores a hashed version in the DB (1h TTL),
 * and delivers the reset link via the transactional email seam (OPS-1 S2a).
 *
 * DELIVERY: sendEmail("password-reset", …) — the real Resend transport in
 * production, the capture transport in dev/test (no credentials needed). The
 * absolute reset URL is built from the trusted env base (NEXT_PUBLIC_APP_URL),
 * never from a request Host header.
 *
 * DEV MODE: additionally returns the resetUrl in the response body so the flow
 * is usable locally without a real inbox. This branch is gated strictly on
 * NODE_ENV !== "production"; the production response is generic and NEVER
 * contains the token.
 *
 * Body: { identifier: string }  — accepts email OR username
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { hashResetToken } from "@/lib/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { buildResetUrl } from "@/lib/email/reset-url";
import { limitByIp } from "@/lib/rate-limit";
import { AuditAction } from "@/lib/audit-actions";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "forgot-password", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    const { identifier } = await req.json();
    if (!identifier?.trim()) {
      return NextResponse.json({ error: "Email or username is required." }, { status: 400 });
    }

    const normalized = identifier.toLowerCase().trim();

    const user = await db.user.findFirst({
      where: {
        OR: [
          { email:    normalized },
          { username: normalized },
        ],
      },
      select: { id: true, email: true },
    });

    // Always return 200 — don't reveal whether the account exists
    if (!user) {
      return NextResponse.json({
        success: true,
        // DEV only — in prod this message is all that's returned
        message: "If an account exists, a reset link has been sent.",
      });
    }

    // Generate a cryptographically random token. Only the hash is persisted —
    // rawToken exists solely in this response/email and is never stored.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiry   = new Date(Date.now() + TOKEN_TTL_MS);

    await db.user.update({
      where: { id: user.id },
      data:  { passwordResetToken: hashResetToken(rawToken), passwordResetExpiry: expiry },
    });

    // Absolute link, built from the trusted env base (never the request Host).
    const resetUrl = buildResetUrl(env.NEXT_PUBLIC_APP_URL, rawToken);

    // Deliver via the email seam. Non-throwing: a provider failure yields an
    // error status we record for ops, but never fails the request or reveals
    // account existence to the caller.
    const emailResult = await sendEmail("password-reset", user.email, { resetUrl });
    if (emailResult.status === "error") {
      console.error("[forgot-password] reset email failed to send:", emailResult.error);
    }

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        metadata: { email: user.email, emailStatus: emailResult.status },
      },
    });

    // ── DEV MODE ONLY ─────────────────────────────────────────────────────────
    // Expose the resetUrl for DX ONLY when no real email was delivered — i.e.
    // the capture transport ran (captured/skipped) or the send errored. A real
    // Resend send ("sent") withholds the link so the dev panel disappears.
    // Gated on NODE_ENV — production never returns it regardless of status.
    const exposeDevUrl =
      process.env.NODE_ENV !== "production" && emailResult.status !== "sent";

    return NextResponse.json({
      success: true,
      message: exposeDevUrl
        ? "DEV MODE: use the resetUrl below — in production this would be emailed."
        : "If an account exists, a reset link has been sent.",
      ...(exposeDevUrl && { resetUrl }),
    });
  } catch (err) {
    console.error("[forgot-password] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
