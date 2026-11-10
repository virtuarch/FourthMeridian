/**
 * lib/platform/security/sessions.ts  (P12a — recent live sessions reader)
 *
 * The `sec_sessions` recent-list read, moved verbatim out of
 * GET /api/platform/security-ops/sessions (pure move; pinned old-vs-new by
 * ./p12a-readers.test.ts). The route keeps its gate —
 * requirePlatformAccess("SECURITY_OPS", "READ") — and still calls
 * countLiveSessions (./live-sessions.ts, registry live-sessions@1) for the
 * counts, at the SAME clock it passes here.
 *
 * LIVE UserSessions only (liveSessionWhere — not revoked, within the SEC-010
 * idle/absolute lifetime, account not locked out), most recently active first,
 * mapped through toPlatformSessionRow: parsed device/browser/OS + time — never
 * IP, user-agent string, session id, userId, or email leaves this reader.
 *
 * AUTHORITY: the caller passes its client; there is no default.
 */

import type { PrismaClient } from "@prisma/client";
import { liveSessionWhere } from "@/lib/auth/session-proof";
import { toPlatformSessionRow, type PlatformSessionRow } from "./session-rows";

const RECENT_LIMIT = 8;

export type { PlatformSessionRow };

export interface PlatformSessionsResponse {
  totalActive:   number;
  distinctUsers: number;
  recent:        PlatformSessionRow[];
}

/** The only model this reader touches. */
export type RecentLiveSessionsClient = Pick<PrismaClient, "userSession">;

export async function listRecentLiveSessions(client: RecentLiveSessionsClient, now: Date): Promise<PlatformSessionRow[]> {
  const live = liveSessionWhere(now);
  const recent = await client.userSession.findMany({
    where:   live,
    orderBy: { lastActiveAt: "desc" },
    take:    RECENT_LIMIT,
    select:  { userAgent: true, lastActiveAt: true },
  });
  // Identity-free: no session id, user id or token ever leaves this reader (registry live-sessions@1 drill note).
  return recent.map(toPlatformSessionRow);
}
