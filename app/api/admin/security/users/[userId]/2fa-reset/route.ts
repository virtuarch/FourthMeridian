/**
 * POST /api/admin/security/users/[userId]/2fa-reset
 *
 * Resets a USER's TOTP 2FA.
 * - Clears totpSecret and sets totpEnabled = false
 * - Invalidates all unused recovery codes
 * - Revokes every session of the target (a second factor that was just
 *   removed must not keep an already-issued session alive)
 * - Writes TWO_FACTOR_RESET to AuditLog (target referenced by email DIGEST,
 *   never the raw address — PRIV-002)
 * - Notifies the target by email (non-throwing)
 *
 * SEC-006 — the rule lives in lib/auth/admin-2fa-reset-policy.ts and is
 * applied in full: the literal "RESET" confirmation, NO SYSTEM_ADMIN targets,
 * and the actor's LIVE TOTP code verified against the actor's own secret
 * (the same decrypt + verifyTOTP pair login uses). The actor's code attempts
 * are rate-limited per actor so the endpoint cannot be used to brute-force
 * a six-digit code.
 *
 * Body: { confirmToken: "RESET", adminTotpCode: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { auditEmailHash } from "@/lib/audit";
import { requireFreshSystemAdmin } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { revokeAllUserSessions } from "@/lib/sessions";
import { sendEmail } from "@/lib/email/send";
import { twoFactorResetAlert } from "@/lib/email/security-alerts";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import {
  ADMIN_TWO_FACTOR_RESET_STATUS,
  decideAdminTwoFactorReset,
} from "@/lib/auth/admin-2fa-reset-policy";

const REFUSAL_MESSAGE: Record<keyof typeof ADMIN_TWO_FACTOR_RESET_STATUS, string> = {
  SELF:                   "Cannot reset your own 2FA via this endpoint. Use your account settings.",
  CONFIRM_TOKEN:          "Confirmation token missing or incorrect.",
  TARGET_IS_SYSTEM_ADMIN: "A SYSTEM_ADMIN's two-factor authentication cannot be reset from this endpoint.",
  ACTOR_NOT_ENROLLED:     "Your account must have two-factor authentication enabled to perform this action.",
  TOTP_CODE_MISSING:      "Your current authenticator code is required.",
  TOTP_CODE_INVALID:      "Invalid authenticator code.",
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  // SEC-2 — destructive (resets another user's 2FA + invalidates their
  // recovery codes). Always a live revocation check, never the cache.
  const [user, err] = await requireFreshSystemAdmin();
  if (err) return err;

  const { userId } = await params;
  const adminId    = user.id;

  // SEC-006 — the actor's code is a six-digit secret; bound the guesses.
  const limited = await limitByUser(adminId, "admin-2fa-reset", { limit: 5, windowSec: 900 });
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { confirmToken?: unknown; adminTotpCode?: unknown };

  // ── Load target and the actor's own second factor ───────────────────────────
  const [target, actor] = await Promise.all([
    db.user.findUnique({
      where:  { id: userId },
      select: { id: true, email: true, totpEnabled: true, role: true },
    }),
    db.user.findUnique({
      where:  { id: adminId },
      select: { totpEnabled: true, totpSecret: true },
    }),
  ]);

  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  let actorTotpSecret: string | null = null;
  if (actor?.totpEnabled && actor.totpSecret) {
    try { actorTotpSecret = decryptWithPurpose(actor.totpSecret, EncryptionPurpose.TOTP_SECRET); }
    catch { actorTotpSecret = null; } // corrupted secret — fail safe (ACTOR_NOT_ENROLLED)
  }

  const decision = decideAdminTwoFactorReset({
    actorId:          adminId,
    targetId:         target.id,
    targetRole:       target.role,
    confirmToken:     body.confirmToken,
    actorTotpEnabled: actor?.totpEnabled === true,
    actorTotpSecret,
    adminTotpCode:    body.adminTotpCode,
  });
  if (decision !== "ALLOW") {
    return NextResponse.json({ error: REFUSAL_MESSAGE[decision] }, { status: ADMIN_TWO_FACTOR_RESET_STATUS[decision] });
  }

  // ── Perform reset ─────────────────────────────────────────────────────────────
  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data:  { totpEnabled: false, totpSecret: null },
    }),
    // Invalidate all unused recovery codes
    db.recoveryCode.deleteMany({
      where: { userId, usedAt: null },
    }),
    // Audit log — the target is referenced by digest (PRIV-002), never by address.
    db.auditLog.create({
      data: {
        userId,
        action:             AuditAction.TWO_FACTOR_RESET,
        performedByAdminId: adminId,
        metadata: {
          targetEmailHash:   auditEmailHash(target.email),
          targetRole:        target.role,
          adminId,
          previouslyEnabled: target.totpEnabled,
          actorMfa:          "totp",
        },
      },
    }),
  ]);

  // The removed factor must not keep an issued session alive.
  const revokedSessions = await revokeAllUserSessions(userId);

  // Notify the target. NON-THROWING: delivery failure never undoes the reset.
  const emailResult = await sendEmail("security-alert", target.email, { ...twoFactorResetAlert(new Date()) }, { key: "TWO_FACTOR_RESET_BY_ADMIN", recipientUserId: userId });
  if (emailResult.status === "error") {
    console.error("[admin-2fa-reset] security-alert email failed to send:", emailResult.error);
  }

  return NextResponse.json({
    success: true,
    message: "2FA has been reset for this user.",
    revokedSessions,
    emailStatus: emailResult.status,
  });
}
