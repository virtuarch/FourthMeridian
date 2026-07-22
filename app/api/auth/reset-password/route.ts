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
import { revokeAllUserSessions } from "@/lib/sessions";
import { sendEmail } from "@/lib/email/send";
import { formatDateTime } from "@/lib/format";
import { limitByIp } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notifications/create";
import { AuditAction } from "@/lib/audit-actions";
import { getMinPasswordLength } from "@/lib/platform-settings";

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "reset-password", { limit: 10, windowSec: 900 });
    if (limited) return limited;

    const { token, password } = await req.json();

    if (!token || !password) {
      return NextResponse.json({ error: "Token and new password are required." }, { status: 400 });
    }
    // SEC-4 — enforce the admin-configurable min length, not a hardcoded 8.
    const minPasswordLength = await getMinPasswordLength();
    if (password.length < minPasswordLength) {
      return NextResponse.json({ error: `Password must be at least ${minPasswordLength} characters.` }, { status: 400 });
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

    // Harden (OPS-2 S2b): a reset is a logged-out flow with no current session
    // to preserve, and implies possible compromise — revoke ALL of the user's
    // active sessions so nothing survives the reset. They re-authenticate with
    // the new password.
    const revokedSessions = await revokeAllUserSessions(user.id);

    // Notify the account's own email that a reset completed. NON-THROWING: a
    // delivery failure is logged and recorded, but never fails the reset.
    const emailResult = await sendEmail("security-alert", user.email, {
      title:   "Your password was reset",
      message: `Your Fourth Meridian password was reset on ${formatDateTime(new Date().toISOString())}.`,
    });
    if (emailResult.status === "error") {
      console.error("[reset-password] security-alert email failed to send:", emailResult.error);
    }

    const auditRow = await db.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.PASSWORD_RESET_COMPLETE,
        metadata: { email: user.email, revokedSessions, emailStatus: emailResult.status },
      },
    });

    // OPS-3 S5 Wave 1 — bell mirror (registry type PASSWORD_RESET; the legacy
    // audit string above is grandfathered, never renamed). Non-throwing.
    await createNotification({
      type: "PASSWORD_RESET",
      userId: user.id,
      auditLogId: auditRow.id,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[reset-password] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
