/**
 * app/api/connections/[id]/import-history/route.ts
 *
 * A7-6 — investment ImportBatches for a connection's accounts, scoped by stable
 * account ids and gated to the requesting user (the resolver filters by userId,
 * so another user's connection yields an empty history — no existence signal).
 * Safe display fields only; account labels are masked.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { withApiHandler } from "@/lib/api";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
import { getInvestmentImportHistoryForConnection } from "@/lib/investments/investment-import-history";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const [user, err] = await requireFreshUser();
  if (err) return err;
  if (!investmentImportsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const history = await getInvestmentImportHistoryForConnection({ connectionId: id, userId: user.id });
  return NextResponse.json({ history });
}, "GET /api/connections/[id]/import-history");
