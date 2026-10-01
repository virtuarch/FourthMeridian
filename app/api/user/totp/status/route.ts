/**
 * GET /api/user/totp/status
 *
 * Returns the current user's 2FA status.
 * Used by the Settings page to render the 2FA section without
 * requiring a full page reload after enable/disable actions.
 */

import { NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { countRemainingCodes } from "@/lib/recovery-codes";
import { requireUser } from "@/lib/session";

export async function GET() {
  // SEC-FIX-1 — enrolment surface: the settings/security page reads TOTP
  // status while setup is still pending, so opt out of the enrolment gate.
  const [user, err] = await requireUser({ allowTotpSetupPending: true });
  if (err) return err;

  // RLS slice A — one row, their own, as them.
  const dbUser = await withTenantDb(user.id, (tx) => tx.user.findUnique({
    where:  { id: user.id },
    select: { totpEnabled: true, totpSecret: true },
  }));

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ⚠️ DELIBERATELY OUTSIDE THE TENANT BOUNDARY. `lib/recovery-codes.ts` runs on
  // authDb — the PRE-IDENTITY authority — because the same module serves the sign-in
  // leg, where no identity exists yet. Routing this count through fm_app would mean
  // two authorities for one table; widening authDb instead would make it a general
  // escape. Left as it is, and reported.
  const recoveryCodesRemaining = dbUser.totpEnabled
    ? await withTenantDb(user.id, (tx) => countRemainingCodes(tx, user.id))
    : 0;

  return NextResponse.json({
    totpEnabled:            dbUser.totpEnabled,
    totpConfigured:         !!dbUser.totpSecret,
    recoveryCodesRemaining,
  });
}
