/**
 * POST /api/user/delete  (OPS-2 S7b — account deletion REQUEST)
 *
 * Schedules a REVERSIBLE pending deletion. Re-authenticates with the current
 * password, runs the sole-OWNER preflight, then stamps
 * `deletionRequestedAt` / `deletionScheduledAt` (= now + grace) and reuses the
 * S4 lockout by also setting `deactivatedAt`, revokes ALL sessions, sends a
 * security-alert email, and audits ACCOUNT_DELETION_REQUESTED.
 *
 * NOTHING IS DELETED HERE. The account is fully recoverable for the whole
 * grace window: signing back in surfaces the S7a `cancelDeletion` login leg,
 * which clears all three timestamps. The actual purge is S7c (cron pipeline) —
 * this route contains no destructive logic, no provider work, no cron.
 *
 * Mirrors app/api/user/deactivate/route.ts (the sensitive-action template).
 * SYSTEM_ADMIN cannot self-delete (the DISABLE_SYSTEM_ADMIN kill switch is the
 * admin lockout path). Idempotent: an already-pending account returns success
 * without re-stamping or re-revoking.
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
import { limitByUser } from "@/lib/rate-limit";
import { deletionPreflight, GRACE_DAYS, GRACE_MS } from "@/lib/account-deletion/preflight";
import { UserRole } from "@prisma/client";
import { createNotification } from "@/lib/notifications/create";

export async function POST(req: NextRequest) {
  try {
    // Sensitive, destructive-adjacent action — always a live revocation check.
    const [user, err] = await requireFreshUser();
    if (err) return err;

    const limited = await limitByUser(user.id, "account-delete", { limit: 5, windowSec: 900 });
    if (limited) return limited;

    // SYSTEM_ADMIN cannot self-delete (mirrors the S4 self-deactivate block).
    if (user.role === UserRole.SYSTEM_ADMIN) {
      return NextResponse.json(
        { error: "System administrator accounts cannot be deleted." },
        { status: 403 },
      );
    }

    const { currentPassword } = await req.json().catch(() => ({}));
    if (!currentPassword || typeof currentPassword !== "string") {
      return NextResponse.json({ error: "Current password is required." }, { status: 400 });
    }

    const dbUser = await db.user.findUnique({
      where:  { id: user.id },
      select: { passwordHash: true, email: true, deletionScheduledAt: true },
    });
    if (!dbUser?.passwordHash) {
      return NextResponse.json({ error: "Account has no password set." }, { status: 400 });
    }

    // ── Re-authenticate (current password) ────────────────────────────────────
    const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
    }

    // Already pending (a race with another device, or a double-submit) — treat
    // as success, no double stamp or re-revoke.
    if (dbUser.deletionScheduledAt) {
      return NextResponse.json({ success: true, scheduledAt: dbUser.deletionScheduledAt.toISOString() });
    }

    // ── Preflight: sole-OWNER block (read-only) ───────────────────────────────
    const preflight = await deletionPreflight(user.id);
    if (preflight.blocked) {
      return NextResponse.json(
        {
          error:
            "You're the only owner of a shared Space that still has other members. " +
            "Transfer ownership, or delete the Space (trash → permanently delete), before deleting your account.",
          blockingSpaces: preflight.blockingSpaces,
        },
        { status: 409 },
      );
    }

    // ── Schedule the reversible pending deletion ──────────────────────────────
    const now         = new Date();
    const scheduledAt = new Date(now.getTime() + GRACE_MS);

    await db.user.update({
      where: { id: user.id },
      data:  {
        deletionRequestedAt: now,
        deletionScheduledAt: scheduledAt,
        // Reuse the S4 lockout: pending-deletion IS deactivation + a timer.
        deactivatedAt:       now,
      },
    });

    // Revoke EVERY session, including the current one — the caller is signed
    // out everywhere the moment this returns; recovery is only via the
    // cancelDeletion login leg (S7a).
    const revokedSessions = await revokeAllUserSessions(user.id);

    // Notify. NON-THROWING: a delivery failure is logged and audited, never
    // fails the request.
    const emailResult = await sendEmail("security-alert", dbUser.email, {
      title:   "Your account is scheduled for deletion",
      message:
        `Your Fourth Meridian account is scheduled for deletion on ` +
        `${formatDateTime(scheduledAt.toISOString())}. You can cancel any time ` +
        `before then by signing back in and choosing "Cancel deletion". If this ` +
        `wasn't you, sign in now to cancel.`,
    });
    if (emailResult.status === "error") {
      console.error("[user/delete] security-alert email failed to send:", emailResult.error);
    }

    const auditRow = await db.auditLog.create({
      data: {
        userId:   user.id,
        action:   AuditAction.ACCOUNT_DELETION_REQUESTED,
        metadata: {
          deletionScheduledAt: scheduledAt.toISOString(),
          graceDays:           GRACE_DAYS,
          revokedSessions,
          emailStatus:         emailResult.status,
        },
      },
    });

    // OPS-3 S5 Wave 1 — bell mirror, seen if the user signs back in to cancel.
    // scheduledFor is display payload per the registry pointer contract.
    await createNotification({
      type: "ACCOUNT_DELETION_REQUESTED",
      userId: user.id,
      auditLogId: auditRow.id,
      data: { scheduledFor: formatDateTime(scheduledAt.toISOString()) },
    });

    return NextResponse.json({ success: true, scheduledAt: scheduledAt.toISOString() });
  } catch (err) {
    console.error("[user/delete] error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
