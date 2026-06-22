/**
 * GET /api/admin/overview
 *
 * Returns a full snapshot of the system for the admin panel.
 * SYSTEM_ADMIN role required — rejects all other sessions.
 *
 * Response shape:
 * {
 *   stats: { totalUsers, totalSpaces, totalAccounts, totalAuditLogs }
 *   users: Array<{ id, email, username, name, role, createdAt, spaces: [{ id, name, role }] }>
 *   spaces: Array<{ id, name, type, createdAt, members: [{ userId, email, username, name, role }], accountCount }>
 *   recentAudit: Array<{ id, action, userId, userEmail, spaceId, createdAt, metadata }>
 * }
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/session";

export async function GET() {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const [users, spaces, totalAccounts, totalAuditLogs, recentAudit] = await Promise.all([
    // All users with their space memberships
    db.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id:               true,
        email:            true,
        username:         true,
        name:             true,
        firstName:        true,
        lastName:         true,
        role:             true,
        employmentStatus: true,
        useCase:          true,
        createdAt:        true,
        spaces: {
          select: {
            role: true,
            space: {
              select: { id: true, name: true, type: true },
            },
          },
        },
      },
    }),

    // All spaces with members + account count
    db.space.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id:        true,
        name:      true,
        type:      true,
        createdAt: true,
        members: {
          select: {
            role: true,
            user: {
              select: { id: true, email: true, username: true, name: true, role: true },
            },
          },
        },
        _count: {
          select: { accounts: true },
        },
      },
    }),

    // Totals
    db.account.count(),
    db.auditLog.count(),

    // 100 most recent audit log entries
    db.auditLog.findMany({
      take:    100,
      orderBy: { createdAt: "desc" },
      select: {
        id:          true,
        action:      true,
        userId:      true,
        spaceId: true,
        metadata:    true,
        createdAt:   true,
        user: {
          select: { email: true, username: true, name: true },
        },
      },
    }),
  ]);

  return NextResponse.json({
    stats: {
      totalUsers:      users.length,
      totalSpaces: spaces.length,
      totalAccounts,
      totalAuditLogs,
    },
    users: users.map((u) => ({
      id:               u.id,
      email:            u.email,
      username:         u.username,
      name:             u.name,
      firstName:        u.firstName,
      lastName:         u.lastName,
      role:             u.role,
      employmentStatus: u.employmentStatus,
      useCase:          u.useCase,
      createdAt:        u.createdAt,
      spaces:       u.spaces.map((m) => ({
        id:   m.space.id,
        name: m.space.name,
        type: m.space.type,
        role: m.role,
      })),
    })),
    spaces: spaces.map((w) => ({
      id:           w.id,
      name:         w.name,
      type:         w.type,
      createdAt:    w.createdAt,
      accountCount: w._count.accounts,
      members:      w.members.map((m) => ({
        userId:   m.user.id,
        email:    m.user.email,
        username: m.user.username,
        name:     m.user.name,
        role:     m.user.role,
        wsRole:   m.role,
      })),
    })),
    recentAudit: recentAudit.map((log) => ({
      id:          log.id,
      action:      log.action,
      userId:      log.userId,
      userEmail:   log.user?.email ?? null,
      username:    log.user?.username ?? null,
      spaceId: log.spaceId,
      metadata:    log.metadata,
      createdAt:   log.createdAt,
    })),
  });
}
