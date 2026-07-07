/**
 * POST /api/user/totp/verify
 *
 * Completes TOTP setup by verifying the first code from the authenticator app.
 *
 * - Decrypts the stored totpSecret
 * - Verifies the provided 6-digit code (±1 time step tolerance)
 * - On success: sets totpEnabled = true, generates recovery codes
 * - Writes TWO_FACTOR_ENABLED to the audit log
 * - Returns recovery codes (shown ONCE — never retrievable again)
 *
 * Body: { code: string }  — 6-digit TOTP code
 *
 * Rate limited per user (KD-3): 5 attempts / 15 min. SYSTEM_ADMIN exempt.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { AuditAction } from "@/lib/audit-actions";
import { verifyTOTP } from "@/lib/totp";
import { requireUser } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notifications/create";

export async function POST(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  if (user.role !== "SYSTEM_ADMIN") {
    const limited = await limitByUser(user.id, "totp-verify", { limit: 5, windowSec: 900 });
    if (limited) return limited;
  }

  const body = await req.json();
  const code = (body.code as string | undefined)?.replace(/\s/g, "");

  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "A 6-digit code is required." }, { status: 400 });
  }

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { totpSecret: true, totpEnabled: true },
  });

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (dbUser.totpEnabled) {
    return NextResponse.json(
      { error: "2FA is already enabled." },
      { status: 400 },
    );
  }

  if (!dbUser.totpSecret) {
    return NextResponse.json(
      { error: "No 2FA setup in progress. Start setup first." },
      { status: 400 },
    );
  }

  // Decrypt and verify
  let secret: string;
  try {
    secret = decryptWithPurpose(dbUser.totpSecret, EncryptionPurpose.TOTP_SECRET);
  } catch {
    return NextResponse.json({ error: "Failed to decrypt secret. Try setup again." }, { status: 500 });
  }

  const valid = verifyTOTP(code, secret, 1);

  if (!valid) {
    return NextResponse.json(
      { error: "Incorrect code. Check your authenticator app and try again." },
      { status: 400 },
    );
  }

  // Enable 2FA
  await db.user.update({
    where: { id: user.id },
    data:  { totpEnabled: true },
  });

  // Generate recovery codes and write TWO_FACTOR_ENABLED audit log
  const plainCodes = await generateRecoveryCodes(
    user.id,
    false, // not a regen — first-time setup
  );

  // generateRecoveryCodes writes RECOVERY_CODES_GENERATED; write TWO_FACTOR_ENABLED separately
  const auditRow = await db.auditLog.create({
    data: {
      userId: user.id,
      action: AuditAction.TWO_FACTOR_ENABLED,
    },
  });

  // OPS-3 S5 Wave 1 — bell mirror. Non-throwing.
  await createNotification({
    type: "TWO_FACTOR_ENABLED",
    userId: user.id,
    auditLogId: auditRow.id,
  });

  return NextResponse.json({
    ok:            true,
    recoveryCodes: plainCodes, // shown once — never returned again
  });
}
