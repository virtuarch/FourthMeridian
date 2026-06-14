/**
 * GET /api/users/search?q=...&exclude=workspaceId
 *
 * Search users by username, first name, last name, or full name.
 * Used by the workspace invite flow.
 * Returns up to 8 results, excludes the caller and existing members
 * of the given workspaceId (if provided).
 */

import { NextRequest, NextResponse } from "next/server";
import { db }                       from "@/lib/db";
import { WorkspaceMemberStatus }    from "@prisma/client";
import { requireUser }              from "@/lib/session";

export async function GET(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { searchParams } = new URL(req.url);
  const q           = searchParams.get("q")?.trim() ?? "";
  const workspaceId = searchParams.get("exclude") ?? "";

  if (q.length < 1) return NextResponse.json([]);

  // Build list of user IDs to exclude (self + ACTIVE members only).
  // REMOVED and LEFT rows are excluded from this list so that previously-removed
  // users appear in search results and can be re-invited.
  const excludeIds: string[] = [user.id];
  if (workspaceId) {
    const members = await db.workspaceMember.findMany({
      where: { workspaceId, status: WorkspaceMemberStatus.ACTIVE },
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
