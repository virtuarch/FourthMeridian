/**
 * POST /api/workspaces/[id]/restore
 *
 * Restores a trashed Workspace — clears deletedAt. OWNER only.
 *
 * Does NOT recreate WorkspaceMember rows or WorkspaceAccountShare rows,
 * because trashing never removed them in the first place (see the DELETE
 * handler in app/api/workspaces/[id]/route.ts) — they were left untouched
 * the whole time the workspace sat in trash. This route is a pure
 * deletedAt -> null flip, nothing more.
 *
 * Companion to the archive/unarchive toggle on PATCH
 * /api/workspaces/[id] (`archivedAt`), which is a separate lifecycle state.
 * A workspace can only be restored from trash here if it is currently
 * trashed (deletedAt set); restoring from archive uses the PATCH endpoint
 * instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRole } from "@/lib/session";
import { WorkspaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const POST = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const [auth, err] = await requireWorkspaceRole(id, WorkspaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const workspace = await db.workspace.findUnique({ where: { id } });
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!workspace.deletedAt) {
    return NextResponse.json({ error: "Space is not in trash" }, { status: 400 });
  }

  await db.workspace.update({
    where: { id },
    data:  { deletedAt: null },
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId: id,
      action:      AuditAction.WORKSPACE_RESTORED,
      metadata:    { name: workspace.name },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "POST /api/workspaces/[id]/restore");
