/**
 * POST /api/platform/growth-revenue/users/[userId]  (OPS-6B Beta Operations)
 *
 * Operator deactivate / reactivate of a user account. REUSES the existing account-
 * deactivation mechanism (`User.deactivatedAt` + `revokeAllUserSessions`) — no new
 * field, no new authority — driven by an operator instead of the account owner.
 * A deactivated account cannot log in (the `lib/auth.ts` deactivation gate) and
 * stops accruing Plaid sync (sync-banks skips deactivated users); reactivation
 * clears the stamp.
 *
 * Body: `{ action: "deactivate" | "reactivate", reason: { code, note? } }`.
 *
 * P1 HUMAN OPERABILITY — a CONSEQUENTIAL action: the reason is REQUIRED
 * (REASON_REQUIRED_ACTIONS, lib/audit.ts) and parsed before anything is read;
 * an invalid or missing reason is a 400 and nothing changes. The state change
 * and its audit row commit in ONE transaction through the operator-action
 * chokepoint, with the customer as the row's subject (`userId`) and the
 * operator as `performedByAdminId`, so the customer's own security history
 * shows "an operator deactivated this account" and the Customer Success panel
 * finds it by subject.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE") — fresh
 * re-auth. GUARDS: cannot target a SYSTEM_ADMIN, cannot target yourself.
 */
import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { db } from "@/lib/db";
import { revokeAllUserSessions } from "@/lib/sessions";
import { AuditAction } from "@/lib/audit-actions";
import { OperatorActionValidationError, parseOperatorReason, recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [auth, err] = await requireFreshPlatformAccess("GROWTH_REVENUE", "WRITE");
  if (err) return err;
  const { userId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: unknown };
  const action = body.action;
  if (action !== "deactivate" && action !== "reactivate") {
    return NextResponse.json({ error: "action must be 'deactivate' or 'reactivate'" }, { status: 400 });
  }
  // The reason is parsed FIRST: a consequential action with no reason never
  // reaches the database.
  let reason;
  try {
    reason = parseOperatorReason(body.reason);
  } catch (e) {
    if (e instanceof OperatorActionValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, deactivatedAt: true } });
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 });
  // Guards: never lock out a SYSTEM_ADMIN or yourself through the ops surface.
  if (target.role === UserRole.SYSTEM_ADMIN) return NextResponse.json({ error: "cannot deactivate a system admin" }, { status: 403 });
  if (target.id === auth.user.id) return NextResponse.json({ error: "cannot deactivate your own account here" }, { status: 403 });

  const actor = operatorActorFrom(auth, "GROWTH_REVENUE");
  const before = { deactivatedAt: target.deactivatedAt?.toISOString() ?? null };

  if (action === "deactivate") {
    if (target.deactivatedAt) return NextResponse.json({ ok: true, deactivatedAt: target.deactivatedAt.toISOString(), alreadyDeactivated: true });
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deactivatedAt: now } });
      await recordOperatorAction(tx, {
        actor,
        action: AuditAction.ACCOUNT_DEACTIVATED,
        target: { kind: "USER", id: userId },
        reason,
        change: { before, after: { deactivatedAt: now.toISOString() } },
        result: "SUCCESS",
        detail: { by: "platform-operator" },
      });
    });
    // Deactivation FIRST, then every session is revoked (lib/auth/session-token-exposure.test.ts
    // pins the order): once the row says deactivated no new session can be minted, so a
    // revocation that follows leaves nothing alive; the reverse order left a window in
    // which a sign-in between the two steps survived. Idempotent.
    const revoked = await revokeAllUserSessions(userId);
    return NextResponse.json({ ok: true, deactivatedAt: now.toISOString(), revokedSessions: revoked });
  }

  // reactivate
  if (!target.deactivatedAt) return NextResponse.json({ ok: true, alreadyActive: true });
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { deactivatedAt: null } });
    await recordOperatorAction(tx, {
      actor,
      action: AuditAction.ACCOUNT_REACTIVATED,
      target: { kind: "USER", id: userId },
      reason,
      change: { before, after: { deactivatedAt: null } },
      result: "SUCCESS",
      detail: { by: "platform-operator" },
    });
  });
  return NextResponse.json({ ok: true, reactivated: true });
}
