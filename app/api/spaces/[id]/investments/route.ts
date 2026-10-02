/**
 * GET /api/spaces/[id]/investments
 *
 * Read-only per-account current-holdings view for the Investments Perspective
 * workspace (Slice B). Membership-gated (ACTIVE member, any role) exactly like
 * GET /api/spaces/[id]/accounts. Visibility is enforced inside
 * getInvestmentAccountsView (positions require a FULL link; Enable/Refresh
 * affordances are attached only to the viewer's own Plaid connections).
 *
 * No access tokens, cursors, or credentials are ever returned — only display
 * fields + a derived per-account state.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { getInvestmentAccountsView } from "@/lib/data/investment-accounts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // RLS-C-S2 — ONE short transaction on the tenant role for the whole view. The
  // identity is the authenticated requester (requireSpaceRole above), which has
  // already been proved an ACTIVE member of this Space; the policies then decide
  // row by row what that identity may see, so the membership gate and the
  // database agree by construction instead of by review.
  //
  // Nothing in here makes a network or model call, so there is nothing the
  // transaction must not be held across.
  const accounts = await withTenantDb(
    ctx.user.id, (tx) => getInvestmentAccountsView(tx, { spaceId, userId: ctx.user.id }),
  );
  return NextResponse.json({ accounts });
}
