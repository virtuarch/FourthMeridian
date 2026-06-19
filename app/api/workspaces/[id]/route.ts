/**
 * GET    /api/workspaces/[id]  — get workspace details (must be a member, or public)
 * PATCH  /api/workspaces/[id]  — update name/description/isPublic/category
 *                                (OWNER/ADMIN only), or archive/unarchive via
 *                                `archivedAt` (OWNER only — see below)
 * DELETE /api/workspaces/[id]  — move workspace to trash (soft-delete, sets
 *                                deletedAt). OWNER only, SHARED only. This no
 *                                longer performs a real delete — see
 *                                app/api/workspaces/[id]/permanent/route.ts
 *                                for the only endpoint that does.
 *
 * Lifecycle: active -> archived (this PATCH) -> trashed (this DELETE) ->
 * restored (app/api/workspaces/[id]/restore/route.ts) or permanently deleted
 * (app/api/workspaces/[id]/permanent/route.ts). Archiving and trashing never
 * touch WorkspaceAccountShare or WorkspaceSnapshot rows — those are only
 * affected by permanent delete.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireWorkspaceRole } from "@/lib/session";
import { WorkspaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const [user, err] = await requireUser();
  if (err) return err;

  const workspace = await db.workspace.findUnique({
    where: { id },
    include: {
      members: {
        where: { status: "ACTIVE" },
        include: { user: { select: { id: true, name: true, username: true, email: true } } },
        orderBy: { joinedAt: "asc" },
      },
    },
  });

  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const membership = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: user.id } } });
  const isActiveMember = membership?.status === "ACTIVE";
  if (!workspace.isPublic && !isActiveMember) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ...workspace, myRole: isActiveMember ? membership!.role : null });
}, "GET /api/workspaces/[id]");

export const PATCH = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  // Base gate: ADMIN+ for ordinary field edits. Archiving/unarchiving is
  // additionally restricted to OWNER below — ADMINs cannot archive a
  // workspace they don't own.
  const [patchAuth, patchErr] = await requireWorkspaceRole(id, WorkspaceMemberRole.ADMIN);
  if (patchErr) return patchErr;
  const { user, membership } = patchAuth;

  const body = await req.json();
  const { name, description, isPublic, category, archivedAt } = body as {
    name?:        string;
    description?: string;
    isPublic?:    boolean;
    category?:    string;
    archivedAt?:  string | null; // ISO string to archive, null to unarchive
  };

  const existing = await db.workspace.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── Archive / unarchive ────────────────────────────────────────────────
  if (archivedAt !== undefined) {
    if (membership.role !== WorkspaceMemberRole.OWNER) {
      return NextResponse.json(
        { error: "Only the Space owner can archive or unarchive this Space" },
        { status: 403 }
      );
    }
    if (existing.type === "PERSONAL") {
      return NextResponse.json({ error: "Cannot archive your Personal Space" }, { status: 400 });
    }
    if (existing.deletedAt) {
      return NextResponse.json(
        { error: "Space is in trash — restore it before archiving" },
        { status: 400 }
      );
    }
  }

  const workspace = await db.workspace.update({
    where: { id },
    data: {
      ...(name        !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(isPublic    !== undefined && { isPublic }),
      ...(category    !== undefined && { category: category as never }),
      ...(archivedAt  !== undefined && { archivedAt: archivedAt ? new Date(archivedAt) : null }),
    },
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId: id,
      action:      archivedAt !== undefined
        ? (archivedAt ? AuditAction.WORKSPACE_ARCHIVED : AuditAction.WORKSPACE_UNARCHIVED)
        : AuditAction.WORKSPACE_UPDATE,
      metadata:    { name: workspace.name, isPublic: workspace.isPublic, category },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(workspace);
}, "PATCH /api/workspaces/[id]");

export const DELETE = withApiHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  // requireWorkspaceRole enforces both ACTIVE status and OWNER role —
  // a LEFT or REMOVED owner cannot delete.
  const [auth, err] = await requireWorkspaceRole(id, WorkspaceMemberRole.OWNER);
  if (err) return err;
  const { user } = auth;

  const workspace = await db.workspace.findUnique({ where: { id } });
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (workspace.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your Personal Space" }, { status: 400 });
  }
  if (workspace.deletedAt) {
    return NextResponse.json({ error: "Space is already in trash" }, { status: 400 });
  }

  // Soft-delete only: move to trash. Does NOT cascade-delete members,
  // shares, snapshots, goals, or anything else — those rows are untouched
  // until (and unless) the workspace is permanently deleted from the trash
  // via app/api/workspaces/[id]/permanent/route.ts. Clears archivedAt so a
  // workspace is never simultaneously "archived" and "trashed".
  await db.workspace.update({
    where: { id },
    data:  { deletedAt: new Date(), archivedAt: null },
  });

  await db.auditLog.create({
    data: {
      userId:    user.id,
      workspaceId: id,
      action:    AuditAction.WORKSPACE_TRASHED,
      metadata:  { name: workspace.name },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/workspaces/[id]");
