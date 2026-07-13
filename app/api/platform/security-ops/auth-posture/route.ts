/**
 * GET /api/platform/security-ops/auth-posture
 *
 * PO1.1 — authentication posture summary for the `sec_auth_posture` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("SECURITY_OPS", "READ") — NOT the
 * requireSystemAdmin gate on /api/admin/security/users. It reuses that route's
 * aggregate SHAPE (per-user totpEnabled / forcePasswordReset /
 * recoveryCodesRemaining / activeSessionCount) but rolls it up into a small
 * summary card — no per-user table, so no per-user PII crosses the boundary.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";

export const runtime = "nodejs";

export interface PlatformAuthPosture {
  totalUsers:             number;
  totpEnabled:            number; // users with TOTP enabled
  forcedResetPending:     number; // users with forcePasswordReset = true
  activeSessions:         number; // non-revoked UserSession rows
  usersWithRecoveryCodes: number; // users with ≥1 unused recovery code
}

export async function GET() {
  const [, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
  if (err) return err;

  const [totalUsers, totpEnabled, forcedResetPending, activeSessions, recovery] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { totpEnabled: true } }),
    db.user.count({ where: { forcePasswordReset: true } }),
    db.userSession.count({ where: { revokedAt: null } }),
    db.recoveryCode.groupBy({ by: ["userId"], where: { usedAt: null }, _count: { id: true } }),
  ]);

  return NextResponse.json({
    totalUsers,
    totpEnabled,
    forcedResetPending,
    activeSessions,
    usersWithRecoveryCodes: recovery.length,
  } satisfies PlatformAuthPosture);
}
