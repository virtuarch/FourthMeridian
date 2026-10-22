/**
 * GET /api/admin/users
 *
 * All users with security-relevant fields, filterable.
 * Query params:
 *   search  – name / email / username substring
 *   role    – USER | SYSTEM_ADMIN
 *   totp    – "true" | "false" — filter by totpEnabled
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { requireSystemAdmin } from "@/lib/session";

/** UI-022 — the most rows one admin list response returns. */
const ADMIN_LIST_MAX = 200;

export async function GET(req: NextRequest) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search")?.trim() || undefined;
  const role   = searchParams.get("role")?.trim() || undefined;
  const totp   = searchParams.get("totp") || undefined;  // "true" | "false" | undefined

  const where: Prisma.UserWhereInput = {};

  if (role) where.role = role as "USER" | "SYSTEM_ADMIN";
  if (totp !== undefined) where.totpEnabled = totp === "true";

  if (search) {
    where.OR = [
      { email:     { contains: search, mode: "insensitive" } },
      { username:  { contains: search, mode: "insensitive" } },
      { name:      { contains: search, mode: "insensitive" } },
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName:  { contains: search, mode: "insensitive" } },
    ];
  }

  // UI-022 — bounded. One extra row is fetched to report `truncated` without a
  // second count query; the client narrows with ?search= (already supported).
  const fetched = await db.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take:    ADMIN_LIST_MAX + 1,
    select: {
      id:               true,
      email:            true,
      username:         true,
      name:             true,
      firstName:        true,
      lastName:         true,
      role:             true,
      totpEnabled:      true,
      forcePasswordReset: true,
      employmentStatus: true,
      useCase:          true,
      createdAt:        true,
      spaces: {
        select: {
          role:   true,
          status: true,
          space: {
            // Canonical per-space account count (A1): ACTIVE SpaceAccountLink
            // rows with a live FinancialAccount (legacy `Space.accounts`
            // undercounted). Reshaped back to `_count.accounts` in the response.
            select: {
              id: true, name: true, type: true,
              _count: {
                select: {
                  accountLinks: {
                    where: { status: "ACTIVE", financialAccount: { deletedAt: null } },
                  },
                },
              },
            },
          },
        },
        where: { status: "ACTIVE" },
      },
      _count: { select: { recoveryCodes: true, sessions: true } },
    },
  });
  const truncated = fetched.length > ADMIN_LIST_MAX;
  const users = truncated ? fetched.slice(0, ADMIN_LIST_MAX) : fetched;

  // Count unused recovery codes per user
  const userIds = users.map((u) => u.id);
  const unusedCounts = await db.recoveryCode.groupBy({
    by:     ["userId"],
    where:  { userId: { in: userIds }, usedAt: null },
    _count: { id: true },
  });
  const unusedMap: Record<string, number> = {};
  for (const r of unusedCounts) unusedMap[r.userId] = r._count.id;

  return NextResponse.json({
    truncated,
    users: users.map((u) => ({
      ...u,
      // Reshape canonical `accountLinks` back onto the stable `_count.accounts`
      // response contract so the admin Users client is unchanged (A1).
      spaces: u.spaces.map((m) => ({
        ...m,
        space: { ...m.space, _count: { accounts: m.space._count.accountLinks } },
      })),
      recoveryCodesRemaining: unusedMap[u.id] ?? 0,
    })),
  });
}
