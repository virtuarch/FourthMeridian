/**
 * GET /api/workspaces/[id]/invites
 * List pending invites for a workspace. Active OWNER or ADMIN only.
 */

import { NextResponse }          from "next/server";
import { db }                    from "@/lib/db";
import { requireWorkspaceRole }  from "@/lib/session";
import { WorkspaceMemberRole }   from "@prisma/client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  // requireWorkspaceRole enforces ACTIVE status — REMOVED/LEFT admins cannot list invites.
  const [, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.ADMIN);
  if (err) return err;

  const invites = await db.workspaceInvite.findMany({
    where:   { workspaceId, status: "PENDING" },
    include: {
      invitedUser: { select: { id: true, name: true, username: true } },
      invitedBy:   { select: { id: true, name: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(invites);
}
