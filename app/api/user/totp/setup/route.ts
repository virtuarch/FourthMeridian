/**
 * POST /api/user/totp/setup
 *
 * Initiates TOTP setup for the authenticated user.
 *
 * - Generates a new TOTP secret
 * - Encrypts it with AES-256-GCM before storing
 * - Sets totpEnabled = false (pending verification)
 * - Returns a QR code data URL + the raw secret for manual entry
 * - Writes TWO_FACTOR_SETUP_STARTED to the audit log
 *
 * The raw secret is returned ONLY here and never again.
 * If the user does not complete verification it remains in the
 * "pending" state (totpEnabled = false) until they try again.
 *
 * TODO: rate-limit this endpoint (max 5 setup attempts / 15 min per user)
 *       before public deployment.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import { generateSecret, otpauthUri } from "@/lib/totp";
import QRCode from "qrcode";
import { requireUser } from "@/lib/session";

export async function POST() {
  const [user, err] = await requireUser();
  if (err) return err;

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { email: true, totpEnabled: true },
  });

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (dbUser.totpEnabled) {
    return NextResponse.json(
      { error: "2FA is already enabled. Disable it first." },
      { status: 400 },
    );
  }

  // Generate fresh 160-bit secret and the otpauth:// URI for the QR code
  const secret     = generateSecret(20);
  const encrypted  = encrypt(secret);
  const otpauthUrl = otpauthUri(dbUser.email, secret);

  // Generate QR code as a base64 data URL (rendered in <img> by the client)
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: "M",
    width: 256,
  });

  // Persist the encrypted secret (totpEnabled stays false until verify)
  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data:  { totpSecret: encrypted },
    }),
    db.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.TWO_FACTOR_SETUP_STARTED,
      },
    }),
  ]);

  return NextResponse.json({
    qrCodeDataUrl,
    manualKey: secret, // shown once for manual entry — never logged, not stored in plaintext
  });
}
