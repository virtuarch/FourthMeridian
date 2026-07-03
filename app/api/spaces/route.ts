/**
 * GET  /api/spaces  — list spaces the user belongs to + all public spaces
 * POST /api/spaces  — create a new SHARED space (user becomes OWNER)
 *                         Accepts optional `category` (SpaceCategory) and
 *                         generates default SpaceDashboardSection rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
// SpaceCategory imported from space-presets so this file compiles
// before `prisma generate` has been re-run with the new schema values.
// The string values are identical to what Prisma generates.
import { requireUser } from "@/lib/session";
import {
  SpaceCategory,
  getPresetsForCategory,
} from "@/lib/space-presets";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

// GET is consumed by two call sites only (Sidebar's space switcher and
// AddManualAssetModal's share-target picker) — both read only
// `data.mine[].{id,name,type,myRole}`. It previously also queried public
// spaces and pending invites and returned full nested member rows, none
// of which either caller used; that's the real "duplicate work" between this
// endpoint and the already-optimized /dashboard/spaces Server Component,
// which is the one place that DOES need the public/invites/members data.
// Trimmed to exactly what's read, which also drops 2 of the original 3
// sequential (non-parallel) Prisma round trips entirely.
export const GET = withApiHandler(async () => {
  const t0 = Date.now();
  const [user, err] = await requireUser();
  if (err) return err;
  console.log(`[api/spaces] requireUser: ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const myMemberships = await db.spaceMember.findMany({
    // Exclude archived/trashed spaces from the default switcher list —
    // they're only reachable via the Archive/Bin page from here on.
    where: { userId: user.id, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
    select: {
      role: true,
      space: { select: { id: true, name: true, type: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
  console.log(`[api/spaces] myMemberships: ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);

  return NextResponse.json({
    mine: myMemberships.map((m) => ({ ...m.space, myRole: m.role })),
  });
}, "GET /api/spaces");

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json();
  const { name, description, isPublic, category } = body as {
    name:         string;
    description?: string;
    isPublic?:    boolean;
    category?:    SpaceCategory;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // Validate category if provided
  const resolvedCategory: SpaceCategory =
    category && Object.values(SpaceCategory).includes(category)
      ? category
      : SpaceCategory.OTHER;

  // Build default section rows for this category
  const sectionPresets = getPresetsForCategory(resolvedCategory);

  // Space creation, membership, dashboard sections, and the Space's AiAgent
  // must all succeed together. Every Space has exactly one AiAgent (schema
  // enforces @@unique on spaceId); creating it here — in the same transaction
  // as the Space — mirrors the register route and prevents the "No AiAgent
  // found" gap that buildContext() would otherwise hit on the Daily Brief.
  const space = await db.$transaction(async (tx) => {
    const created = await tx.space.create({
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

    await tx.aiAgent.create({
      data: {
        spaceId:    created.id,
        name:       `${created.name} Agent`,
        agentScope: [],   // empty → full template manifest is used
      },
    });

    return created;
  });

  await db.auditLog.create({
    data: {
      userId:      user.id,
      spaceId: space.id,
      action:      AuditAction.SPACE_CREATE,
      metadata:    { name: space.name, isPublic: space.isPublic, category: resolvedCategory as string },
      ipAddress:   getClientIp(req),
    },
  });

  return NextResponse.json(space, { status: 201 });
}, "POST /api/spaces");
