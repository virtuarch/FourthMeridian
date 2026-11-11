/**
 * lib/platform/security/auth-posture.ts  (P12a — authentication posture reader)
 *
 * The `sec_auth_posture` read, moved verbatim out of
 * GET /api/platform/security-ops/auth-posture (pure move; pinned old-vs-new by
 * ./p12a-readers.test.ts). The route keeps its gate —
 * requirePlatformAccess("SECURITY_OPS", "READ") — and calls this reader.
 *
 * Aggregates only (per-user totpEnabled / forcePasswordReset / recovery codes /
 * live sessions rolled up into a summary) — no per-user table, so no per-user
 * PII crosses the boundary. Live sessions use THE live rule, liveSessionWhere
 * (SEC-010 lifetime + lockout), at the caller's clock.
 *
 * AUTHORITY: the caller passes its client; there is no default.
 */

import type { PrismaClient } from "@prisma/client";
import { liveSessionWhere } from "@/lib/auth/session-proof";

export interface PlatformAuthPosture {
  totalUsers:             number;
  totpEnabled:            number; // users with TOTP enabled
  forcedResetPending:     number; // users with forcePasswordReset = true
  activeSessions:         number; // LIVE UserSession rows (liveSessionWhere — SEC-010 lifetime + lockout)
  usersWithRecoveryCodes: number; // users with ≥1 unused recovery code
}

/** The only models this reader touches. */
export type AuthPostureClient = Pick<PrismaClient, "user" | "userSession" | "recoveryCode">;

export async function readAuthPosture(client: AuthPostureClient, now: Date): Promise<PlatformAuthPosture> {
  const [totalUsers, totpEnabled, forcedResetPending, activeSessions, recovery] = await Promise.all([
    client.user.count(),
    client.user.count({ where: { totpEnabled: true } }),
    client.user.count({ where: { forcePasswordReset: true } }),
    client.userSession.count({ where: liveSessionWhere(now) }),
    client.recoveryCode.groupBy({ by: ["userId"], where: { usedAt: null }, _count: { id: true } }),
  ]);

  return {
    totalUsers,
    totpEnabled,
    forcedResetPending,
    activeSessions,
    usersWithRecoveryCodes: recovery.length,
  };
}
