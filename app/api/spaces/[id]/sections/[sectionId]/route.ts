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
import { withTenantDb }              from "@/lib/db/tenant-context";
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
  const [auth, err] = await requireSpaceAction(spaceId, "section:edit");
  if (err) return err;
  const userId = auth.user.id;

  // Verify section belongs to this space (resource residual — stays route-local).
  //
  // RLS slice B — a bare-id fetch followed by a tenancy check. As the caller,
  // `SpaceDashboardSection.fm_app_sel` (`spaceId IN fm_visible_space_ids()`)
  // means a section in a Space the caller does not belong to simply does not
  // come back, so the row no longer leaves the database before the check.
  // The check stays: it is also the only thing distinguishing another Space the
  // caller DOES belong to from this one, which no policy can know.
  const existing = await withTenantDb(userId, (tx) => tx.spaceDashboardSection.findUnique({
    where: { id: sectionId },
    select: { spaceId: true },
  }));

  if (!existing || existing.spaceId !== spaceId) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  const body = await req.json() as {
    enabled?: boolean;
    label?:   string;
    order?:   number;
    config?:  Record<string, unknown> | null;
  };

  const updated = await withTenantDb(userId, (tx) => tx.spaceDashboardSection.update({
    where: { id: sectionId },
    data: {
      ...(body.enabled  !== undefined && { enabled: body.enabled }),
      ...(body.label    !== undefined && { label:   body.label.trim() }),
      ...(body.order    !== undefined && { order:   body.order }),
      ...(body.config   !== undefined && { config:  body.config === null ? Prisma.DbNull : body.config as Prisma.InputJsonValue }),
    },
  }));

  return NextResponse.json(updated);
}
