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
 *   - TODO: rate-limit to ~5 attempts / 15 min before public deployment.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import { verifyTOTP } from "@/lib/totp";
import bcrypt from "bcryptjs";
import { requireFreshUser } from "@/lib/session";

export async function POST(req: NextRequest) {
  // Sensitive action (disables 2FA) — always a live revocation check.
  const [user, err] = await requireFreshUser();
  if (err) return err;

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
      const secret = decrypt(dbUser.totpSecret);
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
  await db.$transaction([
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

  return NextResponse.json({ ok: true });
}
