/**
 * GET /api/spaces/[id]/accounts
 *
 * Returns active accounts visible to a space, via WorkspaceAccountShare.
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
import { db }                         from "@/lib/db";
import { ShareStatus }                from "@prisma/client";
import { SpaceMemberRole }        from "@prisma/client";
import { requireSpaceRole }       from "@/lib/session";
import { normalizeSharedAccounts }    from "@/lib/account-privacy";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces ACTIVE status — REMOVED/LEFT members cannot
  // read space accounts.
  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const shares = await db.workspaceAccountShare.findMany({
    where: {
      // WorkspaceAccountShare keeps its pre-Phase-1 field name (workspaceId)
      // — only the local variable here is named spaceId.
      workspaceId: spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      visibilityLevel: true,
      addedByUserId:   true,
      addedByUser: {
        select: { firstName: true, name: true },
      },
      financialAccount: {
        select: {
          id:             true,
          name:           true,
          type:           true,
          institution:    true,
          balance:        true,
          currency:       true,
          lastUpdated:    true,
          creditLimit:    true,
          debtSubtype:    true,
          interestRate:   true,
          minimumPayment: true,
        },
      },
    },
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  // normalizeSharedAccounts handles both visibility tiers:
  //   FULL        → individual records with all fields
  //   BALANCE_ONLY → sanitised, aggregated by owner × type × currency
  return NextResponse.json(normalizeSharedAccounts(shares));
}
