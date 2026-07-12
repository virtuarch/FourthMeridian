/**
 * app/api/connections/[id]/import-accounts/route.ts
 *
 * A7-6 — the investment accounts a connection can import into, resolved by STABLE
 * id (AccountConnection.plaidItemDbId), gated to the requesting user. Feeds the
 * ConnectionCard import wizard's target picker. Account identifiers are masked.
 * Cross-user access yields an empty list (the resolver filters by userId).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshUser } from "@/lib/session";
import { withApiHandler } from "@/lib/api";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
import { getImportableAccountsForConnection } from "@/lib/investments/connection-import-accounts";
import { maskAccountLabel } from "@/lib/imports/investments/import-validation";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const [user, err] = await requireFreshUser();
  if (err) return err;
  if (!investmentImportsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const accounts = await getImportableAccountsForConnection({ connectionId: id, userId: user.id });
  return NextResponse.json({
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, label: maskAccountLabel(a.mask, a.name), institution: a.institution })),
  });
}, "GET /api/connections/[id]/import-accounts");
