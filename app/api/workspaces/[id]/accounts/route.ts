/**
 * GET /api/workspaces/[id]/accounts
 *
 * Returns active accounts visible to a workspace, via WorkspaceAccountShare.
 * Used by the Workspace Detail modal accounts tab and all workspace widgets.
 *
 * Security / normalisation:
 *  - Requires authenticated session.
 *  - Caller must be an ACTIVE member of the workspace (any role).
 *  - Returns 403 for non-members (no workspace existence disclosure).
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
import { WorkspaceMemberRole }        from "@prisma/client";
import { requireWorkspaceRole }       from "@/lib/session";
import { normalizeSharedAccounts }    from "@/lib/account-privacy";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  // requireWorkspaceRole enforces ACTIVE status — REMOVED/LEFT members cannot
  // read workspace accounts.
  const [, err] = await requireWorkspaceRole(workspaceId, WorkspaceMemberRole.VIEWER);
  if (err) return err;

  const shares = await db.workspaceAccountShare.findMany({
    where: {
      workspaceId,
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
