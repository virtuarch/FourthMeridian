/**
 * GET /api/user/totp/status
 *
 * Returns the current user's 2FA status.
 * Used by the Settings page to render the 2FA section without
 * requiring a full page reload after enable/disable actions.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countRemainingCodes } from "@/lib/recovery-codes";
import { requireUser } from "@/lib/session";

export async function GET() {
  // SEC-FIX-1 — enrolment surface: the settings/security page reads TOTP
  // status while setup is still pending, so opt out of the enrolment gate.
  const [user, err] = await requireUser({ allowTotpSetupPending: true });
  if (err) return err;

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { totpEnabled: true, totpSecret: true },
  });

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const recoveryCodesRemaining = dbUser.totpEnabled
    ? await countRemainingCodes(user.id)
    : 0;

  return NextResponse.json({
    totpEnabled:            dbUser.totpEnabled,
    totpConfigured:         !!dbUser.totpSecret,
    recoveryCodesRemaining,
  });
}
