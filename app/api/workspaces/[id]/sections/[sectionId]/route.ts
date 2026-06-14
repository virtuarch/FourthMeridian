/**
 * PATCH /api/workspaces/[id]/sections/[sectionId]
 *
 * Toggle a section's enabled state or update its order/label/config.
 * Only OWNER or ADMIN may modify sections.
 *
 * Accepted body fields (all optional):
 *   enabled  boolean
 *   label    string
 *   order    number
 *   config   object | null
 */

import { NextRequest, NextResponse } from "next/server";
import { db }                        from "@/lib/db";
import { Prisma, WorkspaceMemberStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sectionId: string }> }
) {
  const [user, err] = await requireUser();
  if (err) return err;

  const { id: workspaceId, sectionId } = await params;

  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true, status: true },
  });

  if (!membership || membership.status !== WorkspaceMemberStatus.ACTIVE) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!["OWNER", "ADMIN"].includes(membership.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // Verify section belongs to this workspace
  const existing = await db.workspaceDashboardSection.findUnique({
    where: { id: sectionId },
    select: { workspaceId: true },
  });

  if (!existing || existing.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  const body = await req.json() as {
    enabled?: boolean;
    label?:   string;
    order?:   number;
    config?:  Record<string, unknown> | null;
  };

  const updated = await db.workspaceDashboardSection.update({
    where: { id: sectionId },
    data: {
      ...(body.enabled  !== undefined && { enabled: body.enabled }),
      ...(body.label    !== undefined && { label:   body.label.trim() }),
      ...(body.order    !== undefined && { order:   body.order }),
      ...(body.config   !== undefined && { config:  body.config === null ? Prisma.DbNull : body.config as Prisma.InputJsonValue }),
    },
  });

  return NextResponse.json(updated);
}
