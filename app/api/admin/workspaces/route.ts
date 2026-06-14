/**
 * GET /api/admin/workspaces
 *
 * All workspaces with member + account counts, filterable.
 * Query params:
 *   search   – workspace name substring
 *   category – WorkspaceCategory enum value
 *   type     – PERSONAL | SHARED
 *   isPublic – "true" | "false"
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { requireSystemAdmin } from "@/lib/session";

export async function GET(req: NextRequest) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const { searchParams } = req.nextUrl;
  const search   = searchParams.get("search")?.trim() || undefined;
  const category = searchParams.get("category")?.trim() || undefined;
  const type     = searchParams.get("type")?.trim() || undefined;
  const isPublic = searchParams.get("isPublic") || undefined;

  const where: Prisma.WorkspaceWhereInput = {};

  if (search)   where.name     = { contains: search, mode: "insensitive" };
  if (category) where.category = category as Prisma.EnumWorkspaceCategoryFilter;
  if (type)     where.type     = type as "PERSONAL" | "SHARED";
  if (isPublic !== undefined) where.isPublic = isPublic === "true";

  const workspaces = await db.workspace.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id:          true,
      name:        true,
      description: true,
      type:        true,
      category:    true,
      isPublic:    true,
      createdAt:   true,
      members: {
        where:  { status: "ACTIVE" },
        select: {
          role: true,
          user: { select: { id: true, email: true, username: true, name: true, firstName: true } },
        },
      },
      accounts: {
        select: { type: true },
      },
      _count: {
        select: { accounts: true, members: true },
      },
    },
  });

  return NextResponse.json({ workspaces });
}
