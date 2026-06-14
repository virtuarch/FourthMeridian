/**
 * GET    /api/user/sessions  — list current user's sessions (active + recently revoked)
 * DELETE /api/user/sessions  — revoke all sessions except the current one
 *
 * The current session is identified by the sessionToken stored in the JWT.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { parseUserAgent } from "@/lib/ua-parser";
import { requireUser } from "@/lib/session";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const userId       = user.id;
  const currentToken = user.sessionToken ?? null;

  const sessions = await db.userSession.findMany({
    where:   { userId },
    orderBy: { createdAt: "desc" },
    take:    20,
  });

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      ...s,
      isCurrent: s.sessionToken === currentToken,
      parsed:    parseUserAgent(s.userAgent ?? ""),
    })),
  });
}

export async function DELETE() {
  const [user, err] = await requireUser();
  if (err) return err;

  const userId       = user.id;
  const currentToken = user.sessionToken ?? null;

  // Revoke all except the current session
  const { count } = await db.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(currentToken ? { sessionToken: { not: currentToken } } : {}),
    },
    data: { revokedAt: new Date() },
  });

  await db.auditLog.create({
    data: {
      userId,
      action:   AuditAction.SESSION_REVOKED,
      metadata: { revokedAll: true, exceptCurrent: true, count },
    },
  });

  return NextResponse.json({ success: true, count });
}
