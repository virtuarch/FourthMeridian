/**
 * POST /api/admin/security/users/[userId]/2fa-reset
 *
 * Resets a user's TOTP 2FA.
 * - Clears totpSecret and sets totpEnabled = false
 * - Invalidates all unused recovery codes
 * - Writes TWO_FACTOR_RESET to AuditLog
 * - Requires confirmation token "RESET" in body
 * - If SYSTEM_ADMIN has TOTP enabled, requires their TOTP code (future enforcement)
 *
 * Body: { confirmToken: "RESET", adminTotpCode?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { requireSystemAdmin } from "@/lib/session";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const [user, err] = await requireSystemAdmin();
  if (err) return err;

  const { userId } = await params;
  const adminId    = user.id;

  // ── Prevent resetting your own account via this API ─────────────────────────
  // (Use the regular 2FA settings for self-management.)
  if (userId === adminId) {
    return NextResponse.json(
      { error: "Cannot reset your own 2FA via this endpoint. Use your account settings." },
      { status: 400 },
    );
  }

  const body = await req.json() as { confirmToken?: string; adminTotpCode?: string };

  // ── Require the "RESET" confirmation token ───────────────────────────────────
  if (body.confirmToken !== "RESET") {
    return NextResponse.json({ error: "Confirmation token missing or incorrect." }, { status: 400 });
  }

  // ── Load target user ─────────────────────────────────────────────────────────
  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, email: true, totpEnabled: true, role: true },
  });

  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  // ── SYSTEM_ADMIN TOTP guard (future) ─────────────────────────────────────────
  // When SYSTEM_ADMIN has TOTP enabled, require their code here.
  // Uncomment after TOTP verification is fully implemented.
  //
  // const admin = await db.user.findUnique({ where: { id: adminId }, select: { totpEnabled: true, totpSecret: true } });
  // if (admin?.totpEnabled) {
  //   if (!body.adminTotpCode) return NextResponse.json({ error: "TOTP code required." }, { status: 403 });
  //   const valid = verifyTotp(admin.totpSecret!, body.adminTotpCode);
  //   if (!valid) return NextResponse.json({ error: "Invalid TOTP code." }, { status: 403 });
  // }

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
    // Audit log
    db.auditLog.create({
      data: {
        userId,
        action:             AuditAction.TWO_FACTOR_RESET,
        performedByAdminId: adminId,
        metadata: {
          targetEmail:       target.email,
          targetRole:        target.role,
          adminId,
          previouslyEnabled: target.totpEnabled,
        },
      },
    }),
  ]);

  return NextResponse.json({ success: true, message: "2FA has been reset for this user." });
}
