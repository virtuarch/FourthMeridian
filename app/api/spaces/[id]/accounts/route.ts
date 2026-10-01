/**
 * GET /api/spaces/[id]/accounts
 *
 * Returns active accounts visible to a space, via SpaceAccountLink (D3 Step
 * 4D read cutover — see docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md; replaces the
 * prior db.workspaceAccountShare query). Visibility is status: ACTIVE on the
 * link; `kind` (HOME vs SHARED) is not filtered on — both confer visibility,
 * matching every other D3 Step 4 cutover.
 * Used by the Space Detail modal accounts tab and all space widgets.
 *
 * Security / normalisation:
 *  - Requires authenticated session.
 *  - Caller must be an ACTIVE member of the space (any role).
 *  - Returns 403 for non-members (no space existence disclosure).
 *  - FULL shares pass through with all fields.
 *  - BALANCE_ONLY shares are sanitised and aggregated by owner × type × currency.
 *    Multiple checking accounts from the same person collapse into one row
 *    ("Jane's Checking Accounts", summed balance).  No real name, institution,
 *    or sensitive metadata is ever present on a BALANCE_ONLY row.
 *  - Widgets receive a uniform NormalizedAccount[] array and need no knowledge
 *    of visibilityLevel.
 */

import { NextRequest, NextResponse }  from "next/server";
import { SpaceMemberRole }        from "@prisma/client";
import { requireSpaceRole }       from "@/lib/session";
import { withTenantDb }           from "@/lib/db/tenant-context";
import { loadSpaceAccounts }      from "@/lib/space/mount-composition";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces ACTIVE status — REMOVED/LEFT members cannot
  // read space accounts.
  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // PS-6B — ONE loader definition (links + earliest-tx floor + visibility
  // normalization), shared with the /dashboard mount composition
  // (lib/space/mount-composition.ts). Authorization above is unchanged.
  //
  // RLS slice B — ONE transaction for the whole composition. It is one coherent
  // read (links, their earliest-transaction floor, wallet current values and
  // pending evidence are a single answer about one Space's accounts) and it
  // makes no network or model call, so there is nothing a transaction must not
  // be held across.
  const normalized = await withTenantDb(
    auth.user.id, (tx) => loadSpaceAccounts(tx, spaceId),
  );
  return NextResponse.json(normalized);
}
