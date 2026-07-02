/**
 * GET /api/spaces/[id]/snapshots
 *
 * Recent SpaceSnapshot history for this Space — feeds the SpaceTrendHero
 * (Space Template Redesign: headline + delta + historical trend on
 * chartable Space types). Read-only; reuses lib/data/snapshots.ts's
 * getRecentSnapshots (the exact query the Personal dashboard's charts
 * already use), parameterized by spaceId.
 *
 * Security:
 *   - Caller must be an ACTIVE member of the space (any role, VIEWER+).
 *   - 403 for non-members (no space existence disclosure).
 *   - Snapshot aggregates are Space-level by construction (written by
 *     lib/snapshots/regenerate.ts from the Space's linked accounts).
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole }           from "@prisma/client";
import { requireSpaceRole }          from "@/lib/session";
import { getRecentSnapshots }        from "@/lib/data/snapshots";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // 365 rows ≈ a year of daily snapshots — enough for every hero window;
  // the client filters further.
  const snapshots = await getRecentSnapshots(365, { spaceId });
  return NextResponse.json({ snapshots });
}
