/**
 * POST /api/platform/growth-revenue/users/[userId]  (OPS-6B Beta Operations)
 *
 * Operator deactivate / reactivate of a user account. REUSES the existing account-
 * deactivation mechanism (`User.deactivatedAt` + `revokeAllUserSessions`) — no new
 * field, no new authority — driven by an operator instead of the account owner.
 * A deactivated account cannot log in (the `lib/auth.ts` deactivation gate) and
 * stops accruing Plaid sync (sync-banks skips deactivated users); reactivation
 * clears the stamp. Body: `{ action: "deactivate" | "reactivate" }`.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE") — fresh
 * re-auth. GUARDS: cannot target a SYSTEM_ADMIN, cannot target yourself. Every
 * action lands an AuditLog with `performedByAdminId`.
 */

import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { db } from "@/lib/db";
import { revokeAllUserSessions } from "@/lib/sessions";
import { AuditAction } from "@/lib/audit-actions";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;

  const { userId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = body.action;
  if (action !== "deactivate" && action !== "reactivate") {
    return NextResponse.json({ error: "action must be 'deactivate' or 'reactivate'" }, { status: 400 });
  }

  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, deactivatedAt: true } });
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 });

  // Guards: never lock out a SYSTEM_ADMIN or yourself through the ops surface.
  if (target.role === UserRole.SYSTEM_ADMIN) return NextResponse.json({ error: "cannot deactivate a system admin" }, { status: 403 });
  if (target.id === auth.user.id) return NextResponse.json({ error: "cannot deactivate your own account here" }, { status: 403 });

  if (action === "deactivate") {
    if (target.deactivatedAt) return NextResponse.json({ ok: true, deactivatedAt: target.deactivatedAt.toISOString(), alreadyDeactivated: true });
    const now = new Date();
    await db.user.update({ where: { id: userId }, data: { deactivatedAt: now } });
    const revoked = await revokeAllUserSessions(userId);
    await db.auditLog.create({
      data: {
        action: AuditAction.ACCOUNT_DEACTIVATED,
        userId,
        performedByAdminId: auth.user.id,
        metadata: { by: "platform-operator", revokedSessions: revoked },
      },
    });
    return NextResponse.json({ ok: true, deactivatedAt: now.toISOString(), revokedSessions: revoked });
  }

  // reactivate
  if (!target.deactivatedAt) return NextResponse.json({ ok: true, alreadyActive: true });
  await db.user.update({ where: { id: userId }, data: { deactivatedAt: null } });
  await db.auditLog.create({
    data: { action: AuditAction.ACCOUNT_REACTIVATED, userId, performedByAdminId: auth.user.id, metadata: { by: "platform-operator" } },
  });
  return NextResponse.json({ ok: true, reactivated: true });
}
