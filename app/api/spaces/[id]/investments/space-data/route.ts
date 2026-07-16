/**
 * GET /api/spaces/[id]/investments/space-data?asOf=YYYY-MM-DD[&compareTo=YYYY-MM-DD]
 *
 * SD-4A — the runtime binding that finally activates the canonical Investments
 * workspace contract end-to-end. It serves `InvestmentsSpaceData` (PCS-1D) through
 * the ONE composition loader, so the Investments Workspace reads current + historical
 * + activity + trust from a single canonical envelope instead of the raw A10 route:
 *
 *   current    → getCurrentPositions()  (A10-at-today seam)   — the canonical CURRENT path
 *   historical → getInvestmentsTimeMachine() = A10, verbatim  — as-of / compare / flows
 *   activity   → historical.flows re-surfaced
 *   trust      → buildInvestmentsTrustSummary(historical)
 *
 * `current` and `historical` are NEVER cross-derived (the PCS-1 invariant): the
 * current portfolio comes only from getCurrentPositions; the as-of/compare view comes
 * only from A10. `historical` is requested whenever the caller passes a resolved
 * asOf (the Perspective Shell always does), so the shell trust chip and the period
 * bridge keep exactly today's behavior while the current view moves off A10-at-today.
 *
 * Membership-gated (ACTIVE member, any role) exactly like the sibling /investments
 * and /investments/time-machine routes. Visibility (KD-21a) is enforced INSIDE the
 * loaders (FULL links only); this route resolves no time state and computes nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole } from "@/lib/session";
import { loadInvestmentsSpaceData } from "@/lib/investments/space-data";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: spaceId } = await params;

  const [ctx, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const asOf = req.nextUrl.searchParams.get("asOf");
  const compareToRaw = req.nextUrl.searchParams.get("compareTo");
  if (!asOf || !ISO_DATE.test(asOf)) {
    return NextResponse.json({ error: "asOf query param (YYYY-MM-DD) is required" }, { status: 400 });
  }
  if (compareToRaw != null && !ISO_DATE.test(compareToRaw)) {
    return NextResponse.json({ error: "compareTo must be YYYY-MM-DD" }, { status: 400 });
  }
  if (compareToRaw && compareToRaw >= asOf) {
    return NextResponse.json({ error: "compareTo must be earlier than asOf" }, { status: 400 });
  }

  // Membership above is the gate; per-account visibility is enforced inside the loaders.
  void ctx;
  const data = await loadInvestmentsSpaceData(
    { spaceId },
    { history: { asOf, compareTo: compareToRaw ?? null } },
  );
  return NextResponse.json(data);
}
