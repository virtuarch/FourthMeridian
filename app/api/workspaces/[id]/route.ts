/**
 * GET    /api/workspaces/[id]  — get workspace details (must be a member, or public)
 * PATCH  /api/workspaces/[id]  — update name/description/isPublic (OWNER/ADMIN only)
 * DELETE /api/workspaces/[id]  — delete workspace (OWNER only, SHARED only)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireWorkspaceRole } from "@/lib/session";
import { WorkspaceMemberRole } from "@prisma/client";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";

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
  const [patchAuth, patchErr] = await requireWorkspaceRole(id, WorkspaceMemberRole.ADMIN);
  if (patchErr) return patchErr;
  const { user } = patchAuth;

  const body = await req.json();
  const { name, description, isPublic, category } = body as {
    name?:        string;
    description?: string;
    isPublic?:    boolean;
    category?:    string;
  };

  const workspace = await db.workspace.update({
    where: { id },
    data: {
      ...(name        !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(isPublic    !== undefined && { isPublic }),
      ...(category    !== undefined && { category: category as never }),
    },
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId: id,
      action:      "WORKSPACE_UPDATE",
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
    return NextResponse.json({ error: "Cannot delete your personal workspace" }, { status: 400 });
  }

  await db.workspace.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      userId:    user.id,
      action:    "WORKSPACE_DELETE",
      metadata:  { name: workspace.name },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true });
}, "DELETE /api/workspaces/[id]");
