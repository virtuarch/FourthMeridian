/**
 * POST /api/user/deactivate  (OPS-2 S4 — account deactivation)
 *
 * Deactivates the authenticated user's account: re-authenticates with the
 * current password, stamps `User.deactivatedAt`, revokes ALL sessions
 * (including this one — deactivated means "cannot use the product"), sends a
 * security-alert email, and audits.
 *
 * Deactivated ≠ deleted: all data, Space memberships, and PlaidItems stay
 * intact — nothing cascades. The bank-sync cron skips the user's items while
 * deactivated (jobs/sync-banks.ts). The user reactivates at login via the
 * explicit "Reactivate and sign in" leg (lib/auth.ts), which requires full
 * auth including TOTP where enabled. Password reset remains available to
 * deactivated accounts (reset ≠ reactivate).
 *
 * SYSTEM_ADMIN cannot self-deactivate — the DISABLE_SYSTEM_ADMIN kill switch
 * is the admin lockout mechanism.
 *
 * Body: { currentPassword: string }
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireFreshUser } from "@/lib/session";
import { revokeAllUserSessions } from "@/lib/sessions";
import { sendEmail } from "@/lib/email/send";
import { formatDateTime } from "@/lib/format";
import { AuditAction } from "@/lib/audit-actions";
import { limitByIp } from "@/lib/rate-limit";
import { UserRole } from "@prisma/client";
import { createNotification } from "@/lib/notifications/create";

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "account-deactivate", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    // Sensitive, destructive-adjacent action — always a live revocation
    // check, never the cache.
    const [user, err] = await requireFreshUser();
    if (err) return err;

    // SYSTEM_ADMIN cannot self-deactivate (decision, S4).
    if (user.role === UserRole.SYSTEM_ADMIN) {
      return NextResponse.json(
        { error: "System administrator accounts cannot be deactivated." },
        { status: 403 },
      );
    }

    const { currentPassword } = await req.json().catch(() => ({}));
    if (!currentPassword || typeof currentPassword !== "string") {
      return NextResponse.json({ error: "Current password is required." }, { status: 400 });
    }

    const dbUser = await db.user.findUnique({
      where:  { id: user.id },
      select: { passwordHash: true, email: true, deactivatedAt: true },
    });
    if (!dbUser?.passwordHash) {
      return NextResponse.json({ error: "Account has no password set." }, { status: 400 });
    }

    // ── Re-authenticate (current password) ────────────────────────────────────
    const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
    }

    // Already deactivated (shouldn't be reachable with a live session, but a
    // race with another device is possible) — treat as success, no double
    // stamp.
    if (dbUser.deactivatedAt) {
      return NextResponse.json({ success: true });
    }

    // ── Deactivate ─────────────────────────────────────────────────────────────
    await db.user.update({
      where: { id: user.id },
      data:  { deactivatedAt: new Date() },
    });

    // Revoke EVERY session, including the current one — the caller is signed
    // out everywhere the moment this returns.
    const revokedSessions = await revokeAllUserSessions(user.id);

    // Notify. NON-THROWING: a delivery failure is logged and recorded, but
    // never fails the deactivation.
    const emailResult = await sendEmail("security-alert", dbUser.email, {
      title:   "Your account was deactivated",
      message:
        `Your Fourth Meridian account was deactivated on ` +
        `${formatDateTime(new Date().toISOString())}. Your data is kept — ` +
        `sign in again anytime to reactivate your account.`,
    });
    if (emailResult.status === "error") {
      console.error("[user/deactivate] security-alert email failed to send:", emailResult.error);
    }

    const auditRow = await db.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.ACCOUNT_DEACTIVATED,
        metadata: { revokedSessions, emailStatus: emailResult.status },
      },
    });

    // OPS-3 S5 Wave 1 — bell mirror, seen on reactivation. Non-throwing.
    await createNotification({
      type: "ACCOUNT_DEACTIVATED",
      userId: user.id,
      auditLogId: auditRow.id,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[user/deactivate] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
