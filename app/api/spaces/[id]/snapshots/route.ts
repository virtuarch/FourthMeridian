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
