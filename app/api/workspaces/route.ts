/**
 * GET  /api/workspaces  — list workspaces the user belongs to + all public workspaces
 * POST /api/workspaces  — create a new SHARED workspace (user becomes OWNER)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // My workspaces (all types including PERSONAL)
  const myMemberships = await db.workspaceMember.findMany({
    where: { userId },
    include: {
      workspace: {
        include: {
          members: {
            include: { user: { select: { id: true, name: true, username: true } } },
          },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const myWorkspaceIds = myMemberships.map((m) => m.workspaceId);

  // Public SHARED workspaces the user is NOT already a member of
  const publicWorkspaces = await db.workspace.findMany({
    where: {
      isPublic: true,
      type:     "SHARED",
      id:       { notIn: myWorkspaceIds },
    },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Pending invites for this user
  const pendingInvites = await db.workspaceInvite.findMany({
    where: { invitedUserId: userId, status: "PENDING" },
    include: {
      workspace: { select: { id: true, name: true, description: true } },
      invitedBy: { select: { id: true, name: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    mine:    myMemberships.map((m) => ({ ...m.workspace, myRole: m.role })),
    public:  publicWorkspaces,
    invites: pendingInvites,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { name, description, isPublic } = body as {
    name:         string;
    description?: string;
    isPublic?:    boolean;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const workspace = await db.workspace.create({
    data: {
      name:        name.trim(),
      description: description?.trim() || null,
      type:        "SHARED",
      isPublic:    !!isPublic,
      members: {
        create: { userId: session.user.id, role: "OWNER" },
      },
    },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true } } },
      },
    },
  });

  await db.auditLog.create({
    data: {
      userId:      session.user.id,
      workspaceId: workspace.id,
      action:      "WORKSPACE_CREATE",
      metadata:    { name: workspace.name, isPublic: workspace.isPublic },
      ipAddress:   req.headers.get("x-forwarded-for") ?? "unknown",
    },
  });

  return NextResponse.json(workspace, { status: 201 });
}
