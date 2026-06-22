/**
 * GET /api/accounts
 *
 * Returns the authenticated user's own FinancialAccounts (non-deleted).
 * Used by the space account-sharing UI to list accounts available to share.
 */

import { NextResponse }      from "next/server";
import { db }                from "@/lib/db";
import { requireUser } from "@/lib/session";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const accounts = await db.financialAccount.findMany({
    where: {
      ownerUserId: user.id,
      deletedAt:   null,
    },
    select: {
      id:          true,
      name:        true,
      type:        true,
      institution: true,
      balance:     true,
      currency:    true,
      lastUpdated: true,
      mask:        true,
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return NextResponse.json(
    accounts.map((a) => ({ ...a, lastUpdated: a.lastUpdated.toISOString() }))
  );
}
