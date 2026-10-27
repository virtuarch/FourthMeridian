/**
 * GET /api/platform/growth-revenue/users  (OPS-6B Beta Operations · SEC-PLAT-4)
 *
 * Customer-account AGGREGATES for Growth. Consumes existing data only (User +
 * the AuditLog LOGIN ledger + UserSession) — no new telemetry, never financial
 * content.
 *
 * SEC-PLAT-4 (owner ruling P-4, 2026-10-27): Growth is identity-minimized. This
 * route used to return a searchable per-user list (id, email, name, username,
 * role, last login, sessions) and its sibling route deactivated accounts. Both
 * were customer-identity work on a Growth grant. The per-customer view and the
 * deactivate / reactivate action now live in Customer Success
 * (GET /api/platform/customer-success/customers[/:id], POST …/[userId]/access),
 * and this route returns COUNTS ONLY — no id, email, name or username, and no
 * search (a search box is an identity oracle).
 *
 * Population: customer accounts (role USER); SYSTEM_ADMIN accounts are not
 * customers and are not counted.
 *
 * AUTHORIZATION: requirePlatformAccess("GROWTH_REVENUE", "READ").
 */

import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { requirePlatformAccess } from "@/lib/platform/authorize";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";

export const runtime = "nodejs";

export interface GrowthUsersSummary {
  /** Customer accounts (role USER). */
  total: number;
  /** …with a verified email address. */
  emailVerified: number;
  /** …currently deactivated. */
  deactivated: number;
  /** …with an account deletion scheduled. */
  deletionScheduled: number;
  /** …holding at least one session that is not revoked. */
  withLiveSession: number;
  /** …with no recorded sign-in at all (AuditLog LOGIN, which is never pruned). */
  neverSignedIn: number;
  checkedAt: string;
}

export async function GET(): Promise<Response> {
  const [, err] = await requirePlatformAccess("GROWTH_REVENUE", "READ");
  if (err) return err;

  const customer = { role: UserRole.USER };
  const [total, emailVerified, deactivated, deletionScheduled, liveSessionUsers, signedInUsers] = await Promise.all([
    db.user.count({ where: customer }),
    db.user.count({ where: { ...customer, emailVerifiedAt: { not: null } } }),
    db.user.count({ where: { ...customer, deactivatedAt: { not: null } } }),
    db.user.count({ where: { ...customer, deletionScheduledAt: { not: null } } }),
    db.userSession.groupBy({ by: ["userId"], where: { revokedAt: null, user: { is: customer } }, _count: { _all: true } }),
    db.auditLog.groupBy({ by: ["userId"], where: { action: AuditAction.LOGIN, user: { is: customer } }, _count: { _all: true } }),
  ]);

  return NextResponse.json({
    total,
    emailVerified,
    deactivated,
    deletionScheduled,
    withLiveSession: liveSessionUsers.length,
    neverSignedIn: Math.max(0, total - signedInUsers.length),
    checkedAt: new Date().toISOString(),
  } satisfies GrowthUsersSummary);
}
