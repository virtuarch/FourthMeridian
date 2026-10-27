/**
 * GET /api/spaces/[id]/liquidity/cash-transit
 *
 * v2.7-P2 — the read behind the Cash ledger's neutral "not yet matched" /
 * "pending at the destination" lines. Presentation only: it returns recent
 * outgoing transfer legs on the Space's cash accounts with the EXISTING transfer
 * authority's verdict projected onto each (lib/balances/cash-transit-read.ts).
 * It computes no balance and changes no total; the client classifies the legs
 * against the same adjusted-balance basis the ledger already holds
 * (lib/balances/cash-transit.ts).
 *
 * Membership-gated exactly like the Liquidity space-data route (ACTIVE member,
 * perspective:read), and run inside ONE short tenant transaction so the
 * viewer's visibility is a database guarantee. Transaction-level facts are read
 * only from accounts the Space sees at a transaction-detail tier.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceAction } from "@/lib/spaces/authorize";
import { withApiHandler } from "@/lib/api";
import { withTenantDb } from "@/lib/db/tenant-context";
import { loadCashTransitLegs } from "@/lib/balances/cash-transit-read";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  const [auth, err] = await requireSpaceAction(spaceId, "perspective:read");
  if (err) return err;

  const legs = await withTenantDb(auth.user.id, (tx) => loadCashTransitLegs(tx, { spaceId, now: new Date() }));
  return NextResponse.json({ legs });
}, "GET /api/spaces/[id]/liquidity/cash-transit");
