/**
 * GET /api/spaces/[id]/invites
 * List pending invites for a space. Active OWNER or ADMIN only.
 *
 * ── RLS SLICE B — THE INVITES ARE TENANT-SCOPED; THE NAMES BESIDE THEM ARE NOT ──
 * The SpaceInvite rows are read as the caller: `SpaceInvite.fm_app_sel` admits
 * `spaceId IN fm_visible_space_ids()`, which the ACTIVE ADMIN guard above has
 * already established.
 *
 * ⚠️ THE TWO `User` JOINS CANNOT GO WITH THEM, AND THEY WOULD NOT HAVE FAILED
 * QUIETLY. fm_app's `User` SELECT policy is `id = current_fm_user_id()` — a user
 * sees themselves, and co-member display identity is served by the application
 * (§10 of the RLS migration, lib/spaces/roster-visibility.ts). Both relations
 * here are REQUIRED, and Prisma raises "Inconsistent query result: Field
 * invitedUser is required" rather than returning null, so leaving them in the
 * include would have turned an admin's invite list into a 500. They are now a
 * separate, explicitly-named read of display fields only — id, name, username,
 * the same three the include selected and no more — stitched back into the
 * identical response shape.
 */

import { NextResponse }          from "next/server";
import { db }                    from "@/lib/db";
import { withTenantDb }          from "@/lib/db/tenant-context";
import { requireSpaceRole }  from "@/lib/session";
import { SpaceMemberRole }   from "@prisma/client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces ACTIVE status — REMOVED/LEFT admins cannot list invites.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
  if (err) return err;
  const { user } = auth;

  const invites = await withTenantDb(user.id, (tx) => tx.spaceInvite.findMany({
    where:   { spaceId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  }));

  // ⚠️ DELIBERATELY NOT withTenantDb — see the header. Display identity for
  // people the caller does not "own": the invitee (not a member yet) and the
  // inviter. Three display columns, for ids this Space's own invite rows named.
  const peopleIds = [...new Set(invites.flatMap((i) => [i.invitedUserId, i.invitedById]))];
  const people = peopleIds.length === 0 ? [] : await db.user.findMany({
    where:  { id: { in: peopleIds } },
    select: { id: true, name: true, username: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  return NextResponse.json(invites.map((i) => ({
    ...i,
    invitedUser: byId.get(i.invitedUserId) ?? null,
    invitedBy:   byId.get(i.invitedById)   ?? null,
  })));
}
