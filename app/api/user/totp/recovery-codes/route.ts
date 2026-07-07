/**
 * POST /api/user/totp/recovery-codes
 *
 * Lets an authenticated user regenerate their own recovery codes.
 *
 * Requires a valid TOTP code to prevent a stolen session from locking
 * out the real account owner by cycling their recovery codes.
 *
 * Body: { totpCode: "123456" }
 *
 * On success:
 *   - Deletes all existing unused recovery codes
 *   - Generates 10 fresh codes (bcrypt-hashed in DB)
 *   - Writes RECOVERY_CODES_REGENERATED audit log
 *   - Returns { ok: true, recoveryCodes: [...] } — shown once only
 *
 * Rate-limited per user (OPS-1 S4): max 3 attempts / 15 min.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { verifyTOTP } from "@/lib/totp";
import { requireFreshUser } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // Sensitive action (regenerates recovery codes) — always a live check.
  const [user, err] = await requireFreshUser();
  if (err) return err;

  const limited = await limitByUser(user.id, "totp-recovery-codes", { limit: 3, windowSec: 900 });
  if (limited) return limited;

  const body     = await req.json();
  const totpCode = (body.totpCode as string | undefined)?.replace(/\s/g, "");

  if (!totpCode || !/^\d{6}$/.test(totpCode)) {
    return NextResponse.json(
      { error: "A 6-digit authenticator code is required to regenerate recovery codes." },
      { status: 400 },
    );
  }

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { totpEnabled: true, totpSecret: true },
  });

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!dbUser.totpEnabled || !dbUser.totpSecret) {
    return NextResponse.json(
      { error: "2FA is not enabled on your account." },
      { status: 400 },
    );
  }

  // Verify the TOTP code
  let secret: string;
  try {
    secret = decryptWithPurpose(dbUser.totpSecret, EncryptionPurpose.TOTP_SECRET);
  } catch {
    return NextResponse.json({ error: "Failed to verify code." }, { status: 500 });
  }

  if (!verifyTOTP(totpCode, secret, 1)) {
    return NextResponse.json(
      { error: "Incorrect code. Check your authenticator app and try again." },
      { status: 400 },
    );
  }

  // Regenerate codes (isRegen = true → RECOVERY_CODES_REGENERATED audit event)
  const plainCodes = await generateRecoveryCodes(user.id, true);

  return NextResponse.json({
    ok:            true,
    recoveryCodes: plainCodes, // shown once — never returned again
  });
}
