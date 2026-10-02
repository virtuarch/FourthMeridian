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
 *
 * ── RLS-T2 — THE SPACE'S OWN ROWS CONVERT; THE BACKFILL PROBE CANNOT ─────────
 * The snapshot series AND the link set it is scoped by now share ONE short tenant
 * phase: both are `"spaceId" IN fm_visible_space_ids()` tables and the VIEWER
 * guard has established that membership, so they are one coherent answer about
 * one Space with no network or model call anywhere inside.
 *
 * ⚠️ THE `PlaidItem` PROBE STAYS ON THE DEPLOYMENT-WIDE CLIENT, DELIBERATELY, AND
 * IT WOULD HAVE DEGRADED SILENTLY. `PlaidItem.fm_app_sel` is
 * `"userId" = current_fm_user_id()` (§9 — PlaidItem is a USER-scoped table), but
 * the question this probe asks is a SPACE-level one: "is a backfill running on any
 * account linked into this Space". In a shared Space the accounts are often a
 * co-member's, so as the tenant the probe would return null for a backfill that
 * IS running and the Wealth chart would render an incomplete series as if it were
 * final — the exact "honest loading state" this signal exists to provide,
 * switched off for precisely the members who cannot see the connection.
 *
 * It is not routed to systemDb either: app/api/spaces/ is not in that client's
 * confinement list (scripts/audit-db-authority.ts) and an ordinary HTTP handler
 * acquiring a deployment-wide authority is the escape this programme exists to
 * close. Two columns, for accounts this Space's OWN tenant-visible links named,
 * on `db`, named here. The honest fix is a `PlaidItem` SELECT arm admitting items
 * whose connections reach a visible Space — a migration, and so an owner
 * decision, not something to be worked around from a route.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole, ShareStatus, PlaidItemStatus } from "@prisma/client";
import { requireSpaceRole }          from "@/lib/session";
import { getRecentSnapshots }        from "@/lib/data/snapshots";
import { db }                        from "@/lib/db";
import { withTenantDb }              from "@/lib/db/tenant-context";

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

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // v2.6-WINDOW-2 — a ROW cap, stated as one. `@@unique([spaceId, date])` means
  // at most one row per day, so 365 rows always cover at least 365 days: a
  // conservative over-cover for every hero window, and the client filters further.
  //
  // RLS-C-S3 — and it runs as the TENANT, with the identity taken from the
  // authenticated requester (requireSpaceRole above). RLS-T2 — the link set the
  // backfill probe is scoped by joins it: both are Space-keyed reads of the same
  // Space, so they are one phase, and the probe that cannot convert is the only
  // thing left outside it.
  const { snapshots, faIds } = await withTenantDb(ctx.user.id, async (tx) => ({
    snapshots: await getRecentSnapshots(tx, { rows: HERO_HISTORY_ROWS }, { spaceId }),
    faIds: (await tx.spaceAccountLink.findMany({
      where:  { spaceId, status: ShareStatus.ACTIVE },
      select: { financialAccountId: true },
    })).map((l) => l.financialAccountId),
  }));

  // Part-6 — per-Space "a backfill is actively running" signal, derived from the
  // SAME PlaidItem.syncIncompleteAt truth the Connections/sync-status subsystem
  // uses (lib/sync/status.ts), not a parallel signal: any non-revoked PlaidItem
  // whose accounts are ACTIVE-linked to this Space still has an unfinished sync.
  // Lets the Wealth chart show an honest "creating your history…" state while
  // snapshots are mid-backfill instead of rendering an incomplete series as if
  // final. Fires on EVERY new connect (the connect sets syncIncompleteAt), not
  // just the first Space ever.
  //
  // ⚠️ DELIBERATELY NOT withTenantDb — see the header. `PlaidItem` is USER-keyed
  // and this is a SPACE-level question, so as the tenant it would answer "no
  // backfill" for a co-member's running one. The account ids it ranges over came
  // from the tenant read above, so the SCOPE is the caller's even though the
  // authority is not.
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
