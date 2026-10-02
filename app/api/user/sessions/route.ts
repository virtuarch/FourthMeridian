/**
 * GET    /api/user/sessions  — list current user's sessions (active + recently revoked)
 * DELETE /api/user/sessions  — revoke all sessions except the current one
 *
 * The current session is identified by the sessionToken stored in the JWT,
 * compared server-side. The token itself is never returned (P1b).
 */

import { NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { AuditAction } from "@/lib/audit-actions";
import { parseUserAgent } from "@/lib/ua-parser";
import { requireUser, requireFreshUser } from "@/lib/session";
import { revokeOtherUserSessions } from "@/lib/sessions";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const userId       = user.id;
  const currentToken = user.sessionToken ?? null;

  // RLS slice A — fm_app's UserSession policy is `userId = me`, so the predicate
  // below and the database now agree about whose devices these are.
  const sessions = await withTenantDb(userId, (tx) => tx.userSession.findMany({
    where:   { userId },
    orderBy: { createdAt: "desc" },
    take:    20,
  }));

  return NextResponse.json({ sessions: sessions.map((s) => toSessionView(s, currentToken)) });
}

/**
 * P1b — the ONLY shape a session row takes on its way to a browser. An explicit
 * projection, never a spread: `sessionToken` is authentication material (P1 —
 * with NEXTAUTH_SECRET it is what a session token is minted from), and
 * `...s` serialised every device's token to the client, which never read it.
 * The fields below are exactly what components/security/{SessionsList,
 * ActiveSessions}.tsx and AdminSecurityConsole render.
 */
function toSessionView(
  s: { id: string; userId: string; sessionToken: string; ipAddress: string | null; userAgent: string | null;
       lastActiveAt: Date; revokedAt: Date | null; createdAt: Date },
  currentToken: string | null,
) {
  return {
    id:           s.id,
    userId:       s.userId,
    ipAddress:    s.ipAddress,
    userAgent:    s.userAgent,
    lastActiveAt: s.lastActiveAt,
    revokedAt:    s.revokedAt,
    createdAt:    s.createdAt,
    isCurrent:    currentToken !== null && s.sessionToken === currentToken,
    parsed:       parseUserAgent(s.userAgent ?? ""),
  };
}

export async function DELETE() {
  // Sensitive action — always a live revocation check, never the cache.
  const [user, err] = await requireFreshUser();
  if (err) return err;

  const userId       = user.id;
  const currentToken = user.sessionToken ?? null;

  // Revoke all except the current session (shared helper — same logic backs
  // password-change hardening in OPS-2 S2).
  const count = await revokeOtherUserSessions(userId, currentToken);

  // The revocation above runs through the shared sessions helper, which holds its
  // own client and is not converted in this slice; the audit row is this route's own
  // write and runs as the user.
  await withTenantDb(userId, (tx) => tx.auditLog.create({
    data: {
      userId,
      action:   AuditAction.SESSION_REVOKED,
      metadata: { revokedAll: true, exceptCurrent: true, count },
    },
  }));

  return NextResponse.json({ success: true, count });
}
