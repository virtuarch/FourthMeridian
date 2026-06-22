/**
 * DELETE /api/spaces/[id]/permanent
 *
 * Permanently and irreversibly deletes a Space. This is the ONLY route
 * in the codebase that calls db.space.delete() — every other "delete"
 * action (the DELETE handler on /api/spaces/[id]) only sets deletedAt
 * and moves the space to trash.
 *
 * Guards:
 *   - OWNER only.
 *   - Only allowed if the space is already trashed (deletedAt IS NOT
 *     NULL) — must go through trash first, exactly like the manual-asset
 *     permanent-delete route at app/api/accounts/manual/[id]/permanent.
 *   - PERSONAL spaces can never reach this state (already blocked from
 *     being trashed in the first place) but are rejected here too as
 *     defense in depth.
 *   - Blocked if the space owns any FinancialAccount rows
 *     (ownerSpaceId = this space). FinancialAccount.ownerSpaceId
 *     is onDelete: SetNull, so without this guard a permanent delete would
 *     silently orphan those accounts (ownerless "ghost" rows that still
 *     hold real balances/transactions but belong to nothing). The caller
 *     must reassign or remove those accounts first.
 *
 * What actually cascades on delete (via existing schema-level onDelete:
 * Cascade — no manual cleanup needed here): SpaceMember, SpaceInvite,
 * AiAgent, AiAdvice, Account (legacy), WorkspaceAccountShare, SpaceGoal
 * (+ its GoalContribution/GoalCheckIn rows), SpaceDashboardSection,
 * SpaceSnapshot. AuditLog.spaceId is onDelete: SetNull, so the audit
 * trail (including the entry this route writes) survives the delete with
 * spaceId cleared.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceRole } from "@/lib/session";
import { SpaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const [auth, err] = await requireSpaceRole(id, SpaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const space = await db.space.findUnique({ where: { id } });
  if (!space) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (space.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your Personal Space" }, { status: 400 });
  }
  if (!space.deletedAt) {
    return NextResponse.json(
      { error: "Move Space to trash before permanently deleting it" },
      { status: 400 }
    );
  }

  const ownedAccountCount = await db.financialAccount.count({
    where: { ownerSpaceId: id },
  });
  if (ownedAccountCount > 0) {
    return NextResponse.json(
      {
        error: `This Space owns ${ownedAccountCount} account${ownedAccountCount === 1 ? "" : "s"}. Reassign or remove ${ownedAccountCount === 1 ? "it" : "them"} before permanently deleting the Space.`,
        ownedAccountCount,
      },
      { status: 400 }
    );
  }

  // Audit log first — AuditLog.spaceId is SetNull on delete, so this
  // entry survives the cascade below with spaceId cleared but the name
  // preserved in metadata.
  await db.auditLog.create({
    data: {
      userId:      user.id,
      spaceId: id,
      action:      AuditAction.SPACE_PERMANENT_DELETE,
      metadata:    { name: space.name, type: space.type, category: space.category },
      ipAddress:   getClientIp(req),
    },
  });

  await db.space.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}, "DELETE /api/spaces/[id]/permanent");
