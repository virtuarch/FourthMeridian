/**
 * app/api/connections/[id]/import-history/route.ts
 *
 * A7-6 — investment ImportBatches for a connection's accounts, scoped by stable
 * account ids and gated to the requesting user (the resolver filters by userId,
 * so another user's connection yields an empty history — no existence signal).
 * Safe display fields only; account labels are masked.
 *
 * RLS-C-S8 — ONE TENANT PHASE. Identity from the authenticated session only, and
 * the same value the resolver filters on. Both composed reads run through the one
 * client the phase earned, so the account set that bounds the batch query and the
 * batches themselves cannot be assembled by two different authorities.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { withApiHandler } from "@/lib/api";
import { withTenantDb } from "@/lib/db/tenant-context";
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

  const history = await withTenantDb(user.id, (tx) =>
    getInvestmentImportHistoryForConnection(tx, { connectionId: id, userId: user.id }));
  return NextResponse.json({ history });
}, "GET /api/connections/[id]/import-history");
