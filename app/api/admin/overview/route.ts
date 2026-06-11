/**
 * GET /api/admin/overview
 *
 * Returns a full snapshot of the system for the admin panel.
 * SYSTEM_ADMIN role required — rejects all other sessions.
 *
 * Response shape:
 * {
 *   stats: { totalUsers, totalWorkspaces, totalAccounts, totalAuditLogs }
 *   users: Array<{ id, email, username, name, role, createdAt, workspaces: [{ id, name, role }] }>
 *   workspaces: Array<{ id, name, type, createdAt, members: [{ userId, email, username, name, role }], accountCount }>
 *   recentAudit: Array<{ id, action, userId, userEmail, workspaceId, createdAt, metadata }>
 * }
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== "SYSTEM_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [users, workspaces, totalAccounts, totalAuditLogs, recentAudit] = await Promise.all([
    // All users with their workspace memberships
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
        workspaces: {
          select: {
            role: true,
            workspace: {
              select: { id: true, name: true, type: true },
            },
          },
        },
      },
    }),

    // All workspaces with members + account count
    db.workspace.findMany({
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
        workspaceId: true,
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
      totalWorkspaces: workspaces.length,
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
      workspaces:       u.workspaces.map((m) => ({
        id:   m.workspace.id,
        name: m.workspace.name,
        type: m.workspace.type,
        role: m.role,
      })),
    })),
    workspaces: workspaces.map((w) => ({
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
      workspaceId: log.workspaceId,
      metadata:    log.metadata,
      createdAt:   log.createdAt,
    })),
  });
}
