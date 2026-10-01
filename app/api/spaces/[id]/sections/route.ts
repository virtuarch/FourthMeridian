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
import { withTenantDb }                   from "@/lib/db/tenant-context";
import { loadSpaceSections }              from "@/lib/space/mount-composition";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // Any ACTIVE member (any role) may read sections.
  const [auth, err] = await requireSpaceAction(spaceId, "section:read");
  if (err) return err;

  // PS-6B — ONE loader definition, shared with the /dashboard mount composition
  // (lib/space/mount-composition.ts). The authorization above is unchanged.
  // RLS slice B — one short read, as the caller. `SpaceDashboardSection` is a
  // §7 table: `spaceId IN fm_visible_space_ids()`, which the ACTIVE-member guard
  // above has already established.
  const sections = await withTenantDb(
    auth.user.id, (tx) => loadSpaceSections(tx, spaceId),
  );
  return NextResponse.json(sections);
}
