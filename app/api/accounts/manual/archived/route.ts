/**
 * GET /api/accounts/manual/archived
 *
 * Returns all soft-deleted manually-entered asset accounts owned by the
 * current user, along with the spaces they were shared into (REVOKED).
 *
 * Response: { assets: ArchivedAsset[] }
 */

import { NextResponse }              from "next/server";
import { db }                        from "@/lib/db";
import { requireUser }               from "@/lib/session";
import { withApiHandler }            from "@/lib/api";

export interface ArchivedAsset {
  id:            string;
  name:          string;
  balance:       number;
  currency:      string;
  deletedAt:     string;          // ISO string
  spaces: {
    id:   string;
    name: string;
  }[];
}

export const GET = withApiHandler(async () => {
  const [user, err] = await requireUser();
  if (err) return err;
  const userId = user.id;

  const accounts = await db.financialAccount.findMany({
    where: {
      ownerUserId: userId,
      type:        "other",
      syncStatus:  "manual",
      deletedAt:   { not: null },
    },
    select: {
      id:        true,
      name:      true,
      balance:   true,
      currency:  true,
      deletedAt: true,
      // D3 Step 4B read cutover: this used to include workspaceShares
      // (WorkspaceAccountShare). SpaceAccountLink is kept in sync with it by
      // the D3 Step 3 dual-write (lib/accounts/space-account-link.ts), so
      // this read returns the same set of spaces either way. Response shape
      // (ArchivedAsset.spaces: {id, name}[]) is unchanged — see
      // docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md.
      spaceAccountLinks: {
        select: {
          status: true,
          space:  { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { deletedAt: "desc" },
  });

  const assets: ArchivedAsset[] = accounts.map((a) => ({
    id:        a.id,
    name:      a.name,
    balance:   a.balance,
    currency:  a.currency,
    deletedAt: a.deletedAt!.toISOString(),
    spaces: a.spaceAccountLinks.map((l) => ({
      id:   l.space.id,
      name: l.space.name,
    })),
  }));

  return NextResponse.json({ assets });
}, "GET /api/accounts/manual/archived");
