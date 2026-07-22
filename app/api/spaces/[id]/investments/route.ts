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
import { getInvestmentAccountsView } from "@/lib/data/investment-accounts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const accounts = await getInvestmentAccountsView({ spaceId, userId: ctx.user.id });
  return NextResponse.json({ accounts });
}
