/**
 * PATCH /api/spaces/[id]/sections/[sectionId]
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
import { Prisma }                    from "@prisma/client";
import { requireSpaceAction }        from "@/lib/spaces/authorize";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sectionId: string }> }
) {
  const { id: spaceId, sectionId } = await params;

  // Only OWNER or ADMIN may modify sections. requireSpaceAction returns 403
  // for non-member / inactive / role-too-low (the previous "Insufficient
  // permissions" role-denial body normalizes to "Forbidden" — status
  // unchanged, matching every requireSpaceRole-gated route).
  const [, err] = await requireSpaceAction(spaceId, "section:edit");
  if (err) return err;

  // Verify section belongs to this space (resource residual — stays route-local)
  const existing = await db.spaceDashboardSection.findUnique({
    where: { id: sectionId },
    select: { spaceId: true },
  });

  if (!existing || existing.spaceId !== spaceId) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  const body = await req.json() as {
    enabled?: boolean;
    label?:   string;
    order?:   number;
    config?:  Record<string, unknown> | null;
  };

  const updated = await db.spaceDashboardSection.update({
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
