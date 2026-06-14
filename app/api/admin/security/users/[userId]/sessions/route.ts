/**
 * GET    /api/admin/security/users/[userId]/sessions  — list sessions
 * DELETE /api/admin/security/users/[userId]/sessions  — revoke all sessions
 * DELETE /api/admin/security/users/[userId]/sessions?sessionId=xxx — revoke one
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { parseUserAgent } from "@/lib/ua-parser";
import { requireSystemAdmin } from "@/lib/session";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const { userId } = await params;

  const sessions = await db.userSession.findMany({
    where:   { userId },
    orderBy: { createdAt: "desc" },
    take:    50,
  });

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      ...s,
      parsed: parseUserAgent(s.userAgent ?? ""),
    })),
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const [admin, err] = await requireSystemAdmin();
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

  return NextResponse.json({ success: true });
}
