/**
 * GET  /api/workspaces  — list workspaces the user belongs to + all public workspaces
 * POST /api/workspaces  — create a new SHARED workspace (user becomes OWNER)
 *                         Accepts optional `category` (WorkspaceCategory) and
 *                         generates default WorkspaceDashboardSection rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
// WorkspaceCategory imported from workspace-presets so this file compiles
// before `prisma generate` has been re-run with the new schema values.
// The string values are identical to what Prisma generates.
import { requireUser } from "@/lib/session";
import {
  WorkspaceCategory,
  getPresetsForCategory,
} from "@/lib/workspace-presets";
import { withApiHandler, getClientIp } from "@/lib/api";

export const GET = withApiHandler(async () => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  // My workspaces (all types including PERSONAL)
  const myMemberships = await db.workspaceMember.findMany({
    where: { userId, status: "ACTIVE" },
    include: {
      workspace: {
        include: {
          members: {
            where: { status: "ACTIVE" },
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
}, "GET /api/workspaces");

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json();
  const { name, description, isPublic, category } = body as {
    name:         string;
    description?: string;
    isPublic?:    boolean;
    category?:    WorkspaceCategory;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // Validate category if provided
  const resolvedCategory: WorkspaceCategory =
    category && Object.values(WorkspaceCategory).includes(category)
      ? category
      : WorkspaceCategory.OTHER;

  // Build default section rows for this category
  const sectionPresets = getPresetsForCategory(resolvedCategory);

  const workspace = await db.workspace.create({
    data: {
      name:        name.trim(),
      description: description?.trim() || null,
      type:        "SHARED",
      category:    resolvedCategory,
      isPublic:    !!isPublic,
      members: {
        create: { userId: user.id, role: "OWNER" },
      },
      dashboardSections: {
        create: sectionPresets.map((s) => ({
          key:     s.key,
          label:   s.label,
          tab:     s.tab,
          enabled: s.enabled,
          order:   s.order,
          config:  s.config == null ? Prisma.DbNull : s.config as Prisma.InputJsonValue,
        })),
      },
    },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, username: true } } },
      },
      dashboardSections: {
        orderBy: [{ tab: "asc" }, { order: "asc" }],
      },
    },
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      workspaceId: workspace.id,
      action:      "WORKSPACE_CREATE",
      metadata:    { name: workspace.name, isPublic: workspace.isPublic, category: resolvedCategory as string },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(workspace, { status: 201 });
}, "POST /api/workspaces");
