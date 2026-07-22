/**
 * GET /api/admin/spaces
 *
 * All spaces with member + account counts, filterable.
 * Query params:
 *   search   – space name substring
 *   category – SpaceCategory enum value
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

  const where: Prisma.SpaceWhereInput = {};

  if (search)   where.name     = { contains: search, mode: "insensitive" };
  if (category) where.category = category as Prisma.EnumSpaceCategoryFilter;
  if (type)     where.type     = type as "PERSONAL" | "SHARED";
  if (isPublic !== undefined) where.isPublic = isPublic === "true";

  const spacesRaw = await db.space.findMany({
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
      // Canonical account read: ACTIVE SpaceAccountLink rows with a live
      // FinancialAccount, surfacing each account's type.
      accountLinks: {
        where:  { status: "ACTIVE", financialAccount: { deletedAt: null } },
        select: { financialAccount: { select: { type: true } } },
      },
      _count: {
        select: {
          accountLinks: {
            where: { status: "ACTIVE", financialAccount: { deletedAt: null } },
          },
          members: true,
        },
      },
    },
  });

  // Reshape the canonical `accountLinks` back onto the stable admin response
  // contract (`accounts: [{ type }]`, `_count: { accounts, members }`) so the
  // admin Spaces client stays unchanged.
  const spaces = spacesRaw.map(({ accountLinks, _count, ...rest }) => ({
    ...rest,
    accounts: accountLinks.map((l) => ({ type: l.financialAccount.type })),
    _count:   { accounts: _count.accountLinks, members: _count.members },
  }));

  return NextResponse.json({ spaces });
}
