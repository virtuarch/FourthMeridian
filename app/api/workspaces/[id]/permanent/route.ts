/**
 * DELETE /api/workspaces/[id]/permanent
 *
 * Permanently and irreversibly deletes a Workspace. This is the ONLY route
 * in the codebase that calls db.workspace.delete() — every other "delete"
 * action (the DELETE handler on /api/workspaces/[id]) only sets deletedAt
 * and moves the workspace to trash.
 *
 * Guards:
 *   - OWNER only.
 *   - Only allowed if the workspace is already trashed (deletedAt IS NOT
 *     NULL) — must go through trash first, exactly like the manual-asset
 *     permanent-delete route at app/api/accounts/manual/[id]/permanent.
 *   - PERSONAL workspaces can never reach this state (already blocked from
 *     being trashed in the first place) but are rejected here too as
 *     defense in depth.
 *   - Blocked if the workspace owns any FinancialAccount rows
 *     (ownerWorkspaceId = this workspace). FinancialAccount.ownerWorkspaceId
 *     is onDelete: SetNull, so without this guard a permanent delete would
 *     silently orphan those accounts (ownerless "ghost" rows that still
 *     hold real balances/transactions but belong to nothing). The caller
 *     must reassign or remove those accounts first.
 *
 * What actually cascades on delete (via existing schema-level onDelete:
 * Cascade — no manual cleanup needed here): WorkspaceMember, WorkspaceInvite,
 * AiAgent, AiAdvice, Account (legacy), WorkspaceAccountShare, WorkspaceGoal
 * (+ its GoalContribution/GoalCheckIn rows), WorkspaceDashboardSection,
 * WorkspaceSnapshot. AuditLog.workspaceId is onDelete: SetNull, so the audit
 * trail (including the entry this route writes) survives the delete with
 * workspaceId cleared.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRole } from "@/lib/session";
import { WorkspaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const [auth, err] = await requireWorkspaceRole(id, WorkspaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const workspace = await db.workspace.findUnique({ where: { id } });
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (workspace.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your Personal Space" }, { status: 400 });
  }
  if (!workspace.deletedAt) {
    return NextResponse.json(
      { error: "Move Space to trash before permanently deleting it" },
      { status: 400 }
    );
  }

  const ownedAccountCount = await db.financialAccount.count({
    where: { ownerWorkspaceId: id },
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

  // Audit log first — AuditLog.workspaceId is SetNull on delete, so this
  // entry survives the cascade below with workspaceId cleared but the name
  // preserved in metadata.
  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId: id,
      action:      AuditAction.WORKSPACE_PERMANENT_DELETE,
      metadata:    { name: workspace.name, type: workspace.type, category: workspace.category },
      ipAddress:   getClientIp(req),
    },
  });

  await db.workspace.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}, "DELETE /api/workspaces/[id]/permanent");
