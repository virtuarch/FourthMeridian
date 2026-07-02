/**
 * POST /api/auth/forgot-password
 *
 * Generates a password-reset token and stores a hashed version in the DB.
 * Token expires in 1 hour.
 *
 * DEV MODE: Returns the reset URL directly in the response (no email server needed).
 * PRODUCTION TODO: Replace the response with an email delivery and return only
 *   { success: true, message: "Check your email." }
 *
 * Body: { identifier: string }  — accepts email OR username
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";
import { limitByIp } from "@/lib/rate-limit";

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

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: "PASSWORD_RESET_REQUESTED",
        metadata: { email: user.email },
      },
    });

    const resetUrl = `/reset-password?token=${rawToken}`;

    // ── DEV MODE ONLY ─────────────────────────────────────────────────────────
    // In production, send the reset link via email and remove resetUrl from response.
    const isDev = process.env.NODE_ENV !== "production";

    return NextResponse.json({
      success: true,
      message: isDev
        ? "DEV MODE: use the resetUrl below — in production this would be emailed."
        : "If an account exists, a reset link has been sent.",
      ...(isDev && { resetUrl }),
    });
  } catch (err) {
    console.error("[forgot-password] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
