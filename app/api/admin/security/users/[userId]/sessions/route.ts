/**
 * GET    /api/admin/security/users/[userId]/sessions  — list sessions
 * DELETE /api/admin/security/users/[userId]/sessions  — revoke all sessions
 * DELETE /api/admin/security/users/[userId]/sessions?sessionId=xxx — revoke one
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { parseUserAgent } from "@/lib/ua-parser";
import { requireSystemAdmin, requireFreshSystemAdmin } from "@/lib/session";
import { clearAllSessions } from "@/lib/session-cache";

/**
 * P1b — the admin surface's safe projection, and the reason it is a `select`
 * rather than a filtered spread.
 *
 * `sessionToken` is authentication material: with NEXTAUTH_SECRET it is what a
 * session token is minted from (P1). This route used to answer with `{...s}`
 * over an unbounded `findMany()`, so GET /api/admin/security/users/<id>/sessions
 * serialised up to 50 of a user's live tokens to the admin's browser — where
 * nothing read them. components/security/SessionsList.tsx's `SessionRow` has
 * never declared the field, and AdminSecurityConsole.tsx's UserSessionsModal
 * types this response as `SessionRow[]`.
 *
 * The columns below ARE `SessionRow`, which is why the select is the fix rather
 * than a projection alone: the token never enters the process, so no later edit
 * to the response shape can leak it by accident. `isCurrent` is deliberately
 * absent — an admin reading ANOTHER user's devices has no current session among
 * them, and deciding it would require the very column this select omits.
 * `revokedById` is dropped with the spread: it is written here (DELETE, below)
 * and read by no surface — grepped across app/ and components/.
 */
/** Exported for the dynamic proof in lib/auth/admin-session-projection.test.ts. */
export function toAdminSessionView(s: {
  id: string; userId: string; ipAddress: string | null; userAgent: string | null;
  lastActiveAt: Date; revokedAt: Date | null; createdAt: Date;
}) {
  return {
    id:           s.id,
    userId:       s.userId,
    ipAddress:    s.ipAddress,
    userAgent:    s.userAgent,
    lastActiveAt: s.lastActiveAt,
    revokedAt:    s.revokedAt,
    createdAt:    s.createdAt,
    parsed:       parseUserAgent(s.userAgent ?? ""),
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const { userId } = await params;

  // The select is written out, not referenced through a constant, so that
  // lib/auth/session-token-exposure.test.ts can read the column list here and
  // refuse anything it cannot see — `select: SOMETHING` would be opaque to it.
  const sessions = await db.userSession.findMany({
    where:   { userId },
    select: {
      id:           true,
      userId:       true,
      ipAddress:    true,
      userAgent:    true,
      lastActiveAt: true,
      revokedAt:    true,
      createdAt:    true,
    },
    orderBy: { createdAt: "desc" },
    take:    50,
  });

  return NextResponse.json({ sessions: sessions.map((s) => toAdminSessionView(s)) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  // Sensitive admin action — always a live revocation check, never the cache.
  const [admin, err] = await requireFreshSystemAdmin();
  if (err) return err;

  const { userId } = await params;
  const adminId    = admin.id;
  const sessionId  = req.nextUrl.searchParams.get("sessionId");

  const now = new Date();

  if (sessionId) {
    // Revoke a specific session
    await db.$transaction([
      db.userSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data:  { revokedAt: now, revokedById: adminId },
      }),
      db.auditLog.create({
        data: {
          userId,
          action:             AuditAction.ADMIN_SESSION_REVOKED,
          performedByAdminId: adminId,
          metadata:           { sessionId, revokedAll: false },
        },
      }),
    ]);
  } else {
    // Revoke all active sessions for the user
    const { count } = await db.userSession.updateMany({
      where: { userId, revokedAt: null },
      data:  { revokedAt: now, revokedById: adminId },
    });

    await db.auditLog.create({
      data: {
        userId,
        action:             AuditAction.ADMIN_SESSION_REVOKED,
        performedByAdminId: adminId,
        metadata:           { revokedAll: true, count },
      },
    });
  }

  // Admin revokes by id/userId, not by token — clear the whole cache rather
  // than leaving stale "valid" entries behind for whatever was just revoked.
  clearAllSessions();

  return NextResponse.json({ success: true });
}
