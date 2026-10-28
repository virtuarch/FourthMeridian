/**
 * GET /api/spaces/[id]/data-health  (Connections pass PR 4 — shared empty states)
 *
 * The Space's per-source health for this viewer — the same read the Daily Brief
 * shows (lib/connections/space-data-health.ts), so a perspective's empty state
 * and the Brief's "Financial data" disclosure cannot disagree. Any ACTIVE member.
 * States, grant-filtered labels, dates, asset symbols and populations only: no account id,
 * balance, provider code or token.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSpaceAction } from "@/lib/spaces/authorize";
import { withApiHandler } from "@/lib/api";
import { withTenantDb } from "@/lib/db/tenant-context";
import { loadSpaceDataHealth } from "@/lib/connections/space-data-health";
import { loadValuationCoverage } from "@/lib/connections/valuation-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiHandler(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id: spaceId } = await params;
  if (!spaceId) return NextResponse.json({ error: "Missing space id" }, { status: 400 });

  const [auth, err] = await requireSpaceAction(spaceId, "perspective:read");
  if (err) return err;
  const viewerUserId = auth.user.id;

  const [health, valuationCoverage] = await withTenantDb(viewerUserId, (tx) => Promise.all([
    loadSpaceDataHealth(tx, { spaceId, viewerUserId, now: new Date() }),
    // Why the Net Worth history starts where it does when PRICES (not balances) bound it.
    loadValuationCoverage(tx, spaceId),
  ]));
  return NextResponse.json({ sources: health.sources, valuationCoverage }, { headers: { "Cache-Control": "no-store" } });
}, "GET /api/spaces/[id]/data-health");
