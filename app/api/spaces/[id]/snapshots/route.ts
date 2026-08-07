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
import { SpaceMemberRole, ShareStatus, PlaidItemStatus } from "@prisma/client";
import { requireSpaceRole }          from "@/lib/session";
import { getRecentSnapshots }        from "@/lib/data/snapshots";
import { db }                        from "@/lib/db";

/**
 * How many trailing SpaceSnapshot ROWS the hero reads.
 *
 * v2.6-WINDOW-2 — a bare `365` sat here with a comment calling it "≈ a year".
 * It was always a row cap; naming it says so at the call site instead of in a
 * comment a reader has to find.
 */
const HERO_HISTORY_ROWS = 365;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // v2.6-WINDOW-2 — a ROW cap, stated as one. `@@unique([spaceId, date])` means
  // at most one row per day, so 365 rows always cover at least 365 days: a
  // conservative over-cover for every hero window, and the client filters further.
  const snapshots = await getRecentSnapshots({ rows: HERO_HISTORY_ROWS }, { spaceId });

  // Part-6 — per-Space "a backfill is actively running" signal, derived from the
  // SAME PlaidItem.syncIncompleteAt truth the Connections/sync-status subsystem
  // uses (lib/sync/status.ts), not a parallel signal: any non-revoked PlaidItem
  // whose accounts are ACTIVE-linked to this Space still has an unfinished sync.
  // Lets the Wealth chart show an honest "creating your history…" state while
  // snapshots are mid-backfill instead of rendering an incomplete series as if
  // final. Fires on EVERY new connect (the connect sets syncIncompleteAt), not
  // just the first Space ever.
  const links = await db.spaceAccountLink.findMany({
    where:  { spaceId, status: ShareStatus.ACTIVE },
    select: { financialAccountId: true },
  });
  const faIds = links.map((l) => l.financialAccountId);
  let backfillInProgress = false;
  if (faIds.length > 0) {
    const busy = await db.plaidItem.findFirst({
      where: {
        syncIncompleteAt: { not: null },
        status:           { not: PlaidItemStatus.REVOKED },
        connections:      { some: { financialAccountId: { in: faIds }, deletedAt: null } },
      },
      select: { id: true },
    });
    backfillInProgress = busy !== null;
  }

  return NextResponse.json({ snapshots, backfillInProgress });
}
