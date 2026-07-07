/**
 * PATCH /api/user/password
 *
 * Changes the authenticated user's password.
 * Requires the current password to prevent unauthorized changes
 * from hijacked sessions.
 *
 * Body: { currentPassword: string, newPassword: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { requireFreshUser } from "@/lib/session";
import { withApiHandler } from "@/lib/api";
import { revokeOtherUserSessions } from "@/lib/sessions";
import { sendEmail } from "@/lib/email/send";
import { formatDateTime } from "@/lib/format";
import { createNotification } from "@/lib/notifications/create";
import { limitByUser } from "@/lib/rate-limit";

export const PATCH = withApiHandler(async (req: NextRequest) => {
  // Sensitive action — always a live revocation check, never the cache.
  const [user, err] = await requireFreshUser();
  if (err) return err;

  // OPS-1 S4 — blunt current-password brute force from a foothold session.
  const limited = await limitByUser(user.id, "password-change", { limit: 5, windowSec: 900 });
  if (limited) return limited;

  const { currentPassword, newPassword } = await req.json();

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Both current and new password are required." }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 });
  }
  if (currentPassword === newPassword) {
    return NextResponse.json({ error: "New password must be different from current password." }, { status: 400 });
  }

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { passwordHash: true, email: true },
  });

  if (!dbUser?.passwordHash) {
    return NextResponse.json({ error: "Account has no password set." }, { status: 400 });
  }

  const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
  if (!valid) {
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: "PASSWORD_CHANGE_FAILED",
        metadata: { reason: "wrong_current_password" },
      },
    });
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  await db.user.update({
    where: { id: user.id },
    data:  { passwordHash: newHash },
  });

  // Harden (OPS-2 S2): revoke every OTHER session so a stolen session can't
  // outlive a password change. The current session is preserved — the user
  // stays signed in on this device. Same helper backs sign-out-everywhere.
  const revokedOtherSessions = await revokeOtherUserSessions(user.id, user.sessionToken);

  // Notify the account's own email. NON-THROWING: a delivery failure is logged
  // and recorded, but never fails the password change.
  const emailResult = await sendEmail("security-alert", dbUser.email, {
    title:   "Your password was changed",
    message: `Your Fourth Meridian password was changed on ${formatDateTime(new Date().toISOString())}.`,
  });
  if (emailResult.status === "error") {
    console.error("[user/password] security-alert email failed to send:", emailResult.error);
  }

  const auditRow = await db.auditLog.create({
    data: {
      userId: user.id,
      action: "PASSWORD_CHANGED",
      metadata: { revokedOtherSessions, emailStatus: emailResult.status },
    },
  });

  // OPS-3 S5 Wave 1 — in-app mirror of the alert above (bell only; the email
  // guarantee stays with the security-alert send). Non-throwing by contract.
  await createNotification({
    type: "PASSWORD_CHANGED",
    userId: user.id,
    auditLogId: auditRow.id,
  });

  return NextResponse.json({ success: true });
}, "PATCH /api/user/password");
