/**
 * GET /api/users/search?q=...&exclude=workspaceId
 *
 * Search users by username, first name, last name, or full name.
 * Used by the workspace invite flow.
 * Returns up to 8 results, excludes the caller and existing members
 * of the given workspaceId (if provided).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q           = searchParams.get("q")?.trim() ?? "";
  const workspaceId = searchParams.get("exclude") ?? "";

  if (q.length < 1) return NextResponse.json([]);

  // Build list of user IDs to exclude (self + existing members)
  const excludeIds: string[] = [session.user.id];
  if (workspaceId) {
    const members = await db.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    excludeIds.push(...members.map((m) => m.userId));
  }

  const term = q.replace(/^@/, "").toLowerCase();

  const users = await db.user.findMany({
    where: {
      id: { notIn: excludeIds },
      OR: [
        { username:  { contains: term, mode: "insensitive" } },
        { name:      { contains: term, mode: "insensitive" } },
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName:  { contains: term, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      username: true,
      firstName: true,
      lastName: true,
    },
    take: 8,
    orderBy: { name: "asc" },
  });

  return NextResponse.json(users);
}
