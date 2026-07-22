/**
 * GET /api/platform/growth-revenue/users  (OPS-6B Beta Operations)
 *
 * Operator user search/list for Beta Operations — the platform-grant equivalent
 * of the SYSTEM_ADMIN user list. Consumes existing data only (User + the AuditLog
 * LOGIN ledger + UserSession) — no new telemetry. Returns per-user operational
 * profile (identity + lifecycle + last-login + active sessions), never financial
 * content. Paginated + substring search on name/email/username.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 */

import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";

export const runtime = "nodejs";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface PlatformUserRow {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  role: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  deactivatedAt: string | null;
  lastLoginAt: string | null;
  activeSessions: number;
}
export interface PlatformUsersResponse {
  total: number;
  users: PlatformUserRow[];
}

export async function GET(req: Request): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;

  const url = new URL(req.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : DEFAULT_LIMIT;

  const where = search
    ? {
        OR: [
          { email: { contains: search, mode: "insensitive" as const } },
          { name: { contains: search, mode: "insensitive" as const } },
          { username: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, email: true, name: true, username: true, role: true, createdAt: true, emailVerifiedAt: true, deactivatedAt: true },
    }),
  ]);

  const userIds = users.map((u) => u.id);
  // Last login + active sessions from EXISTING ledgers (AuditLog LOGIN, UserSession).
  const [lastLogins, activeSessions] = await Promise.all([
    userIds.length
      ? db.auditLog.groupBy({
          by: ["userId"],
          where: { userId: { in: userIds }, action: AuditAction.LOGIN },
          _max: { createdAt: true },
        })
      : Promise.resolve([] as { userId: string | null; _max: { createdAt: Date | null } }[]),
    userIds.length
      ? db.userSession.groupBy({
          by: ["userId"],
          where: { userId: { in: userIds }, revokedAt: null },
          _count: { _all: true },
        })
      : Promise.resolve([] as { userId: string; _count: { _all: number } }[]),
  ]);
  const lastLoginByUser = new Map(lastLogins.map((r) => [r.userId, r._max.createdAt] as const));
  const sessionsByUser = new Map(activeSessions.map((r) => [r.userId, r._count._all] as const));

  return NextResponse.json({
    total,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
      emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
      deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
      lastLoginAt: lastLoginByUser.get(u.id)?.toISOString() ?? null,
      activeSessions: sessionsByUser.get(u.id) ?? 0,
    })),
  } satisfies PlatformUsersResponse);
}
