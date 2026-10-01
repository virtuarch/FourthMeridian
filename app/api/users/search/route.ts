/**
 * GET /api/users/search?q=...&exclude=spaceId
 *
 * Search users by username, first name, last name, or full name.
 * Used by the space invite flow.
 * Returns up to 8 results, excludes the caller and existing members
 * of the given spaceId (if provided).
 *
 * RLS Slice 2 — MEMBERSHIP ORACLE CLOSED.
 * `exclude` is a caller-supplied Space id that drives a `spaceMember.findMany`
 * roster read. Under `requireUser()` alone, ANY signed-in user could aim it at
 * ANY Space: the roster is never returned, but it is a DIFFERENTIAL oracle —
 * run the same query with and without `&exclude=<victimSpaceId>` and a hit that
 * disappears proves that user is an ACTIVE member of that Space. See
 * docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md §17.1 item 1.
 *
 * The roster read is now gated on `member:invite` (ADMIN+, ACTIVE) in the
 * named Space — the authority this endpoint actually serves, since its ONLY
 * caller is the invite control (components/space/manage/UserSearchInput.tsx,
 * mounted from MembersPanel / MembersInvite / CreateSpaceModal, all of which
 * render it only for an OWNER/ADMIN of that Space). The unfiltered user search
 * itself is unchanged: a caller without invite authority gets 403 rather than a
 * silently-unfiltered list, so the exclusion can never be skipped on the sly.
 */

import { NextRequest, NextResponse } from "next/server";
import { db }                       from "@/lib/db";
import { SpaceMemberStatus }    from "@prisma/client";
import { requireUser }              from "@/lib/session";
import { requireSpaceAction }       from "@/lib/spaces/authorize";

export async function GET(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { searchParams } = new URL(req.url);
  const q           = searchParams.get("q")?.trim() ?? "";
  const spaceId = searchParams.get("exclude") ?? "";

  if (q.length < 1) return NextResponse.json([]);

  // Build list of user IDs to exclude (self + ACTIVE members only).
  // REMOVED and LEFT rows are excluded from this list so that previously-removed
  // users appear in search results and can be re-invited.
  const excludeIds: string[] = [user.id];
  if (spaceId) {
    // The roster read is the oracle — authorize BEFORE it is loaded, never after.
    const [, spaceErr] = await requireSpaceAction(spaceId, "member:invite");
    if (spaceErr) return spaceErr;

    const members = await db.spaceMember.findMany({
      where: { spaceId, status: SpaceMemberStatus.ACTIVE },
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
