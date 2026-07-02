/**
 * GET /api/spaces/[id]/transactions
 *
 * Transactions visible to this Space — feeds the shared-Space Transactions
 * tab and the Overview "Recent transactions" preview on flow-identified
 * templates (Space Template Redesign narrowing: Household / Family /
 * Business / Debt).
 *
 * Security / privacy:
 *   - Caller must be an ACTIVE member of the space (any role, VIEWER+).
 *   - 403 for non-members (no space existence disclosure).
 *   - Row filtering is done ENTIRELY by lib/data/transactions.ts's
 *     getTransactions, which applies the shared KD-15 predicate
 *     (TRANSACTION_DETAIL_VISIBILITY — FULL shares only; BALANCE_ONLY /
 *     SUMMARY_ONLY can never contribute rows). No query logic is
 *     duplicated here, so the KD-15 tripwire tests keep guarding the only
 *     path. Because the result is therefore structurally partial in a
 *     shared Space, every consumer renders a scope note ("fully shared
 *     accounts only").
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole }           from "@prisma/client";
import { requireSpaceRole }          from "@/lib/session";
import { getTransactions }           from "@/lib/data/transactions";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const transactions = await getTransactions({ spaceId });
  return NextResponse.json({ transactions });
}
