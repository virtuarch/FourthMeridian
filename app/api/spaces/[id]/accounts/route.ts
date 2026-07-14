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

  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
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

  // Per-account earliest-transaction floor — the SAME definition the wealth-
  // history regen uses (lib/snapshots/regenerate-history.ts: min non-deleted
  // Transaction.date per account, NOT createdAt). Consumed by the personal-space
  // RebuildHistoryButton as the "From" min bound so you can't ask to rebuild
  // days before an account has any data. One groupBy over the visible accounts;
  // attached below by FinancialAccount id. FULL rows carry a real
  // FinancialAccount.id (personal/home links are 1:1), so they match; a
  // BALANCE_ONLY aggregate row's synthetic id won't be in the map → null.
  const accountIds = links.map((l) => l.financialAccount.id);
  const floors = accountIds.length
    ? await db.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: accountIds }, deletedAt: null },
        _min:  { date: true },
      })
    : [];
  const floorByAccount = new Map<string, string>();
  for (const f of floors) {
    // Transaction.date is @db.Date (UTC midnight) — slice gives YYYY-MM-DD,
    // matching the regen's truncDateUTC day granularity.
    if (f.financialAccountId && f._min.date) {
      floorByAccount.set(f.financialAccountId, f._min.date.toISOString().slice(0, 10));
    }
  }

  // normalizeSharedAccounts handles both visibility tiers:
  //   FULL        → individual records with all fields
  //   BALANCE_ONLY → sanitised, aggregated by owner × type × currency
  // It is table-agnostic — it only depends on the ShareRow shape
  // (visibilityLevel, addedByUserId, addedByUser, financialAccount), which
  // SpaceAccountLink's select below matches field-for-field.
  const normalized = normalizeSharedAccounts(links).map((a) => ({
    ...a,
    earliestTxDate: floorByAccount.get(a.id) ?? null,
  }));
  return NextResponse.json(normalized);
}
