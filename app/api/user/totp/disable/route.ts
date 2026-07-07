/**
 * POST /api/user/totp/disable
 *
 * Disables TOTP 2FA for the authenticated user.
 *
 * Requires one of:
 *   - { totpCode: "123456" }   — current TOTP code from authenticator app (preferred)
 *   - { password: "..." }      — current account password (fallback)
 *
 * On success:
 *   - Clears totpSecret + sets totpEnabled = false
 *   - Deletes all recovery codes
 *   - Writes TWO_FACTOR_DISABLED audit log
 *
 * Security notes:
 *   - Both verification paths are required — cannot bypass by omitting both.
 *   - TOTP code verification uses ±1 window to handle clock drift.
 *   - Rate-limited per user (OPS-1 S4) — the password fallback is otherwise
 *     brute-forceable from a hijacked session.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import { verifyTOTP } from "@/lib/totp";
import bcrypt from "bcryptjs";
import { requireFreshUser } from "@/lib/session";
import { createNotification } from "@/lib/notifications/create";
import { limitByUser } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // Sensitive action (disables 2FA) — always a live revocation check.
  const [user, err] = await requireFreshUser();
  if (err) return err;

  const limited = await limitByUser(user.id, "totp-disable", { limit: 5, windowSec: 900 });
  if (limited) return limited;

  const body         = await req.json();
  const totpCode     = (body.totpCode as string | undefined)?.replace(/\s/g, "");
  const password     = (body.password as string | undefined) ?? "";

  if (!totpCode && !password) {
    return NextResponse.json(
      { error: "Provide your current TOTP code or account password to disable 2FA." },
      { status: 400 },
    );
  }

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { totpEnabled: true, totpSecret: true, passwordHash: true },
  });

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!dbUser.totpEnabled) {
    return NextResponse.json({ error: "2FA is not enabled." }, { status: 400 });
  }

  // ── Verify identity ──────────────────────────────────────────────────────────
  let verified = false;

  if (totpCode && dbUser.totpSecret) {
    try {
      const secret = decryptWithPurpose(dbUser.totpSecret, EncryptionPurpose.TOTP_SECRET);
      verified = verifyTOTP(totpCode, secret, 1);
    } catch {
      return NextResponse.json({ error: "Failed to verify code." }, { status: 500 });
    }
  } else if (password && dbUser.passwordHash) {
    verified = await bcrypt.compare(password, dbUser.passwordHash);
  }

  if (!verified) {
    return NextResponse.json(
      { error: "Verification failed. Check your TOTP code or password." },
      { status: 400 },
    );
  }

  // ── Disable 2FA ──────────────────────────────────────────────────────────────
  const [, , auditRow] = await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data:  { totpSecret: null, totpEnabled: false },
    }),
    db.recoveryCode.deleteMany({
      where: { userId: user.id },
    }),
    db.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.TWO_FACTOR_DISABLED,
      },
    }),
  ]);

  // OPS-3 S5 Wave 1 — bell mirror, AFTER the transaction commits (fact first,
  // ping second). Non-throwing.
  await createNotification({
    type: "TWO_FACTOR_DISABLED",
    userId: user.id,
    auditLogId: auditRow.id,
  });

  return NextResponse.json({ ok: true });
}
