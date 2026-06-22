/**
 * POST /api/auth/reset-password
 *
 * Validates a reset token and updates the user's password.
 * Token is single-use and expires after 1 hour.
 *
 * Body: { token: string, password: string }
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";

export async function POST(req: NextRequest) {
  try {
    const { token, password } = await req.json();

    if (!token || !password) {
      return NextResponse.json({ error: "Token and new password are required." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    // Find user with matching, non-expired token — token is hashed before
    // lookup since passwordResetToken is now stored hashed, not plaintext.
    const user = await db.user.findFirst({
      where: {
        passwordResetToken:  hashResetToken(token),
        passwordResetExpiry: { gt: new Date() },
      },
      select: { id: true, email: true },
    });

    if (!user) {
      return NextResponse.json(
        { error: "This reset link is invalid or has expired. Please request a new one." },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await db.user.update({
      where: { id: user.id },
      data:  {
        passwordHash,
        passwordResetToken:  null,  // invalidate — single use
        passwordResetExpiry: null,
      },
    });

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: "PASSWORD_RESET_COMPLETE",
        metadata: { email: user.email },
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[reset-password] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
