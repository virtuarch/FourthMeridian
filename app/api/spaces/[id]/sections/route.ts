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
import { requireSpaceAction }             from "@/lib/spaces/authorize";
import { loadSpaceSections }              from "@/lib/space/mount-composition";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // Any ACTIVE member (any role) may read sections.
  const [, err] = await requireSpaceAction(spaceId, "section:read");
  if (err) return err;

  // PS-6B — ONE loader definition, shared with the /dashboard mount composition
  // (lib/space/mount-composition.ts). The authorization above is unchanged.
  const sections = await loadSpaceSections(spaceId);
  return NextResponse.json(sections);
}
