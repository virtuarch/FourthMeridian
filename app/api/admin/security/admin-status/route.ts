/**
 * GET /api/admin/security/admin-status
 *
 * Returns security state for the currently logged-in SYSTEM_ADMIN.
 * Used by the Security page to show the admin's own 2FA status,
 * recovery codes remaining, and active session count.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countRemainingCodes } from "@/lib/recovery-codes";
import { requireSystemAdmin } from "@/lib/session";

export async function GET() {
  const [user, err] = await requireSystemAdmin();
  if (err) return err;

  const userId = user.id;

  const [dbUser, recoveryCodesRemaining, activeSessions, lastLogin] = await Promise.all([
    db.user.findUnique({
      where:  { id: userId },
      select: { totpEnabled: true, totpSecret: true },
    }),
    countRemainingCodes(userId),
    db.userSession.count({ where: { userId, revokedAt: null } }),
    db.auditLog.findFirst({
      where:   { userId, action: "LOGIN" },
      orderBy: { createdAt: "desc" },
      select:  { createdAt: true, ipAddress: true },
    }),
    // Count when recovery codes were last generated
  ]);

  const lastCodeGeneration = await db.auditLog.findFirst({
    where:   { userId, action: { in: ["RECOVERY_CODES_GENERATED", "RECOVERY_CODES_REGENERATED"] } },
    orderBy: { createdAt: "desc" },
    select:  { createdAt: true },
  });

  return NextResponse.json({
    userId:                 userId,   // safe — same user as the session; used by client for self-service actions
    totpEnabled:            dbUser?.totpEnabled ?? false,
    // Never expose totpSecret — only show whether it's set
    totpConfigured:         !!(dbUser?.totpSecret),
    recoveryCodesRemaining,
    activeSessions,
    lastLogin:              lastLogin?.createdAt ?? null,
    lastLoginIp:            lastLogin?.ipAddress ?? null,
    lastCodeGeneration:     lastCodeGeneration?.createdAt ?? null,
  });
}
