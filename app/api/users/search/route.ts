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
import { limitByUser }              from "@/lib/rate-limit";

/**
 * SEC-005 — the directory is not a one-character oracle. A query is served
 * only when it is an EXACT `@username` or carries at least MIN_SEARCH_CHARS
 * characters; shorter substrings return an empty list. Pure, so the floor is
 * provable without a request.
 */
export const MIN_SEARCH_CHARS = 3;
export type SearchTerm =
  | { kind: "exact-username"; username: string }
  | { kind: "substring"; term: string }
  | { kind: "too-short" };

export function parseSearchTerm(raw: string): SearchTerm {
  const q = raw.trim();
  if (q.startsWith("@")) {
    const username = q.slice(1).trim().toLowerCase();
    return username.length >= 1 ? { kind: "exact-username", username } : { kind: "too-short" };
  }
  if (q.length < MIN_SEARCH_CHARS) return { kind: "too-short" };
  return { kind: "substring", term: q.toLowerCase() };
}

export async function GET(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  // SEC-005 — a per-user ceiling: 26 single-letter probes used to walk the
  // whole directory unthrottled. 60/h is far above an invite flow's typing
  // rate and far below an enumeration's.
  const limited = await limitByUser(user.id, "users-search", { limit: 60, windowSec: 3600 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const parsed  = parseSearchTerm(searchParams.get("q") ?? "");
  const spaceId = searchParams.get("exclude") ?? "";

  if (parsed.kind === "too-short") return NextResponse.json([]);

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

  // SEC-005 — `@handle` is an EXACT username match (the invite flow's precise
  // form); anything else is a ≥3-character substring over the display fields.
  const match = parsed.kind === "exact-username"
    ? { username: { equals: parsed.username, mode: "insensitive" as const } }
    : {
        OR: [
          { username:  { contains: parsed.term, mode: "insensitive" as const } },
          { name:      { contains: parsed.term, mode: "insensitive" as const } },
          { firstName: { contains: parsed.term, mode: "insensitive" as const } },
          { lastName:  { contains: parsed.term, mode: "insensitive" as const } },
        ],
      };

  const users = await db.user.findMany({
    where: {
      id: { notIn: excludeIds },
      ...match,
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
