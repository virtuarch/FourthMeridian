/**
 * GET /api/admin/security/users
 *
 * User list for the Security page. Returns security-relevant fields only.
 * Query params:
 *   search – name / email / username substring
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { requireSystemAdmin } from "@/lib/session";

export async function GET(req: NextRequest) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search")?.trim() || undefined;

  const where: Prisma.UserWhereInput = {};
  if (search) {
    where.OR = [
      { email:     { contains: search, mode: "insensitive" } },
      { username:  { contains: search, mode: "insensitive" } },
      { name:      { contains: search, mode: "insensitive" } },
      { firstName: { contains: search, mode: "insensitive" } },
    ];
  }

  const users = await db.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id:                 true,
      email:              true,
      username:           true,
      name:               true,
      firstName:          true,
      lastName:           true,
      role:               true,
      totpEnabled:        true,
      forcePasswordReset: true,
      createdAt:          true,
    },
  });

  const userIds = users.map((u) => u.id);

  const [unusedCodes, activeSessions, lastLogins] = await Promise.all([
    db.recoveryCode.groupBy({
      by:     ["userId"],
      where:  { userId: { in: userIds }, usedAt: null },
      _count: { id: true },
    }),
    db.userSession.groupBy({
      by:     ["userId"],
      where:  { userId: { in: userIds }, revokedAt: null },
      _count: { id: true },
    }),
    db.auditLog.findMany({
      where:   { userId: { in: userIds }, action: "LOGIN" },
      orderBy: { createdAt: "desc" },
      select:  { userId: true, createdAt: true },
    }),
  ]);

  const unusedMap: Record<string, number>   = {};
  const sessionsMap: Record<string, number> = {};
  const lastLoginMap: Record<string, Date>  = {};

  for (const r of unusedCodes)    unusedMap[r.userId]   = r._count.id;
  for (const r of activeSessions) sessionsMap[r.userId] = r._count.id;
  for (const r of lastLogins) {
    if (!lastLoginMap[r.userId!]) lastLoginMap[r.userId!] = r.createdAt;
  }

  return NextResponse.json({
    users: users.map((u) => ({
      ...u,
      recoveryCodesRemaining: unusedMap[u.id]   ?? 0,
      activeSessionCount:     sessionsMap[u.id] ?? 0,
      lastLogin:              lastLoginMap[u.id] ?? null,
    })),
  });
}
