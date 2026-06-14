/**
 * GET /api/admin/audit
 *
 * Filterable, paginated audit log for SYSTEM_ADMIN users.
 *
 * Query params:
 *   search       – free text: action, email, username, name
 *   userEmail    – exact or partial email filter
 *   username     – exact or partial username filter
 *   action       – exact action string (e.g. "LOGIN_FAILED")
 *   workspaceId  – filter by workspace id
 *   from         – ISO date string (inclusive start)
 *   to           – ISO date string (inclusive end, padded to end of day)
 *   securityOnly – "true" → only auth/2FA/session/password events
 *   adminOnly    – "true" → only events where performedByAdminId IS NOT NULL
 *   limit        – max rows (default 50, max 200)
 *   offset       – pagination offset
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { requireSystemAdmin } from "@/lib/session";
import { withApiHandler } from "@/lib/api";

// Actions that count as "security events" for the quick-filter
const SECURITY_ACTIONS = [
  "LOGIN", "LOGIN_FAILED", "LOGOUT",
  "PASSWORD_CHANGED", "PASSWORD_RESET",
  "TWO_FACTOR_SETUP_STARTED", "TWO_FACTOR_ENABLED", "TWO_FACTOR_DISABLED", "TWO_FACTOR_RESET",
  "RECOVERY_CODE_USED", "RECOVERY_CODES_GENERATED", "RECOVERY_CODES_REGENERATED",
  "SESSION_REVOKED", "ADMIN_SESSION_REVOKED",
];

export const GET = withApiHandler(async (req: NextRequest) => {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const p = req.nextUrl.searchParams;

  const search       = p.get("search")?.trim()      || undefined;
  const userEmail    = p.get("userEmail")?.trim()    || undefined;
  const username     = p.get("username")?.trim()     || undefined;
  const action       = p.get("action")?.trim()       || undefined;
  const workspaceId  = p.get("workspaceId")?.trim()  || undefined;
  const from         = p.get("from")                 || undefined;
  const to           = p.get("to")                   || undefined;
  const securityOnly = p.get("securityOnly") === "true";
  const adminOnly    = p.get("adminOnly")    === "true";
  const limit        = Math.min(Number(p.get("limit")  || 50), 200);
  const offset       = Math.max(Number(p.get("offset") || 0),  0);

  const where: Prisma.AuditLogWhereInput = {};

  // Exact action match
  if (action) where.action = action;

  // Workspace
  if (workspaceId) where.workspaceId = workspaceId;

  // Date range
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.createdAt.lte = toDate;
    }
  }

  // Security events quick-filter
  if (securityOnly) {
    where.action = { in: SECURITY_ACTIONS };
  }

  // Admin-only events (performed by a sysadmin on behalf of another user)
  if (adminOnly) {
    where.performedByAdminId = { not: null };
  }

  // User-specific filters (dedicated fields)
  const userConditions: Prisma.AuditLogWhereInput[] = [];
  if (userEmail) {
    userConditions.push({ user: { email: { contains: userEmail, mode: "insensitive" } } });
  }
  if (username) {
    userConditions.push({ user: { username: { contains: username, mode: "insensitive" } } });
  }
  if (userConditions.length > 0) {
    // Both email AND username must match if both are provided
    // Each condition narrows the result
    where.AND = userConditions;
  }

  // Free-text search across action, email, username, name
  // Only applies when no specific user filters are set
  if (search && !userEmail && !username) {
    where.OR = [
      { action:   { contains: search, mode: "insensitive" } },
      { user: { email:    { contains: search, mode: "insensitive" } } },
      { user: { username: { contains: search, mode: "insensitive" } } },
      { user: { name:     { contains: search, mode: "insensitive" } } },
      { user: { firstName:{ contains: search, mode: "insensitive" } } },
      { user: { lastName: { contains: search, mode: "insensitive" } } },
    ];
    if (/^c[a-z0-9]{20,}$/i.test(search)) {
      (where.OR as Prisma.AuditLogWhereInput[]).push({ userId: search });
    }
  }

  const [total, logs] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      take:    limit,
      skip:    offset,
      orderBy: { createdAt: "desc" },
      select: {
        id:                 true,
        action:             true,
        userId:             true,
        workspaceId:        true,
        metadata:           true,
        ipAddress:          true,
        userAgent:          true,
        performedByAdminId: true,
        createdAt:          true,
        user: {
          select: { email: true, username: true, name: true, firstName: true, lastName: true, role: true },
        },
        workspace: {
          select: { name: true },
        },
      },
    }),
  ]);

  return NextResponse.json({ total, logs, limit, offset });
}, "GET /api/admin/audit");
