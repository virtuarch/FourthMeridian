/**
 * GET /api/spaces/[id]/investments/point-detail?date=YYYY-MM-DD
 *
 * V26-S3-DETAIL — what one historical Investments chart point is made of.
 *
 * The route resolves NOTHING. It gates membership, validates the date, and
 * returns `getHistoricalPointDetail` verbatim — the canonical authority that
 * composes the same holdings query and the same crypto day valuation snapshot
 * regeneration used, and that refuses outright when the two do not reconcile.
 *
 * A second valuation here — even a "small" one, even a rounding of its own —
 * would be exactly the divergence the reconciliation exists to catch.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole } from "@/lib/session";
import { getHistoricalPointDetail } from "@/lib/investments/historical-point-detail";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;
  void ctx;

  const date = req.nextUrl.searchParams.get("date");
  if (!date || !ISO_DATE.test(date)) {
    return NextResponse.json({ error: "date query param (YYYY-MM-DD) is required" }, { status: 400 });
  }

  const detail = await getHistoricalPointDetail({ spaceId, dateISO: date });

  // The diagnostic is for logs and tests, never for a user. It is stripped here
  // rather than left to a component's discretion.
  const { diagnostic, ...safe } = detail;
  if (diagnostic) {
    console.warn(`[point-detail] ${spaceId} ${date}: ${diagnostic}`);
  }
  return NextResponse.json(safe);
}
