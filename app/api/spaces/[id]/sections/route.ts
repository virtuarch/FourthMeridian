/**
 * GET /api/spaces/[id]/sections
 *
 * Returns the ordered SpaceDashboardSection rows for a space.
 * Grouped by tab in the response for convenient client consumption.
 *
 * Security:
 *  - Requires authenticated session.
 *  - User must be an ACTIVE member of the space (any role).
 */

import { NextRequest, NextResponse }      from "next/server";
import { db }                             from "@/lib/db";
import { requireSpaceAction }             from "@/lib/spaces/authorize";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // Any ACTIVE member (any role) may read sections.
  const [, err] = await requireSpaceAction(spaceId, "section:read");
  if (err) return err;

  const sections = await db.spaceDashboardSection.findMany({
    where: { spaceId },
    orderBy: [{ tab: "asc" }, { order: "asc" }],
  });

  return NextResponse.json(sections);
}
