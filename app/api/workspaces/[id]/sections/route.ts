/**
 * GET /api/workspaces/[id]/sections
 *
 * Returns the ordered WorkspaceDashboardSection rows for a workspace.
 * Grouped by tab in the response for convenient client consumption.
 *
 * Security:
 *  - Requires authenticated session.
 *  - User must be an ACTIVE member of the workspace (any role).
 */

import { NextRequest, NextResponse }      from "next/server";
import { db }                             from "@/lib/db";
import { WorkspaceMemberStatus }          from "@prisma/client";
import { requireUser } from "@/lib/session";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: workspaceId } = await params;

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true, status: true },
  });

  if (!membership || membership.status !== WorkspaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sections = await db.workspaceDashboardSection.findMany({
    where: { workspaceId },
    orderBy: [{ tab: "asc" }, { order: "asc" }],
  });

  return NextResponse.json(sections);
}
