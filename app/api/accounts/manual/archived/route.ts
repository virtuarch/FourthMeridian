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
      workspaceShares: {
        select: {
          status:    true,
          // WorkspaceAccountShare keeps its own pre-Phase-1 relation name (workspace).
          workspace: { select: { id: true, name: true } },
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
    spaces: a.workspaceShares.map((s) => ({
      id:   s.workspace.id,
      name: s.workspace.name,
    })),
  }));

  return NextResponse.json({ assets });
}, "GET /api/accounts/manual/archived");
