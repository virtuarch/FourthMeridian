/**
 * GET /api/spaces/[id]/invites
 * List pending invites for a space. Active OWNER or ADMIN only.
 */

import { NextResponse }          from "next/server";
import { db }                    from "@/lib/db";
import { requireSpaceRole }  from "@/lib/session";
import { SpaceMemberRole }   from "@prisma/client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces ACTIVE status — REMOVED/LEFT admins cannot list invites.
  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.ADMIN);
  if (err) return err;

  const invites = await db.spaceInvite.findMany({
    where:   { spaceId, status: "PENDING" },
    include: {
      invitedUser: { select: { id: true, name: true, username: true } },
      invitedBy:   { select: { id: true, name: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(invites);
}
