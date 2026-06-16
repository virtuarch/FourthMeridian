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

// GET is consumed by two call sites only (Sidebar's workspace switcher and
// AddManualAssetModal's share-target picker) — both read only
// `data.mine[].{id,name,type,myRole}`. It previously also queried public
// workspaces and pending invites and returned full nested member rows, none
// of which either caller used; that's the real "duplicate work" between this
// endpoint and the already-optimized /dashboard/workspaces Server Component,
// which is the one place that DOES need the public/invites/members data.
// Trimmed to exactly what's read, which also drops 2 of the original 3
// sequential (non-parallel) Prisma round trips entirely.
export const GET = withApiHandler(async () => {
  const t0 = Date.now();
  const [user, err] = await requireUser();
  if (err) return err;
  console.log(`[api/workspaces] requireUser: ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const myMemberships = await db.workspaceMember.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    select: {
      role: true,
      workspace: { select: { id: true, name: true, type: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
  console.log(`[api/workspaces] myMemberships: ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);

  return NextResponse.json({
    mine: myMemberships.map((m) => ({ ...m.workspace, myRole: m.role })),
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
