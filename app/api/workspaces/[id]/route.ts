/**
 * GET    /api/workspaces/[id]  — get workspace details (must be a member, or public)
 * PATCH  /api/workspaces/[id]  — update name/description/isPublic (OWNER/ADMIN only)
 * DELETE /api/workspaces/[id]  — delete workspace (OWNER only, SHARED only)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

async function getMembership(workspaceId: string, userId: string) {
  return db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await db.workspace.findUnique({
    where: { id },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true, email: true } } },
        orderBy: { joinedAt: "asc" },
      },
    },
  });

  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const membership = await getMembership(id, session.user.id);
  if (!workspace.isPublic && !membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ...workspace, myRole: membership?.role ?? null });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await getMembership(id, session.user.id);
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, description, isPublic } = body as {
    name?:        string;
    description?: string;
    isPublic?:    boolean;
  };

  const workspace = await db.workspace.update({
    where: { id },
    data: {
      ...(name        !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description.trim() || null }),
      ...(isPublic    !== undefined && { isPublic }),
    },
  });

  return NextResponse.json(workspace);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await db.workspace.findUnique({ where: { id } });
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (workspace.type === "PERSONAL") {
    return NextResponse.json({ error: "Cannot delete your personal workspace" }, { status: 400 });
  }

  const membership = await getMembership(id, session.user.id);
  if (membership?.role !== "OWNER") {
    return NextResponse.json({ error: "Only the owner can delete this workspace" }, { status: 403 });
  }

  await db.workspace.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      userId:    session.user.id,
      action:    "WORKSPACE_DELETE",
      metadata:  { name: workspace.name },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    },
  });

  return NextResponse.json({ ok: true });
}
